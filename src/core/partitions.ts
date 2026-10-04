/**
 * 模型分区加载与校验。每个分区声明：名称 / 模型 / 擅长工作类型 / 输入输出价格 / 执行器。
 */
import { readFileSync } from "node:fs";
import type { Partition } from "./types.ts";

export function loadPartitions(file: string): Partition[] {
  const raw = JSON.parse(readFileSync(file, "utf8")) as { partitions?: unknown };
  if (!Array.isArray(raw.partitions) || raw.partitions.length === 0) {
    throw new Error(`分区文件 ${file} 中没有 partitions 数组`);
  }
  const seen = new Set<string>();
  const partitions: Partition[] = raw.partitions.map((p: any, i: number) => {
    const where = `partitions[${i}]`;
    for (const key of [
      "name",
      "model",
      "specialties",
      "priceInPer1M",
      "priceOutPer1M",
      "executor",
    ] as const) {
      if (p[key] === undefined) throw new Error(`${where} 缺少字段 ${key}`);
    }
    if (seen.has(p.name)) throw new Error(`分区名重复: ${p.name}`);
    seen.add(p.name);
    if (!Array.isArray(p.executor.command) || p.executor.command.length === 0) {
      throw new Error(`${where}.executor.command 必须是非空 argv 数组`);
    }
    const mode = p.executor.resultMode;
    if (!["claude-json", "codex-jsonl", "file", "stdout"].includes(mode)) {
      throw new Error(`${where}.executor.resultMode 非法: ${mode}`);
    }
    for (const k of ["priceInPer1M", "priceOutPer1M"] as const) {
      if (typeof p[k] !== "number" || p[k] < 0) {
        throw new Error(`${where}.${k} 必须是非负数字`);
      }
    }
    return {
      name: String(p.name),
      model: String(p.model),
      specialties: String(p.specialties),
      priceInPer1M: p.priceInPer1M,
      priceOutPer1M: p.priceOutPer1M,
      executor: {
        command: p.executor.command.map(String),
        resultMode: mode,
        ...(p.executor.timeoutMs !== undefined
          ? { timeoutMs: Number(p.executor.timeoutMs) }
          : {}),
      },
    };
  });
  return partitions;
}

/** 最贵分区的输入/输出价（成本对照用） */
export function mostExpensive(partitions: Partition[]): {
  inPer1M: number;
  outPer1M: number;
  name: string;
} {
  let best = partitions[0]!;
  for (const p of partitions) {
    if (
      p.priceInPer1M + p.priceOutPer1M >
      best.priceInPer1M + best.priceOutPer1M
    ) {
      best = p;
    }
  }
  return { inPer1M: best.priceInPer1M, outPer1M: best.priceOutPer1M, name: best.name };
}
