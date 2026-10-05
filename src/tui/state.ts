/**
 * M2 TUI 的数据内核：纯数据状态 + 纯函数 reducer。
 *
 * 设计约束（与 M1 相同）：零依赖、可单测。这里没有任何 IO —
 * 键盘/屏幕/计时器全部在 app.ts 薄壳里；渲染在 frame.ts 纯函数里。
 * 将来若换 OpenTUI，只需把 frame+app 换成 Renderable 树，state/reducer 原样保留。
 *
 * M3：多工程经理。每条经理泳道（lane）一张活动 RunCard；ManagerEvent
 * 在 reducer 边界被贴上 lane 标签（app.ts 的 emit 封装），本文件按 lane 归位。
 *
 * 事件来源两类：
 *   1. ManagerEvent（工程经理派发过程中 emit 的，可带 lane 标签）
 *   2. TuiEvent（TUI 自己产生的：开始/完成/队列/摘要/模式/输入/tick）
 */
import type { ManagerEvent, DispatchOutcome } from "../manager/engineering-manager.ts";
import type { Partition } from "../core/types.ts";
import { DECISION_STATE_LABEL } from "../core/types.ts";
import { fmtUsd } from "../ledger/costs.ts";

export interface PartitionRow {
  name: string;
  model: string;
  priceText: string; // "$15/$75"
  specialties: string;
  isBaseline: boolean; // 最贵分区（成本对照基准）
  busy: boolean;
  busyBy: string | null; // M3：哪个经理在占用这个工位
}

export interface RoleRow {
  name: string;
  busy: boolean;
  seq: number | null; // 正在处理的派发序号（显示用）
}

export interface ChoicePanel {
  question: string;
  distribution: Record<string, number>;
  specs: Record<string, { specialty: string }>;
  confidence: number;
  threshold: number;
  decisionLabel: string;
  decisionState: string;
  latencyMs: number;
  backend: string;
}

/** 一次派发的滚动卡片（进行中与已完成共用） */
export interface RunCard {
  seq: number;
  lane: number; // M3：所属经理泳道
  manager: string; // M3：承办经理名
  briefFile: string;
  partition: string | null;
  displayCmd: string | null;
  startedAtMs: number;
  exitCode: number | null;
  tokenText: string | null;
  evidence: { command: string; conclusion: string }[];
  noulLine: string | null;
  finalText: string | null; // ✔ done … / ✖ failed … / 🙋 需要你 …
}

export interface LogLine {
  ts: string; // HH:MM:SS
  text: string;
}

export interface OfficeSummary {
  judgments: number;
  byAction: Record<string, number>;
  byPartition: Record<string, number>;
  costUsd: string;
  baselineUsd: string;
  savingsUsd: string;
}

export type TuiMode = "dashboard" | "input" | "confirm";

export interface TuiState {
  managerName: string;
  backendLabel: string;
  threshold: number;
  /** M3 角色条：经理花名册 + 顾问 */
  managers: RoleRow[];
  advisor: RoleRow;
  partitions: PartitionRow[];
  choicePanel: ChoicePanel | null;
  runs: RunCard[]; // 最新在头部；finalText===null 且在 lane 上最新者 = 该泳道活动卡
  queue: string[];
  logs: LogLine[]; // 旧→新
  summary: OfficeSummary | null;
  mode: TuiMode;
  inputBuffer: string;
  tickCount: number;
  quitArmed: boolean; // 有派发在跑时按过一次 q
}

export type TuiEvent =
  | (ManagerEvent & { lane?: number })
  | { type: "owned-start"; briefFile: string; nowMs: number; lane: number; manager: string }
  | { type: "owned-finish"; outcome: DispatchOutcome; lane?: number }
  | { type: "summary"; summary: OfficeSummary }
  | { type: "queue-set"; items: string[] }
  | { type: "mode"; mode: TuiMode }
  | { type: "input-set"; text: string }
  | { type: "tick" }
  | { type: "quit-arm" }
  | { type: "quit-disarm" }
  | { type: "log"; text: string }
  | { type: "error"; message: string; lane?: number };

const MAX_LOGS = 300;
const MAX_RUNS = 8;

function nowHHMMSS(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function pushLog(s: TuiState, text: string): void {
  s.logs.push({ ts: nowHHMMSS(), text });
  if (s.logs.length > MAX_LOGS) s.logs.splice(0, s.logs.length - MAX_LOGS);
}

/** 该泳道的活动卡 */
function activeRun(s: TuiState, lane: number): RunCard | null {
  return s.runs.find((r) => r.lane === lane && r.finalText === null) ?? null;
}

function anyActive(s: TuiState): boolean {
  return s.runs.some((r) => r.finalText === null);
}

function setBusy(s: TuiState, name: string, busy: boolean, busyBy: string | null = null): void {
  for (const p of s.partitions) {
    if (p.name === name) {
      p.busy = busy;
      p.busyBy = busy ? busyBy : null;
    }
  }
}

export function mkInitialState(args: {
  managerName: string;
  backendLabel: string;
  threshold: number;
  partitions: Partition[];
  baselineName: string;
  managers?: string[];
  advisorName?: string;
}): TuiState {
  const names = args.managers && args.managers.length > 0 ? args.managers : [args.managerName];
  return {
    managerName: args.managerName,
    backendLabel: args.backendLabel,
    threshold: args.threshold,
    managers: names.map((n) => ({ name: n, busy: false, seq: null })),
    advisor: { name: args.advisorName ?? "sage", busy: false, seq: null },
    partitions: args.partitions.map((p) => ({
      name: p.name,
      model: p.model,
      priceText: `$${p.priceInPer1M}/$${p.priceOutPer1M}`,
      specialties: p.specialties,
      isBaseline: p.name === args.baselineName,
      busy: false,
      busyBy: null,
    })),
    choicePanel: null,
    runs: [],
    queue: [],
    logs: [],
    summary: null,
    mode: "dashboard",
    inputBuffer: "",
    tickCount: 0,
    quitArmed: false,
  };
}

/** 每条泳道各自的待合流 choice（等 decision 凑面板用） */
const pendingChoiceByLane = new Map<number, Extract<ManagerEvent, { type: "choice" }>>();
let seqCounter = 0;

function decisionLabelOf(state: string, picked: string | null): string {
  const label = DECISION_STATE_LABEL[state as keyof typeof DECISION_STATE_LABEL] ?? state;
  if (state === "execute" && picked) return `✅ → 派给 ${picked} · ${label}`;
  const icon = { "hand-back": "🔙", unsure: "🤔", "need-you": "🙋" }[state] ?? "•";
  return picked ? `${icon} → 暂派 ${picked} · ${label}` : `${icon} ${label}`;
}

export function reduce(s: TuiState, e: TuiEvent): TuiState {
  // 顾问的"咨询中"只在顾问事件刚到的瞬间点亮；本泳道下一个事件把它熄灭
  const lane = "lane" in e && typeof e.lane === "number" ? e.lane : 0;
  if (e.type !== "advisor" && e.type !== "tick" && e.type !== "summary") {
    s.advisor.busy = false;
  }
  switch (e.type) {
    case "owned-start": {
      s.runs.unshift({
        seq: ++seqCounter,
        lane: e.lane,
        manager: e.manager,
        briefFile: e.briefFile,
        partition: null,
        displayCmd: null,
        startedAtMs: e.nowMs,
        exitCode: null,
        tokenText: null,
        evidence: [],
        noulLine: null,
        finalText: null,
      });
      if (s.runs.length > MAX_RUNS) s.runs.length = MAX_RUNS;
      const mgr = s.managers.find((m) => m.name === e.manager);
      if (mgr) {
        mgr.busy = true;
        mgr.seq = seqCounter;
      }
      s.queue = s.queue.filter((q) => q !== e.briefFile);
      pushLog(s, `▸ ${e.manager} 接单 #${seqCounter} ${e.briefFile}`);
      return s;
    }
    case "choice": {
      pendingChoiceByLane.set(lane, e);
      return s;
    }
    case "decision": {
      const pc = pendingChoiceByLane.get(lane) ?? null;
      pendingChoiceByLane.delete(lane);
      if (pc) {
        const specs = Object.fromEntries(
          s.partitions.map((p) => [p.name, { specialty: p.specialties }]),
        );
        s.choicePanel = {
          question: pc.question,
          distribution: pc.distribution,
          specs,
          confidence: pc.confidence,
          threshold: e.threshold,
          decisionLabel: decisionLabelOf(e.decision.state, e.decision.picked),
          decisionState: e.decision.state,
          latencyMs: pc.latencyMs,
          backend: pc.backend,
        };
      }
      const d = e.decision;
      pushLog(
        s,
        `choice → ${d.state}` +
          (d.picked ? ` (${d.picked} ${topPct(s)})` : "") +
          (d.state !== "execute" ? ` — ${d.reason}` : ""),
      );
      return s;
    }
    case "command": {
      const run = activeRun(s, lane);
      if (run) {
        run.partition = e.partition.name;
        run.displayCmd = e.displayCmd;
      }
      setBusy(s, e.partition.name, true, run?.manager ?? null);
      pushLog(s, `派给 ${e.partition.name}（模型 ${e.partition.model}）`);
      return s;
    }
    case "executed": {
      const run = activeRun(s, lane);
      if (run) {
        run.exitCode = e.result.exitCode;
        run.tokenText =
          `in=${e.result.inputTokens} out=${e.result.outputTokens}` +
          (e.result.usageEstimated ? "(估)" : "(实测)");
      }
      pushLog(
        s,
        `执行完毕 exit=${e.result.exitCode} 用时 ${(e.result.durationMs / 1000).toFixed(1)}s`,
      );
      return s;
    }
    case "evidence": {
      const run = activeRun(s, lane);
      if (run) run.evidence = e.items.slice(0, 3);
      return s;
    }
    case "noul": {
      const mark = e.answer.verdict ? "是" : "否";
      const line = `${e.purpose} P(是)=${(e.answer.p * 100).toFixed(1)}% → ${mark}`;
      const run = activeRun(s, lane);
      if (run) run.noulLine = line;
      pushLog(s, `noul ${line}`);
      return s;
    }
    case "advisor": {
      s.advisor.busy = true;
      const mark = e.answer.p >= 0.5 ? "放行" : "否决";
      pushLog(s, `顾问 ${e.advisor} 咨询：P(执行)=${(e.answer.p * 100).toFixed(1)}% → ${mark}`);
      const run = activeRun(s, lane);
      if (run) run.noulLine = `顾问 ${e.advisor}: P(执行)=${(e.answer.p * 100).toFixed(1)}% → ${mark}`;
      return s;
    }
    case "redispatch": {
      const run = activeRun(s, lane);
      setBusy(s, e.fromPartition, false);
      setBusy(s, e.toPartition, true, run?.manager ?? null);
      if (run) run.partition = e.toPartition;
      pushLog(s, `↻ 改派 ${e.fromPartition} → ${e.toPartition}（${e.reason}）`);
      return s;
    }
    case "score": {
      pushLog(s, `score 质量评分 ${e.score.toFixed(1)}/5`);
      return s;
    }
    case "owned-finish": {
      const o = e.outcome;
      const run = activeRun(s, e.lane ?? 0);
      const stateIcon =
        o.state === "done" ? "✔" : o.state === "failed" ? "✖" : "◐";
      const cost = o.cost
        ? ` ${fmtUsd(o.cost.costUsd)} 省${fmtUsd(o.cost.savingsUsd)}`
        : ""; // 与 CLI 一致：微额 2 位有效数字科学计数，常见额两位小数
      const finalText =
        `${stateIcon} ${o.state}` +
        (o.partition ? ` ${o.partition.name}` : "") +
        (o.noulPassed === true ? " ✓验收" : o.noulPassed === false ? " ✗验收" : "") +
        cost;
      if (run) {
        run.finalText = finalText;
        const mgr = s.managers.find((m) => m.name === run.manager);
        if (mgr) {
          mgr.busy = false;
          mgr.seq = null;
        }
        if (run.partition) setBusy(s, run.partition, false);
      }
      if (o.decision.state !== "execute" && o.partition === null) {
        // 四态提前退出时补一句理由，方便老板看到为什么没执行
        pushLog(s, `${o.state}: ${o.decision.reason}`);
      }
      pushLog(s, `#${o.dispatchId} ${finalText}`);
      return s;
    }
    case "summary": {
      s.summary = e.summary;
      return s;
    }
    case "queue-set": {
      const had = s.queue.length;
      s.queue = [...e.items];
      if (s.queue.length > had) pushLog(s, `队列 +${s.queue.length - had}（${s.queue.join(", ")}）`);
      return s;
    }
    case "mode": {
      s.mode = e.mode;
      if (e.mode === "input") s.inputBuffer = "";
      return s;
    }
    case "input-set": {
      s.inputBuffer = e.text;
      return s;
    }
    case "tick": {
      s.tickCount += 1;
      return s;
    }
    case "quit-arm": {
      if (anyActive(s)) {
        s.quitArmed = true;
        pushLog(s, "派发进行中 —— 再按一次 q 强制退出");
      } else {
        s.quitArmed = false;
      }
      return s;
    }
    case "quit-disarm": {
      s.quitArmed = false;
      return s;
    }
    case "log": {
      pushLog(s, e.text);
      return s;
    }
    case "error": {
      pushLog(s, `✗ ${e.message}`);
      const run = activeRun(s, e.lane ?? 0);
      if (run) {
        run.finalText = `✖ 出错 ${e.message}`;
        const mgr = s.managers.find((m) => m.name === run.manager);
        if (mgr) {
          mgr.busy = false;
          mgr.seq = null;
        }
        if (run.partition) setBusy(s, run.partition, false);
      }
      return s;
    }
  }
}

function topPct(s: TuiState): string {
  const panel = s.choicePanel;
  if (!panel) return "";
  const top = Object.entries(panel.distribution).sort((a, b) => b[1] - a[1])[0];
  return top ? `${(top[1] * 100).toFixed(0)}%` : "";
}

/** spinner 帧：tick 驱动 */
export function spinnerFrame(tick: number): string {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  return frames[tick % frames.length]!;
}
