import { test } from "node:test";
import assert from "node:assert/strict";
import type { DispatchOutcome } from "../src/manager/engineering-manager.ts";
import type { ExecutionResult, Partition } from "../src/core/types.ts";
import { mkInitialState, reduce, spinnerFrame, type TuiEvent } from "../src/tui/state.ts";
import { renderFrame } from "../src/tui/frame.ts";
import { fit, strWidth, stripAnsi, sliceToWidth, padEndWidth } from "../src/tui/wid.ts";

/* ------------------------------ fixtures ------------------------------ */

const P0: Partition = {
  name: "4.0 织造",
  model: "claude-sonnet",
  specialties: "前端 页面 HTML",
  priceInPer1M: 3,
  priceOutPer1M: 15,
  executor: { command: ["echo", "{prompt}"], resultMode: "stdout" },
};
const P1: Partition = {
  name: "2.1 墨笔",
  model: "codex-default",
  specialties: "中文写作 润色",
  priceInPer1M: 1.5,
  priceOutPer1M: 12,
  executor: { command: ["echo", "{prompt}"], resultMode: "stdout" },
};
const PARTS = [P0, P1];

function mkState() {
  return mkInitialState({
    managerName: "azir",
    backendLabel: "pseudo-test",
    threshold: 0.7,
    partitions: PARTS,
    baselineName: "4.0 织造",
  });
}

const fakeResult: ExecutionResult = {
  resultFile: "/tmp/x/result.md",
  resultText: "done body",
  evidence: [{ command: "wc -l", conclusion: "3 个文件" }],
  exitCode: 0,
  durationMs: 1200,
  inputTokens: 100,
  outputTokens: 20,
  usageEstimated: false,
  stdoutLog: "/tmp/x/stdout.log",
  stderrLog: "/tmp/x/stderr.log",
};

const flow: TuiEvent[] = [
  { type: "owned-start", briefFile: "briefs/p0.json", nowMs: 1000, lane: 0, manager: "azir" },
  {
    type: "choice",
    question: "派给谁？",
    distribution: { "4.0 织造": 0.9, "2.1 墨笔": 0.1 },
    confidence: 0.95,
    latencyMs: 3,
    backend: "pseudo",
  },
  {
    type: "decision",
    decision: { state: "execute", picked: "4.0 织造", reason: "把握 0.95 ≥ 线 0.7" },
    confidence: 0.95,
    threshold: 0.7,
  },
  { type: "command", partition: P0, displayCmd: "echo {4.0 织造 执行者收到任务书}" },
  { type: "executed", result: fakeResult },
  { type: "evidence", items: fakeResult.evidence },
  { type: "noul", purpose: "验收门禁", answer: { p: 0.9, verdict: true, confidence: 0.8 } },
];

const doneOutcome: DispatchOutcome = {
  state: "done",
  dispatchId: 7,
  brief: { title: "页面", description: "", scope: [], acceptance: [], constraints: [] },
  decision: { state: "execute", picked: "4.0 织造", reason: "ok" },
  distribution: { "4.0 织造": 0.9, "2.1 墨笔": 0.1 },
  confidence: 0.95,
  partition: P0,
  result: fakeResult,
  noulPassed: true,
  scoreValue: null,
  cost: { costUsd: 0.01, baselineUsd: 0.05, jevUsd: 0.0001, executorUsd: 0.0099, savingsUsd: 0.04 },
  redispatchIds: [],
};

/* ------------------------------ wid 宽度学 ------------------------------ */

test("wid: CJK 双宽与 ANSI 零宽", () => {
  assert.equal(strWidth("弧光"), 4);
  assert.equal(strWidth("3.2 弧光"), 8); // 3 + . + 2 + 空格 = 4 列，弧光各 2 列
  assert.equal(strWidth("\x1b[32m弧\x1b[39m"), 2);
  assert.equal(stripAnsi("\x1b[1mabc\x1b[22m"), "abc");
});

test("wid: fit 精确补齐/截断，不切半字", () => {
  assert.equal(strWidth(fit("弧光", 10)), 10);
  // "弧" 宽 2，只能放进 3 列里的前两列
  assert.equal(strWidth(sliceToWidth("弧光", 3)), 2);
  assert.equal(strWidth(padEndWidth("✔ done", 20)), 20);
});

/* ------------------------------ reducer ------------------------------ */

test("reducer: 完整派发生命周期 → 面板/忙闲/完成卡/日志", () => {
  const s = mkState();
  for (const e of flow) reduce(s, e);
  // 判断面板
  assert.ok(s.choicePanel);
  assert.match(s.choicePanel!.decisionLabel, /4\.0 织造/);
  assert.equal(s.choicePanel!.confidence, 0.95);
  // 忙闲：command 点亮工位
  assert.equal(s.partitions[0]!.busy, true);
  // 完成
  reduce(s, { type: "owned-finish", outcome: doneOutcome });
  assert.equal(s.partitions[0]!.busy, false);
  const run = s.runs[0]!;
  assert.equal(run.finalText !== null, true);
  assert.match(run.finalText!, /✔ done/);
  assert.match(run.finalText!, /✓验收/);
  assert.match(run.finalText!, /省\$/);
  // 证据与 noul 进了卡片
  assert.equal(run.evidence.length, 1);
  assert.match(run.noulLine!, /验收门禁/);
  // 日志带完成行
  assert.ok(s.logs.some((l) => l.text.includes("#7") && l.text.includes("done")));
});

test("reducer: 改派把忙闲从 A 搬到 B", () => {
  const s = mkState();
  for (const e of flow.slice(0, 4)) reduce(s, e);
  assert.equal(s.partitions[0]!.busy, true);
  reduce(s, { type: "redispatch", fromPartition: P0.name, toPartition: P1.name, reason: "验收未过" });
  assert.equal(s.partitions[0]!.busy, false);
  assert.equal(s.partitions[1]!.busy, true);
  assert.equal(s.runs[0]!.partition, P1.name);
});

test("reducer: 输入/确认/退出武装三种模式", () => {
  const s = mkState();
  reduce(s, { type: "mode", mode: "input" });
  reduce(s, { type: "input-set", text: "examples/briefs/x.json" });
  assert.equal(s.inputBuffer, "examples/briefs/x.json");
  const f1 = renderFrame(s, 80, 24, Date.now());
  assert.ok(f1.some((l) => stripAnsi(l).includes("任务书路径: examples/briefs/x.json")));
  reduce(s, { type: "mode", mode: "confirm" });
  const f2 = renderFrame(s, 80, 24, Date.now());
  assert.ok(f2.some((l) => stripAnsi(l).includes("[y/N]")));
  reduce(s, { type: "mode", mode: "dashboard" }); // q 只能从 dashboard 武装
  // M3 语义：有派发在跑时按 q 才武装（空闲时直接退出）
  reduce(s, { type: "owned-start", briefFile: "briefs/running.json", nowMs: 5, lane: 0, manager: "azir" });
  reduce(s, { type: "quit-arm" });
  const f3 = renderFrame(s, 80, 24, Date.now());
  assert.ok(f3.some((l) => stripAnsi(l).includes("再按 q 强制退出")));
});

/* ------------------------------ frame ------------------------------ */

test("frame 100×36：行数/列宽精确，五区齐", () => {
  const s = mkState();
  for (const e of flow) reduce(s, e);
  reduce(s, { type: "owned-finish", outcome: doneOutcome });
  reduce(s, {
    type: "summary",
    summary: {
      judgments: 2,
      byAction: { execute: 1 },
      byPartition: { "4.0 织造": 1 },
      costUsd: "$0.0100",
      baselineUsd: "$0.0500",
      savingsUsd: "$0.04",
    },
  });
  const lines = renderFrame(s, 100, 36, 2000);
  assert.equal(lines.length, 36);
  for (const l of lines) {
    assert.equal(strWidth(l), 100, `行宽必须精确 100：${stripAnsi(l)}`);
  }
  const body = lines.map(stripAnsi).join("\n");
  for (const anchor of ["JEV 办公室", "分区工位", "问:", "把握", "账本", "派发流水", "日志", "q 退出", "$0.0100"]) {
    assert.ok(body.includes(anchor), `缺锚点 ${anchor}`);
  }
});

test("frame 56×20 窄屏：不溢出且仍有核心锚点", () => {
  const s = mkState();
  for (const e of flow) reduce(s, e);
  const lines = renderFrame(s, 56, 20, 2000);
  assert.equal(lines.length, 20);
  for (const l of lines) {
    assert.equal(strWidth(l), 56, `窄屏行宽必须精确 56：${stripAnsi(l)}`);
  }
  const body = lines.map(stripAnsi).join("\n");
  assert.ok(body.includes("JEV 办公室"));
  assert.ok(body.includes("派发流水"));
  assert.ok(body.includes("#7") === false); // 窄屏也够放 —— 只保证无未完成的 pending；完成卡应在
});

test("frame: 无历史时的空办公室也能渲染", () => {
  const s = mkState();
  const lines = renderFrame(s, 100, 30, Date.now());
  assert.equal(lines.length, 30);
  const body = lines.map(stripAnsi).join("\n");
  assert.ok(body.includes("还没有判断"));
  assert.ok(body.includes("空闲"));
});

test("spinner 帧随 tick 转动", () => {
  assert.notEqual(spinnerFrame(0), spinnerFrame(1));
  assert.equal(spinnerFrame(10), spinnerFrame(0));
});
