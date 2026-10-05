/**
 * M2 TUI 渲染层：纯函数。进参 TuiState + 终端宽高 + 当前时间，出参精确 rows 行、
 * 每行精确 cols 列（含 ANSI 颜色，宽度按可视列计 —— 见 wid.ts）。
 *
 * 布局（宽屏 ≥ 92 列三栏，中屏 60–91 双栏，窄屏单列）：
 *   ┌ header: 标题 + 快捷键      ┐
 *   │        今日摘要行           │
 *   ├ 分区工位 │ JEV 判断 │ 账本 ┤  ← zone 区
 *   ├ 派发流水（当前/完成/队列）  ┤  ← 固定 8 行
 *   ├ 日志（滚动，旧→新）        ┤  ← 吃剩余高度
 *   └ footer: 模式相关操作行     ┘
 */
import { c } from "../ui/ansi.ts";
import { fit, strWidth, padEndWidth, sliceToWidth } from "./wid.ts";
import { spinnerFrame, type ChoicePanel, type RunCard, type TuiState } from "./state.ts";

const WIDE_MIN = 92;
const MED_MIN = 60;
const RUNS_H = 8;
const HDR_H = 4; // 标题 + 摘要 + 角色条 + 分隔
const FOOT_H = 2;

/* ------------------------------ 小零件 ------------------------------ */

function rule(width: number, title = ""): string {
  if (width <= 2) return "─".repeat(width);
  const t = title ? ` ${title} ` : "";
  const rest = Math.max(0, width - strWidth(t) - 1);
  return c.gray("─" + t + "─".repeat(rest));
}

function bar(p: number, w: number): string {
  const filled = Math.round(p * w);
  return "█".repeat(Math.max(0, Math.min(w, filled))).padEnd(Math.max(0, w), "░");
}

/* ------------------------------ 三个 zone ------------------------------ */

function buildPartitionLines(s: TuiState): string[] {
  const lines: string[] = [c.bold("分区工位")];
  for (const p of s.partitions) {
    const mark = p.isBaseline ? c.red("◆") : " ";
    const status = p.busy ? c.yellow(`●${p.busyBy ?? "跑"}`) : c.gray("空闲");
    const name = padEndWidth(p.name, 10);
    lines.push(`${mark} ${name} ${status} ${c.gray(p.priceText)}`);
  }
  return lines;
}

/** M3 角色条：老板 + 经理花名册 + 顾问 */
function buildRolesLine(s: TuiState): string {
  const seg = (r: { name: string; busy: boolean; seq: number | null }) =>
    r.busy
      ? `${c.bold(r.name)} ${c.yellow(`●跑#${r.seq ?? "?"}`)}`
      : `${r.name} ${c.gray("空闲")}`;
  return `👤 ${c.bold("你")} ${c.gray("(老板)")} │ ${s.managers.map(seg).join(" │ ")} │ 顾问 ${s.advisor.busy ? c.bold(s.advisor.name) + " " + c.magenta("🔮咨询中") : `${s.advisor.name} ${c.gray("空闲")}`}`;
}

function buildChoiceLines(panel: ChoicePanel | null, width: number): string[] {
  if (!panel) {
    return [
      c.bold("JEV 判断"),
      c.gray("(还没有判断 — 按 d 派发一个任务书)"),
    ];
  }
  const lines: string[] = [];
  lines.push(
    `${c.cyan("问:")} ${sliceToWidth(panel.question, Math.max(8, width - 4))} ${c.gray(`[${panel.backend}]`)}`,
  );
  const entries = Object.entries(panel.distribution).sort((a, b) => b[1] - a[1]);
  const nameW = 10;
  const pctW = 7;
  const barW = Math.max(6, width - nameW - pctW - 3);
  for (const [name, p] of entries) {
    const pct = `${(p * 100).toFixed(1)}%`.padStart(6);
    const paint = p === entries[0]![1] ? c.green : c.gray;
    lines.push(`${padEndWidth(name, nameW)} ${paint(bar(p, barW))} ${paint(pct)}`);
  }
  // 把握度量规：━ 实线 = 把握度，┆ 虚线 = 把握线
  const gw = Math.max(10, Math.min(28, width - 20));
  const confPos = Math.round(panel.confidence * gw);
  const thrPos = Math.round(panel.threshold * gw);
  const gauge = Array.from({ length: gw + 1 }, (_, i) =>
    i === thrPos ? "┆" : i <= confPos ? "━" : "─",
  ).join("");
  const ok = panel.confidence >= panel.threshold;
  lines.push(
    `${c.bold("把握")} ${(ok ? c.green : c.yellow)(panel.confidence.toFixed(2))} ${gauge} ${c.gray(`线${panel.threshold.toFixed(2)}`)}`,
  );
  lines.push(`${c.bold(panel.decisionLabel)} ${c.gray(`${panel.latencyMs.toFixed(0)}ms`)}`);
  return lines;
}

function buildLedgerLines(s: TuiState): string[] {
  if (!s.summary) return [c.bold("账本（今日）"), c.gray("(暂无记录)")];
  const m = s.summary;
  const acts = [
    ["执行", m.byAction["execute"] ?? 0],
    ["交回", m.byAction["hand-back"] ?? 0],
    ["拿不准", m.byAction["unsure"] ?? 0],
    ["需要你", m.byAction["need-you"] ?? 0],
  ] as const;
  const lines = [
    c.bold("账本(今日)"),
    `判断 ${c.cyan(String(m.judgments))}`,
    acts.map(([k, n]) => `${k} ${n}`).join(" · "),
  ];
  const parts = Object.entries(m.byPartition);
  if (parts.length > 0) lines.push(parts.map(([n, k]) => `${n}×${k}`).join(" "));
  lines.push(
    `花费 ${c.yellow(m.costUsd)}`,
    `对照 ${m.baselineUsd}`,
    c.green(`省 ${m.savingsUsd}`),
  );
  return lines;
}

/** 拼接 zone 区：返回高度恒定的行数组 */
function buildZones(
  s: TuiState,
  cols: number,
  zoneH: number,
): string[] {
  const padAll = (arr: string[], w: number): string[] => {
    const out = arr.slice(0, zoneH).map((l) => fit(l, w));
    while (out.length < zoneH) out.push(" ".repeat(w));
    return out;
  };
  if (cols >= WIDE_MIN) {
    const leftW = 32;
    const rightW = 26;
    const midW = cols - leftW - rightW - 2;
    const left = padAll(buildPartitionLines(s), leftW);
    const mid = padAll(buildChoiceLines(s.choicePanel, midW), midW);
    const right = padAll(buildLedgerLines(s), rightW);
    return Array.from(
      { length: zoneH },
      (_, r) => left[r]! + c.gray("│") + mid[r]! + c.gray("│") + right[r]!,
    );
  }
  if (cols >= MED_MIN) {
    const leftW = 30;
    const midW = cols - leftW - 1;
    const left = padAll(buildPartitionLines(s), leftW);
    const mid = padAll(buildChoiceLines(s.choicePanel, midW), midW);
    return Array.from(
      { length: zoneH },
      (_, r) => left[r]! + c.gray("│") + mid[r]!,
    );
  }
  // 窄屏：判断面板在上，分区一行流在下
  const choice = buildChoiceLines(s.choicePanel, cols);
  const partFlow =
    "分区: " +
    s.partitions
      .map((p) => `${p.name}${p.busy ? "●" : ""}`)
      .join(" · ");
  return padAll([...choice, "", partFlow], cols);
}

/* ------------------------------ 派发流水 ------------------------------ */

function buildRunsLines(s: TuiState, cols: number, nowMs: number): string[] {
  const lines: string[] = [];
  const actives = s.runs.filter((r) => r.finalText === null).slice(0, 2);
  const focus = actives[0] ?? null;
  for (const r of actives) {
    const elapsed = Math.max(0, (nowMs - r.startedAtMs) / 1000).toFixed(1);
    lines.push(
      c.yellow(
        `#${r.seq} [${r.manager}] ▸ ${r.partition ?? "判断中…"} ${spinnerFrame(s.tickCount)} ${elapsed}s`,
      ),
    );
  }
  // 焦点泳道（最近启动的活动派发）：命令 + 证据 + noul 详情
  if (focus) {
    if (focus.displayCmd) lines.push(c.gray(`$ ${focus.displayCmd}`));
    for (const ev of focus.evidence.slice(0, 2)) {
      lines.push(`证据 \`${ev.command}\` → ${ev.conclusion}`);
    }
    if (focus.noulLine) lines.push(`noul ${focus.noulLine}`);
    if (focus.tokenText) lines.push(c.gray(`exit=${focus.exitCode ?? "?"} · ${focus.tokenText}`));
  }
  if (actives.length === 0) {
    lines.push(c.gray("(空闲 — 按 d 派发一个任务书)"));
  }
  const finished = s.runs.filter((r) => r.finalText !== null).slice(0, actives.length > 0 ? 1 : 4);
  for (const r of finished) {
    const paint = r.finalText!.startsWith("✔") ? c.green : r.finalText!.startsWith("✖") ? c.red : c.yellow;
    lines.push(paint(`#${r.seq} ${r.finalText}`));
  }
  lines.push(
    c.gray(s.queue.length > 0 ? `队列: ${s.queue.join(", ")}` : "队列: 空"),
  );
  // Fall back 补齐，title 在最外面加
  const body = lines.slice(0, RUNS_H - 1).map((l) => fit(l, cols));
  while (body.length < RUNS_H - 1) body.push(" ".repeat(cols));
  return [rule(cols, "派发流水"), ...body];
}

/* ------------------------------ 日志 ------------------------------ */

function buildLogLines(s: TuiState, cols: number, h: number): string[] {
  const tail = s.logs.slice(-h);
  return tail.map((l) => fit(`${c.gray(l.ts)} ${l.text}`, cols));
}

/* ------------------------------ 总装 ------------------------------ */

export function renderFrame(
  s: TuiState,
  colsRaw: number,
  rowsRaw: number,
  nowMs: number,
): string[] {
  const cols = Math.max(40, Math.floor(colsRaw));
  const rows = Math.max(20, Math.floor(rowsRaw)); // 低于 20 行时各区块最小高度之和会超界

  // header
  const title = `▌${c.bold("JEV 办公室")} · ${s.managerName} · ${c.cyan(s.backendLabel)} · 把握线 ${s.threshold.toFixed(2)}`;
  const hints = c.gray("d 派发 · q 退出");
  const gap = Math.max(1, cols - strWidth(title) - strWidth(hints));
  const header1 = title + " ".repeat(gap) + hints;
  const m = s.summary;
  const header2 = m
    ? c.gray(
        `今日判断 ${m.judgments} · 执行 ${m.byAction["execute"] ?? 0} · 交回 ${m.byAction["hand-back"] ?? 0} · 拿不准 ${m.byAction["unsure"] ?? 0} · 需要你 ${m.byAction["need-you"] ?? 0} · 花费 ${m.costUsd} · 省 ${m.savingsUsd}`,
      )
    : c.gray("今日暂无记录");
  const header = [fit(header1, cols), fit(header2, cols), fit(buildRolesLine(s), cols), rule(cols)];

  // footer（模式相关）
  let footerBody: string;
  if (s.mode === "input") {
    footerBody =
      `${c.cyan("任务书路径:")} ${s.inputBuffer}${c.gray("▏")}  ${c.gray("(Enter 派发 · Esc 取消)")}`;
  } else if (s.mode === "confirm") {
    footerBody = c.yellow("执行上面这条命令? [y/N]  (y 执行 · n / Esc 取消)");
  } else {
    const q = s.queue.length > 0 ? ` · 队列 ${c.cyan(String(s.queue.length))}` : "";
    const warn = s.quitArmed ? c.red(" · 再按 q 强制退出") : "";
    footerBody = `${c.cyan("q")} 退出 · ${c.cyan("d")} 派发任务书${q}${warn}`;
  }
  const footer = [rule(cols), fit(footerBody, cols)];

  // 高度分配：zone 吃掉自己需要的高度（封顶），日志吃剩下的
  const zoneWant = Math.max(
    buildPartitionLines(s).length,
    buildChoiceLines(s.choicePanel, cols >= WIDE_MIN ? cols - 60 : cols - 31).length,
    buildLedgerLines(s).length,
  );
  const zoneMax = rows - HDR_H - FOOT_H - RUNS_H - 1 /*日志标题*/ - 1 /*至少一行日志*/;
  const zoneH = Math.max(3, Math.min(zoneWant, Math.max(3, zoneMax)));
  const logsH = Math.max(1, rows - HDR_H - FOOT_H - RUNS_H - 1 - zoneH);

  const lines = [
    ...header,
    ...buildZones(s, cols, zoneH),
    ...buildRunsLines(s, cols, nowMs),
    rule(cols, "日志"),
    ...buildLogLines(s, cols, logsH),
    ...footer,
  ];
  // 严格规整行数与列宽（防御：任何 zone 溢出都裁掉）
  const fitted = lines.slice(0, rows).map((l) => fit(l, cols));
  while (fitted.length < rows) fitted.splice(fitted.length - FOOT_H, 0, " ".repeat(cols));
  return fitted;
}
