/**
 * 工程经理（M1 单实例，默认名 azir）：
 *   读任务书 → JEV choice 路由 → 四态判定 → 派发执行器
 *   → 等结果文件 → 解析证据 → noul 验收门禁 → (可选) score
 *   → 成本落账。全程经 emit 上报事件，CLI/TUI 各自渲染。
 *
 * 验收失败时的改派：再问一次 noul"要改派到其他分区吗？"，从
 * 同一分布里取剩余最优，最多 maxRedispatches 次。
 */
import path from "node:path";
import { writeFileSync } from "node:fs";
import type {
  DispatchState,
  ExecutionResult,
  JudgmentMeta,
  NoulAnswer,
  OfficeConfig,
  Partition,
  RoutingDecision,
  TaskBrief,
} from "../core/types.ts";
import { briefToState, loadBrief } from "../core/brief.ts";
import { mostExpensive } from "../core/partitions.ts";
import { decide, nextBest } from "../router/states.ts";
import type { Ledger } from "../ledger/sqlite.ts";
import { dispatchCost, type DispatchCost } from "../ledger/costs.ts";
import type { SystemOneClient } from "../jev/client.ts";
import {
  buildTaskPrompt,
  collectResult,
  expandArgv,
  expandForSpawn,
  prepareRunDir,
  spawnExecutor,
} from "./executor.ts";
import { evidenceDigest } from "./evidence.ts";

export type ManagerEvent =
  | { type: "choice"; question: string; distribution: Record<string, number>; confidence: number; latencyMs: number; backend: string }
  | { type: "decision"; decision: RoutingDecision; confidence: number; threshold: number }
  | { type: "command"; partition: Partition; displayCmd: string }
  | { type: "executed"; result: ExecutionResult }
  | { type: "evidence"; items: ExecutionResult["evidence"] }
  | { type: "noul"; purpose: string; answer: NoulAnswer }
  | { type: "redispatch"; fromPartition: string; toPartition: string; reason: string }
  | { type: "score"; score: number; legend: string[] };

export interface DispatchOutcome {
  state: DispatchState;
  dispatchId: number;
  brief: TaskBrief;
  decision: RoutingDecision;
  distribution: Record<string, number>;
  confidence: number;
  partition: Partition | null;
  result: ExecutionResult | null;
  noulPassed: boolean | null;
  scoreValue: number | null;
  cost: DispatchCost | null;
  redispatchIds: number[];
}

export interface DispatchDeps {
  config: OfficeConfig;
  partitions: Partition[];
  ledger: Ledger;
  client: SystemOneClient;
  emit: (e: ManagerEvent) => void;
  /** 派发前确认执行命令；return false 则升级为"需要你"停住。缺省=直接执行 */
  confirmCommand?: (displayCmd: string, partition: Partition) => Promise<boolean>;
}

export async function runDispatch(
  deps: DispatchDeps,
  opts: {
    briefFile: string;
    onUncertain?: "escalate" | "proceed";
    withScore?: boolean;
    redispatchOf?: number | null;
    parentDistribution?: Record<string, number> | null; // 改派时复用上轮分布
    excludePartitions?: ReadonlySet<string>;
  },
): Promise<DispatchOutcome> {
  const { config, partitions, ledger, client, emit } = deps;
  const j = config.jev;
  const { brief, briefPath } = loadBrief(opts.briefFile);
  const state = briefToState(brief);
  const workdir = brief.workdir ?? process.cwd();
  const maxExp = mostExpensive(partitions);
  let jevInputTokens = 0;

  const dispatchId = ledger.startDispatch({
    briefTitle: brief.title,
    briefFile: briefPath,
    manager: config.managerName,
    state: "dispatched",
    partition: null,
    redispatchOf: opts.redispatchOf ?? null,
  });

  const tally = (meta: JudgmentMeta) => {
    jevInputTokens += meta.inputTokens;
  };

  // ---------- FR-1: JEV choice 路由 ----------
  const filtered = partitions.filter(
    (p) => !(opts.excludePartitions?.has(p.name) ?? false),
  );
  if (filtered.length === 0) {
    ledger.finishDispatch(dispatchId, { state: "failed" });
    throw new Error("没有可用分区（全部已被排除）");
  }
  const criteria = Object.fromEntries(filtered.map((p) => [p.name, p.specialties]));
  const question = "这个任务派给哪个型号分区最合适？";
  let distribution: Record<string, number>;
  let confidence: number;
  let choiceMeta: JudgmentMeta | null = null;
  if (opts.parentDistribution) {
    distribution = opts.parentDistribution;
    confidence = 0; // 改派沿用旧分布，置信度仅作展示
  } else {
    const { answer, meta } = await client.choice(state, { instructions: question, criteria });
    tally(meta);
    choiceMeta = meta;
    distribution = answer.distribution;
    confidence = answer.confidence;
  }
  const decision = decide(distribution, confidence, {
    confidenceThreshold: j.confidenceThreshold,
    unsureThreshold: j.unsureThreshold,
    handBackEpsilon: j.handBackEpsilon,
  });
  if (!opts.parentDistribution) {
    ledger.insertJudgment({
      dispatchId,
      primitive: "choice",
      backend: client.backend,
      question,
      state,
      candidates: JSON.stringify(Object.keys(criteria)),
      distribution: JSON.stringify(distribution),
      confidence,
      threshold: j.confidenceThreshold,
      action: decision.state,
      latencyMs: choiceMeta?.latencyMs ?? 0,
      inputTokens: choiceMeta?.inputTokens ?? 0,
      outputTokens: choiceMeta?.outputTokens ?? 0,
    });
  }
  emit({
    type: "choice",
    question,
    distribution,
    confidence,
    latencyMs: choiceMeta?.latencyMs ?? 0,
    backend: client.backend,
  });
  emit({ type: "decision", decision, confidence, threshold: j.confidenceThreshold });

  const finishAs = (s: DispatchState, extra: Parameters<Ledger["finishDispatch"]>[1] = {}) =>
    ledger.finishDispatch(dispatchId, { state: s, ...extra });

  // ---------- 四态分流 ----------
  if (decision.state === "hand-back" || decision.state === "need-you") {
    finishAs(decision.state);
    return {
      state: decision.state,
      dispatchId,
      brief,
      decision,
      distribution,
      confidence,
      partition: null,
      result: null,
      noulPassed: null,
      scoreValue: null,
      cost: null,
      redispatchIds: [],
    };
  }
  const policy = opts.onUncertain ?? config.onUncertain;
  if (decision.state === "unsure" && policy === "escalate") {
    finishAs("need-you");
    return {
      state: "need-you",
      dispatchId,
      brief,
      decision: { ...decision, state: "need-you", reason: `${decision.reason}（策略 escalate：升级为"需要你"）` },
      distribution,
      confidence,
      partition: null,
      result: null,
      noulPassed: null,
      scoreValue: null,
      cost: null,
      redispatchIds: [],
    };
  }

  let partition = filtered.find((p) => p.name === decision.picked);
  if (!partition) {
    finishAs("failed");
    throw new Error(`JEV 选中分区 ${decision.picked} 不在配置里`);
  }

  // ---------- 高危任务 noul 门禁（派发前） ----------
  if (brief.highRisk) {
    const gateQ = "该任务被标记为高危（可能删除/改写/联网写入数据）。是否允许继续派发？";
    const { answer, meta } = await client.noul(state, {
      instructions: gateQ,
      criteria: { true: "任务范围明确、伤害面可控", false: "可能造成不可逆损失" },
    });
    tally(meta);
    ledger.insertJudgment({
      dispatchId,
      primitive: "noul",
      backend: client.backend,
      question: gateQ,
      state,
      candidates: JSON.stringify(["true", "false"]),
      distribution: JSON.stringify({ true: answer.p, false: 1 - answer.p }),
      confidence: answer.confidence,
      threshold: 0.7,
      action: answer.p >= 0.7 ? "yes" : "no",
      latencyMs: meta.latencyMs,
      inputTokens: meta.inputTokens,
      outputTokens: meta.outputTokens,
    });
    emit({ type: "noul", purpose: "高危门禁", answer });
    if (answer.p < 0.7) {
      finishAs("need-you");
      return {
        state: "need-you",
        dispatchId,
        brief,
        decision: { state: "need-you", reason: `高危门禁未过（P(允许)=${answer.p.toFixed(2)} < 0.70），需要你人工放行`, picked: null },
        distribution,
        confidence,
        partition,
        result: null,
        noulPassed: null,
        scoreValue: null,
        cost: null,
        redispatchIds: [],
      };
    }
  }

  // ---------- 派发循环（含改派） ----------
  const tried = new Set<string>(opts.excludePartitions ?? []);
  const redispatchIds: number[] = [];
  let result: ExecutionResult | null = null;
  let noulPassed: boolean | null = null;
  let lastNoulP: number | null = null;
  let scoreValue: number | null = null;
  let cost: DispatchCost | null = null;
  let attempt = 0;

  while (attempt <= config.maxRedispatches) {
    attempt += 1;
    tried.add(partition.name);
    const paths = prepareRunDir(config.runsDir, dispatchId, attempt);
    const prompt = buildTaskPrompt(brief, paths.resultFile);
    writeFileSync(paths.promptFile, prompt, "utf8");
    const vars = {
      promptFile: paths.promptFile,
      briefFile: briefPath,
      resultFile: paths.resultFile,
      workdir,
    };
    const argv = expandForSpawn(partition.executor, vars);
    // 展示给老板看的命令与真实执行一致（prompt 很长则截断展示）
    const displayCmd = expandArgv(partition.executor, {
      ...vars,
      prompt: `{${partition.name} 执行者收到任务书}`,
    })
      .map((a) => (a.length > 160 ? a.slice(0, 157) + "…" : a))
      .join(" ");
    emit({ type: "command", partition, displayCmd });

    if (deps.confirmCommand && !(await deps.confirmCommand(displayCmd, partition))) {
      finishAs("need-you", { partition: partition.name, executorCmd: displayCmd });
      return {
        state: "need-you",
        dispatchId,
        brief,
        decision: { state: "need-you", reason: "老板取消了执行命令", picked: null },
        distribution,
        confidence,
        partition,
        result: null,
        noulPassed: null,
        scoreValue: null,
        cost: null,
        redispatchIds,
      };
    }

    const run = spawnExecutor({
      argv,
      workdir,
      stdoutLog: paths.stdoutLog,
      stderrLog: paths.stderrLog,
      timeoutMs: partition.executor.timeoutMs ?? 600_000,
    });
    const finished = await run.promise;
    result = collectResult(finished, partition.executor, paths, prompt);
    emit({ type: "executed", result });
    emit({ type: "evidence", items: result.evidence });

    if (result.exitCode !== 0 && result.resultText.length === 0) {
      noulPassed = false;
    } else {
      // ---------- FR-3: noul 验收门禁 ----------
      const gateState =
        `任务书：${brief.title}\n验收标准：${brief.acceptance.join("；")}\n` +
        `执行证据：\n${evidenceDigest(result.evidence)}\n` +
        `结果文件（节选）：${result.resultText.slice(0, 1200)}`;
      const gateQ = "结果文件是否真的满足任务书的全部验收标准？";
      const { answer, meta } = await client.noul(gateState, {
        instructions: gateQ,
        criteria: { true: "满足验收标准", false: "不满足或证据不足" },
      });
      tally(meta);
      lastNoulP = answer.p;
      noulPassed = answer.p >= 0.5 && result.exitCode === 0;
      ledger.insertJudgment({
        dispatchId,
        primitive: "noul",
        backend: client.backend,
        question: gateQ,
        state: gateState,
        candidates: JSON.stringify(["true", "false"]),
        distribution: JSON.stringify({ true: answer.p, false: 1 - answer.p }),
        confidence: answer.confidence,
        threshold: 0.5,
        action: noulPassed ? "yes" : "no",
        latencyMs: meta.latencyMs,
        inputTokens: meta.inputTokens,
        outputTokens: meta.outputTokens,
      });
      emit({ type: "noul", purpose: "验收门禁", answer });
    }

    if (noulPassed) break;

    // ---------- 失败 → 问 noul 是否改派 ----------
    if (attempt > config.maxRedispatches) break;
    const altNames = filtered.map((p) => p.name).filter((n) => !tried.has(n));
    if (altNames.length === 0) break;
    const rq = `执行者在 ${partition.name} 出的结果未通过验收。是否应改派到其他分区重试？`;
    const { answer: ra, meta: rm } = await client.noul(state, {
      instructions: rq,
      criteria: { true: "换一个更适合该任务的分区", false: "放弃这个任务" },
    });
    tally(rm);
    ledger.insertJudgment({
      dispatchId,
      primitive: "noul",
      backend: client.backend,
      question: rq,
      state,
      candidates: JSON.stringify(["true", "false"]),
      distribution: JSON.stringify({ true: ra.p, false: 1 - ra.p }),
      confidence: ra.confidence,
      threshold: 0.5,
      action: ra.verdict ? "yes" : "no",
      latencyMs: rm.latencyMs,
      inputTokens: rm.inputTokens,
      outputTokens: rm.outputTokens,
    });
    emit({ type: "noul", purpose: "改派判断", answer: ra });
    if (!ra.verdict) break;
    const next = nextBest(distribution, tried);
    if (!next) break;
    const np = filtered.find((p) => p.name === next);
    if (!np) break;
    emit({ type: "redispatch", fromPartition: partition.name, toPartition: np.name, reason: `验收未过，JEV 建议改派（P=${ra.p.toFixed(2)}）` });
    partition = np;
  }

  // ---------- 可选 score ----------
  if (noulPassed && opts.withScore) {
    const sq = "按完成质量给这次执行打分（1=不可用，5=完美满足验收标准）";
    const { answer } = await client.score(state, {
      instructions: sq,
      legend: ["1 不可用", "2 差", "3 可用", "4 好", "5 完美"],
    });
    scoreValue = Math.round(answer.score) + 1;
    ledger.insertJudgment({
      dispatchId,
      primitive: "score",
      backend: client.backend,
      question: sq,
      state,
      candidates: JSON.stringify(answer.legend),
      distribution: JSON.stringify(answer.distribution),
      confidence: answer.confidence,
      threshold: 0,
      action: "scored",
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    emit({ type: "score", score: scoreValue, legend: answer.legend });
  }

  // ---------- 成本落账 ----------
  const finalState: DispatchState = noulPassed ? "done" : "failed";
  if (result) {
    cost = dispatchCost({
      partition,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      jevInputTokensTotal: jevInputTokens,
      jevPriceInPer1M: j.priceInPer1M,
      mostExpensiveIn: maxExp.inPer1M,
      mostExpensiveOut: maxExp.outPer1M,
    });
    ledger.insertCost({
      dispatchId,
      partition: partition.name,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: cost.executorUsd + cost.jevUsd,
      baselineUsd: cost.baselineUsd,
    });
  }
  finishAs(finalState, {
    partition: partition.name,
    executorCmd: partition.executor.command
      .map((a) => (a.length > 60 ? a.slice(0, 57) + "…" : a))
      .join(" "),
    resultFile: result?.resultFile ?? null,
    noulP: lastNoulP,
    noulPassed,
    score: scoreValue,
  });

  return {
    state: finalState,
    dispatchId,
    brief,
    decision,
    distribution,
    confidence,
    partition,
    result,
    noulPassed,
    scoreValue,
    cost,
    redispatchIds,
  };
}
