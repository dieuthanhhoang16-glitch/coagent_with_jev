/**
 * 配置加载：jev-office.config.json（可选）→ 环境变量覆盖 → 内置默认值。
 * 约定：
 *   TYPESAFE_BASE_URL / TYPESAFE_API_KEY  与 TypeSafe SDK 同名环境变量兼容
 *   JEV_BASE_URL / JEV_API_KEY / JEV_BACKEND / JEV_MODEL 本项目优先级更高
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { OfficeConfig } from "./types.ts";

export const DEFAULTS: OfficeConfig = {
  jev: {
    backend: "auto",
    baseUrl: "http://127.0.0.1:8080",
    apiKey: "",
    model: "openjev-latest",
    confidenceThreshold: 0.7,
    unsureThreshold: 0.4,
    handBackEpsilon: 0.05,
    timeoutMs: 30_000,
    priceInPer1M: 0.042,
  },
  partitionsFile: "config/partitions.json",
  dbPath: ".jev-office/jev-office.db",
  runsDir: ".jev-office/runs",
  managerName: "azir",
  managers: ["azir", "lyra"],
  advisorName: "sage",
  onUncertain: "escalate",
  maxRedispatches: 1,
};

/** 深合并（仅一层深即可，jev 子对象单独处理） */
function merge(base: OfficeConfig, patch: Partial<OfficeConfig>): OfficeConfig {
  return {
    ...base,
    ...patch,
    jev: { ...base.jev, ...(patch.jev ?? {}) },
  };
}

/**
 * 寻找配置文件的优先级：
 *   1) --config 显式给定
 *   2) ./jev-office.config.json
 *   3) ~/.jev-office/config.json
 *   4) 无文件 → 全默认（可跑 pseudo 演示）
 */
export function loadConfig(explicitPath?: string): {
  config: OfficeConfig;
  configPath: string | null;
  rootDir: string;
} {
  let configPath: string | null = null;
  if (explicitPath) {
    if (!existsSync(explicitPath)) {
      throw new Error(`配置文件不存在: ${explicitPath}`);
    }
    configPath = path.resolve(explicitPath);
  } else if (existsSync(path.resolve("jev-office.config.json"))) {
    configPath = path.resolve("jev-office.config.json");
  } else {
    const homeCfg = path.join(os.homedir(), ".jev-office", "config.json");
    if (existsSync(homeCfg)) configPath = homeCfg;
  }

  let config: OfficeConfig = structuredClone(DEFAULTS);
  let rootDir = process.cwd();
  if (configPath) {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Partial<OfficeConfig>;
    config = merge(config, raw);
    rootDir = path.dirname(configPath);
  }

  // 环境变量覆盖（本项目变量优先于 TypeSafe 兼容变量）
  const baseUrl =
    process.env["JEV_BASE_URL"] ?? process.env["TYPESAFE_BASE_URL"];
  if (baseUrl) config.jev.baseUrl = baseUrl;
  const apiKey = process.env["JEV_API_KEY"] ?? process.env["TYPESAFE_API_KEY"];
  if (apiKey) config.jev.apiKey = apiKey;
  const backend = process.env["JEV_BACKEND"];
  if (backend === "auto" || backend === "http" || backend === "pseudo") {
    config.jev.backend = backend;
  }
  if (process.env["JEV_MODEL"]) config.jev.model = process.env["JEV_MODEL"];

  // 相对路径相对配置根目录解析
  config.partitionsFile = path.resolve(rootDir, config.partitionsFile);
  config.dbPath = path.resolve(rootDir, config.dbPath);
  config.runsDir = path.resolve(rootDir, config.runsDir);

  return { config, configPath, rootDir };
}
