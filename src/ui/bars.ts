/**
 * JEV 判断面板（M1 文字版，M2 OpenTUI 面板的数据内核）：
 *   - 概率横条图：按概率降序，bar 上带分区"擅长工作"标注
 *   - 把握度实线 vs 把握线虚线
 * 全部纯函数：进参分布，出参字符串数组。测试对着 snapshot 断言。
 */
import { c } from "./ansi.ts";

export interface CandidateBarSpec {
  name: string;
  /** 分区"擅长工作类型"的短标注 */
  specialty: string;
}

const BAR_W = 28;

function bar(p: number): string {
  const filled = Math.round(p * BAR_W);
  return "█".repeat(Math.max(0, Math.min(BAR_W, filled))).padEnd(BAR_W, "░");
}

function shortSpecialty(s: string, maxLen = 22): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= maxLen ? t : t.slice(0, maxLen - 1) + "…";
}

/** JEV 判断面板：概率横条 + 把握度 + 把握线 */
export function renderJudgmentPanel(args: {
  question: string;
  distribution: Record<string, number>;
  specs: Record<string, CandidateBarSpec | undefined>;
  confidence: number;
  threshold: number;
  decisionLabel: string; // 如 "→ 派给 6.1 Sol 区 · 直接执行"
  latencyMs?: number;
  backend?: string;
}): string[] {
  const { distribution, confidence, threshold } = args;
  const entries = Object.entries(distribution).sort((a, b) => b[1] - a[1]);
  const lines: string[] = [];
  lines.push(c.bold("┌─ JEV 判断面板 ───────────────────────────────────"));
  lines.push(`│ ${c.cyan("问:")} ${args.question}${args.backend ? c.gray(`    [${args.backend}]`) : ""}`);
  lines.push("│");
  for (const [name, p] of entries) {
    const spec = args.specs[name];
    const specialty = spec ? c.gray(` ${shortSpecialty(spec.specialty)}`) : "";
    const pct = `${(p * 100).toFixed(1)}%`.padStart(6);
    const paint = p === entries[0]![1] ? c.green : c.gray;
    lines.push(`│ ${name.padEnd(14)} ${paint(bar(p))} ${paint(pct)}${specialty}`);
  }
  lines.push("│");
  // 把握度实线 vs 把握线虚线
  const gw = 30;
  const confPos = Math.round(confidence * gw);
  const threshPos = Math.round(threshold * gw);
  const gauge = Array.from({ length: gw + 1 }, (_, i) => {
    if (i === threshPos) return "┆";
    return i <= confPos ? "━" : "─";
  }).join("");
  const ok = confidence >= threshold;
  lines.push(
    `│ ${c.bold("把握度")} ${(ok ? c.green : c.yellow)(confidence.toFixed(2))}  ${gauge}  ${c.gray(`把握线 ${threshold.toFixed(2)}`)}`,
  );
  if (args.latencyMs !== undefined) {
    lines.push(`│ ${c.gray(`延迟 ${args.latencyMs.toFixed(0)}ms`)}`);
  }
  lines.push(`│ ${c.bold(args.decisionLabel)}`);
  lines.push(c.bold("└──────────────────────────────────────────────────"));
  return lines;
}

/** 执行证据清单 */
export function renderEvidence(items: { command: string; conclusion: string }[]): string[] {
  const lines = [c.bold("执行证据:")];
  for (const [i, e] of items.entries()) {
    lines.push(`  ${c.cyan(`${i + 1}.`)} \`${e.command}\``);
    lines.push(`     ${c.gray("→")} ${e.conclusion}`);
  }
  return lines;
}

/** 顶部状态条（M1 文字版） */
export function renderStatusBar(status: {
  judgments: number;
  byAction: Record<string, number>;
  byPartition: Record<string, number>;
  costUsd: string;
  baselineUsd: string;
  savingsUsd: string;
}): string {
  const acts = ["execute", "hand-back", "unsure", "need-you"] as const;
  const labels: Record<(typeof acts)[number], string> = {
    execute: "直接执行",
    "hand-back": "交回",
    unsure: "拿不准",
    "need-you": "需要你",
  };
  const actStr = acts
    .map((a) => `${labels[a]} ${status.byAction[a] ?? 0}`)
    .join(" · ");
  const partStr =
    Object.keys(status.byPartition).length > 0
      ? Object.entries(status.byPartition)
          .map(([n, k]) => `${n}×${k}`)
          .join(" · ")
      : "–";
  return (
    `${c.bold("JEV 办公室")}  今日判断 ${c.cyan(String(status.judgments))} │ ${actStr}` +
    ` │ 分区 ${partStr} │ 花费 ${c.yellow(status.costUsd)}` +
    ` │ 对照最贵 ${status.baselineUsd} │ ${c.green(`省 ${status.savingsUsd}`)}`
  );
}
