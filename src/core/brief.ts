/**
 * 任务书（TaskBrief）的读取与 schema 校验。
 * "工程经理派发前须经主 Agent 任务书"——没有合法任务书就拒绝派发。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { TaskBrief } from "./types.ts";

function asStringArray(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== "string")) {
    throw new Error(`任务书字段 ${field} 必须是非空字符串数组`);
  }
  return v as string[];
}

export function parseBrief(raw: unknown): TaskBrief {
  if (typeof raw !== "object" || raw === null) throw new Error("任务书必须是 JSON 对象");
  const r = raw as Record<string, unknown>;
  if (typeof r["title"] !== "string" || r["title"].trim() === "") {
    throw new Error("任务书缺少 title");
  }
  if (typeof r["description"] !== "string" || r["description"].trim() === "") {
    throw new Error("任务书缺少 description");
  }
  const brief: TaskBrief = {
    title: r["title"].trim(),
    description: r["description"],
    scope: asStringArray(r["scope"], "scope"),
    acceptance: asStringArray(r["acceptance"], "acceptance"),
    constraints: Array.isArray(r["constraints"]) ? (r["constraints"] as string[]) : [],
  };
  if (r["highRisk"] === true) brief.highRisk = true;
  if (typeof r["workdir"] === "string") brief.workdir = r["workdir"];
  return brief;
}

export function loadBrief(file: string): { brief: TaskBrief; briefPath: string } {
  const briefPath = path.resolve(file);
  const raw = JSON.parse(readFileSync(briefPath, "utf8"));
  const brief = parseBrief(raw);
  if (brief.workdir && !path.isAbsolute(brief.workdir)) {
    brief.workdir = path.resolve(path.dirname(briefPath), brief.workdir);
  }
  return { brief, briefPath };
}

/**
 * 把任务书压成一段喂给 JEV 的 state 文本。
 * 不截断过长——OpenJev/smaller 后端有 state 上限，这里留 2000 字符预算。
 */
export function briefToState(brief: TaskBrief, maxChars = 2000): string {
  const parts = [
    `任务: ${brief.title}`,
    brief.description,
    `范围: ${brief.scope.join("；")}`,
    `验收标准: ${brief.acceptance.join("；")}`,
  ];
  if (brief.constraints.length > 0) {
    parts.push(`约束: ${brief.constraints.join("；")}`);
  }
  const full = parts.join("\n");
  if (full.length <= maxChars) return full;
  return full.slice(0, maxChars - 1) + "…";
}
