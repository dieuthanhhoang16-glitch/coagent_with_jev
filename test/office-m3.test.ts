/**
 * M3 完整办公室测试：
 *   1. consult 放行  —— 拿不准(conf 0.55 ∈ [0.4,0.7)) 时问顾问，顾问点头 → 照常执行
 *   2. consult 否决  —— 顾问摇头 → 升级"需要你"，不执行
 *   3. escalate 不受影响 —— 同样的拿不准，escalate 策略直接升级，绝不动问顾问
 *   4. 双泳道 reducer 路由 —— 两位经理事件交错，各归各道
 *   5. 角色条渲染 —— 老板/经理花名册/顾问，忙闲与"咨询中"
 *   6. .cast 文件格式 —— asciinema v2 header + [t,"o",data] 帧
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecutionResult, JudgmentMeta, OfficeConfig, Partition } from "../src/core/types.ts";
import { DEFAULTS } from "../src/core/config.ts";
import { loadPartitions } from "../src/core/partitions.ts";
import type { SystemOneClient } from "../src/jev/client.ts";
import { Ledger } from "../src/ledger/sqlite.ts";
import { runDispatch, type DispatchOutcome, type ManagerEvent } from "../src/manager/engineering-manager.ts";
import { mkInitialState, reduce, type TuiEvent } from "../src/tui/state.ts";
import { renderFrame } from "../src/tui/frame.ts";
import { stripAnsi } from "../src/tui/wid.ts";
import { openCast } from "../src/tui/cast.ts";

/* ------------------------------ fixtures ------------------------------ */

const RESULT_TEXT = ["结果满足验收标准。", "", "## 执行证据", "- `echo done` → 结果文件已写出"].join("\n");

let dir: string;
let briefFile: string;
let partitions: Partition[];

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-office-m3-"));
  fs.writeFileSync(
    path.join(dir, "partitions.json"),
    JSON.stringify({
      partitions: ["便宜区", "贵区"].map((name, i) => ({
        name,
        model: `fake-${i}`,
        specialties: i === 0 ? "简单 只读 统计" : "复杂 开发 审查",
        priceInPer1M: i === 0 ? 1 : 15,
        priceOutPer1M: i === 0 ? 5 : 75,
        executor: {
          command: [
            process.execPath,
            "-e",
            `require('fs').writeFileSync(process.argv.at(-1), ${JSON.stringify(RESULT_TEXT)})`,
            "{resultFile}",
          ],
          resultMode: "file",
          timeoutMs: 30000,
        },
      })),
    }),
  );
  partitions = loadPartitions(path.join(dir, "partitions.json"));
  briefFile = path.join(dir, "brief.json");
  fs.writeFileSync(
    briefFile,
    JSON.stringify({
      title: "M3 测试任务",
      description: "验证顾问与多泳道",
      scope: ["s1"],
      acceptance: ["a1"],
      constraints: [],
      workdir: dir,
    }),
  );
});
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const META: JudgmentMeta = { backend: "pseudo", latencyMs: 1, inputTokens: 10, outputTokens: 0 };

/** 假 JEV：choice 落在"拿不准"区间（贵区 0.85 / 便宜区 0.15，conf 0.55）；noul 按题面分流 */
function mkUnsureClient(opts: { advisorP: number; acceptP: number }): SystemOneClient {
  return {
    backend: "pseudo",
    label: "fake-m3",
    choice: () =>
      Promise.resolve({
        answer: {
          choice: "贵区",
          distribution: { 贵区: 0.85, 便宜区: 0.15 },
          confidence: 0.55, // ∈ [拿不准线 0.40, 把握线 0.70) → unsure
        },
        meta: META,
      }),
    noul: (_state, q) => {
      const isAdvisor = q.instructions.includes("顾问");
      const p = isAdvisor ? opts.advisorP : opts.acceptP;
      return Promise.resolve({ answer: { p, verdict: p >= 0.5, confidence: 0.9 }, meta: META });
    },
    score: () =>
      Promise.resolve({
        answer: { score: 4, legend: ["1", "2", "3", "4", "5"], distribution: [0, 0, 0, 1, 0], confidence: 1 },
        meta: META,
      }),
  };
}

function mkConfig(tag: string, onUncertain: OfficeConfig["onUncertain"]): OfficeConfig {
  return {
    ...structuredClone(DEFAULTS),
    partitionsFile: path.join(dir, "partitions.json"),
    dbPath: path.join(dir, `${tag}.db`),
    runsDir: path.join(dir, `${tag}-runs`),
    onUncertain,
    maxRedispatches: 0,
  };
}

/* ------------------------------ 1. consult 放行 ------------------------------ */

test("consult 放行：拿不准 → 顾问 sage 点头 → 照常执行 done，审计含顾问咨询", async () => {
  const config = mkConfig("consult-yes", "consult");
  const ledger = new Ledger(config.dbPath);
  const events: ManagerEvent[] = [];
  const outcome = await runDispatch(
    { config, partitions, ledger, client: mkUnsureClient({ advisorP: 0.8, acceptP: 0.95 }), emit: (e) => events.push(e) },
    { briefFile, managerName: "lyra" }, // M3：派发挂在第二位经理名下
  );

  assert.equal(outcome.state, "done");
  assert.equal(outcome.partition?.name, "贵区", "拿不准区间的 argmax 经顾问放行后照旧执行");
  assert.equal(outcome.decision.state, "unsure", "decision 本体仍是拿不准（顾问只是背书）");

  // 顾问事件与落库
  const adv = events.find((e) => e.type === "advisor");
  assert.ok(adv && adv.type === "advisor");
  assert.equal(adv.advisor, "sage");
  const js = ledger.recentJudgments(10);
  const advRow = js.find((r) => r.primitive === "noul" && r.question.includes("顾问"));
  assert.ok(advRow, "账本里应有一条带顾问问题的 noul 判断");
  assert.equal(advRow!.action, "yes");

  // 派发挂在 lyra 名下
  const d = ledger.recentDispatches(1)[0]!;
  assert.equal(d.manager, "lyra");
  assert.equal(d.state, "done");
  ledger.close();
});

/* ------------------------------ 2. consult 否决 ------------------------------ */

test("consult 否决：顾问 P(执行)=0.3 < 0.5 → 升级需要你，不执行", async () => {
  const config = mkConfig("consult-no", "consult");
  const ledger = new Ledger(config.dbPath);
  const events: ManagerEvent[] = [];
  const outcome = await runDispatch(
    { config, partitions, ledger, client: mkUnsureClient({ advisorP: 0.3, acceptP: 0.95 }), emit: (e) => events.push(e) },
    { briefFile, managerName: "lyra" },
  );

  assert.equal(outcome.state, "need-you");
  assert.equal(outcome.partition, null);
  assert.match(outcome.decision.reason, /顾问 sage 否决/);
  assert.ok(!events.some((e) => e.type === "command" || e.type === "executed"), "否决后不得派发执行器");
  const js = ledger.recentJudgments(10);
  assert.equal(js.filter((r) => r.primitive === "noul").length, 1, "只问了顾问一次，没有验收门禁");
  ledger.close();
});

/* ------------------------------ 3. escalate 不受影响 ------------------------------ */

test("escalate 策略不受顾问影响：拿不准直接升级，零顾问事件", async () => {
  const config = mkConfig("escalate", "escalate");
  const ledger = new Ledger(config.dbPath);
  const events: ManagerEvent[] = [];
  const outcome = await runDispatch(
    { config, partitions, ledger, client: mkUnsureClient({ advisorP: 0.9, acceptP: 0.95 }), emit: (e) => events.push(e) },
    { briefFile },
  );

  assert.equal(outcome.state, "need-you");
  assert.ok(!events.some((e) => e.type === "advisor"), "escalate 策略不应出现顾问事件");
  const js = ledger.recentJudgments(10);
  assert.equal(js.length, 1, "只有一次 choice 判断");
  assert.equal(js[0]!.primitive, "choice");
  ledger.close();
});

/* ------------------------------ 4. 双泳道 reducer 路由 ------------------------------ */

const fakeResult: ExecutionResult = {
  resultFile: "/tmp/r.md",
  resultText: "ok",
  evidence: [{ command: "ls", conclusion: "3 files" }],
  exitCode: 0,
  durationMs: 100,
  inputTokens: 10,
  outputTokens: 5,
  usageEstimated: false,
  stdoutLog: "/tmp/o.log",
  stderrLog: "/tmp/e.log",
};

function mkOutcome(over: Partial<DispatchOutcome>): DispatchOutcome {
  return {
    state: "done",
    dispatchId: 1,
    brief: { title: "t", description: "", scope: [], acceptance: [], constraints: [] },
    decision: { state: "execute", picked: "便宜区", reason: "ok" },
    distribution: { 便宜区: 0.9 },
    confidence: 0.9,
    partition: partitions[0]!,
    result: fakeResult,
    noulPassed: true,
    scoreValue: null,
    cost: null,
    redispatchIds: [],
    ...over,
  };
}

test("双泳道路由：两位经理事件交错，各归各道", () => {
  const s = mkInitialState({
    managerName: "azir",
    backendLabel: "fake",
    threshold: 0.7,
    partitions,
    baselineName: "贵区",
    managers: ["azir", "lyra"],
    advisorName: "sage",
  });
  const ev = (e: ManagerEvent, lane: number): TuiEvent => ({ ...e, lane });
  reduce(s, { type: "owned-start", briefFile: "a.json", nowMs: 1000, lane: 0, manager: "azir" });
  reduce(s, { type: "owned-start", briefFile: "b.json", nowMs: 2000, lane: 1, manager: "lyra" });

  // 交错事件：azir 的命令、lyra 的命令、azir 的 noul
  reduce(s, ev({ type: "command", partition: partitions[0]!, displayCmd: "run-a" }, 0));
  reduce(s, ev({ type: "command", partition: partitions[1]!, displayCmd: "run-b" }, 1));
  reduce(s, ev({ type: "noul", purpose: "验收门禁", answer: { p: 0.9, verdict: true, confidence: 0.8 } }, 0));

  const runA = s.runs.find((r) => r.lane === 0)!;
  const runL = s.runs.find((r) => r.lane === 1)!;
  assert.equal(runA.displayCmd, "run-a");
  assert.equal(runA.noulLine !== null, true);
  assert.equal(runL.displayCmd, "run-b");
  assert.equal(runL.noulLine, null, "azir 泳道的 noul 不得串到 lyra 的卡上");
  // 工位忙闲带走属主
  assert.equal(s.partitions.find((p) => p.name === "便宜区")!.busyBy, "azir");
  assert.equal(s.partitions.find((p) => p.name === "贵区")!.busyBy, "lyra");

  // lyra 完工 → 只熄 lyra
  reduce(s, { type: "owned-finish", outcome: mkOutcome({ dispatchId: 2, partition: partitions[1]! }), lane: 1 });
  assert.equal(s.managers.find((m) => m.name === "lyra")!.busy, false);
  assert.equal(s.managers.find((m) => m.name === "azir")!.busy, true, "azir 还在跑");
  assert.equal(s.partitions.find((p) => p.name === "贵区")!.busy, false);
  assert.equal(s.partitions.find((p) => p.name === "便宜区")!.busy, true);
});

/* ------------------------------ 5. 角色条渲染 ------------------------------ */

test("角色条：老板/经理花名册/顾问，忙闲与咨询中", () => {
  const s = mkInitialState({
    managerName: "azir",
    backendLabel: "fake",
    threshold: 0.7,
    partitions,
    baselineName: "贵区",
    managers: ["azir", "lyra"],
    advisorName: "sage",
  });
  const body0 = renderFrame(s, 100, 30, Date.now()).map(stripAnsi).join("\n");
  for (const anchor of ["你", "老板", "azir", "lyra", "顾问", "sage"]) {
    assert.ok(body0.includes(anchor), `角色条缺 ${anchor}`);
  }

  // lyra 接单 → 角色条上 lyra 忙、azir 闲
  reduce(s, { type: "owned-start", briefFile: "b.json", nowMs: 1, lane: 1, manager: "lyra" });
  const roleLine1 = renderFrame(s, 100, 30, Date.now())
    .map(stripAnsi)
    .find((l) => l.includes("老板"))!;
  assert.match(roleLine1, /lyra ●跑#\d+/);
  assert.match(roleLine1, /azir 空闲/);

  // 顾问事件瞬间点亮"咨询中"；泳道下一事件熄灭
  reduce(s, { type: "advisor", advisor: "sage", question: "问", answer: { p: 0.8, verdict: true, confidence: 0.7 }, lane: 1 });
  const roleLine2 = renderFrame(s, 100, 30, Date.now())
    .map(stripAnsi)
    .find((l) => l.includes("老板"))!;
  assert.ok(roleLine2.includes("咨询中"), "顾问应答瞬间应显示咨询中");
  reduce(s, { type: "owned-finish", outcome: mkOutcome({}), lane: 1 });
  const roleLine3 = renderFrame(s, 100, 30, Date.now())
    .map(stripAnsi)
    .find((l) => l.includes("老板"))!;
  assert.ok(!roleLine3.includes("咨询中"), "泳道推进后顾问恢复空闲");

  // 工位状态行属主标签
  reduce(s, { type: "command", partition: partitions[1]!, displayCmd: "x", lane: 0 });
  const body4 = renderFrame(s, 100, 30, Date.now()).map(stripAnsi).join("\n");
  assert.ok(body4.includes("azir"), "工位忙时应标注承办经理");
});

/* ------------------------------ 6. .cast 录屏格式 ------------------------------ */

test(".cast：asciinema v2 header + 顺序帧", async () => {
  const f = path.join(dir, "rec.cast");
  const cast = openCast(f, 96, 30);
  cast.write(0, "frame-a");
  cast.write(0.25, "frame-b\x1b[K");
  await cast.close();

  const lines = fs.readFileSync(f, "utf8").trim().split("\n");
  assert.equal(lines.length, 3, "header + 两帧");
  const hdr = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(hdr["version"], 2);
  assert.equal(hdr["width"], 96);
  assert.equal(hdr["height"], 30);
  assert.equal(typeof hdr["timestamp"], "number");
  const e0 = JSON.parse(lines[1]!) as [number, string, string];
  const e1 = JSON.parse(lines[2]!) as [number, string, string];
  assert.equal(e0[1], "o");
  assert.equal(e0[2], "frame-a");
  assert.equal(e1[2], "frame-b\x1b[K");
  assert.ok(e0[0] <= e1[0], "帧时间戳应单调不减");
});
