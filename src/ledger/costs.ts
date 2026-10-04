/**
 * 成本账目（spec FR-4）：
 *   实际花费 = Σ_executor tokens × 该分区单价 + Σ_JEV 判断 tokens × JEV 单价
 *   对照花费 = Σ_executor tokens × 最贵分区单价（"如果全部用最贵模型"）
 *   节省    = 对照 − 实际
 *
 * 纯正函数，无 IO——省 $X 的数字与 SQLite 落库前的中间态必须可单测。
 */
import type { Partition } from "../core/types.ts";

export interface UsageInput {
  tokenUsage: number; // 归到输入价的 token 数（JEV 输出免费，故只算输入）
  cachedUncounted?: number;
}

/** 单个分区的执行成本 */
export function executorCost(
  partition: Pick<Partition, "priceInPer1M" | "priceOutPer1M">,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (inputTokens * partition.priceInPer1M) / 1_000_000 +
    (outputTokens * partition.priceOutPer1M) / 1_000_000
  );
}

/** 全用最贵模型时的同样 token 量对照成本 */
export function baselineCost(
  mostExpensiveIn: number,
  mostExpensiveOut: number,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (inputTokens * mostExpensiveIn) / 1_000_000 +
    (outputTokens * mostExpensiveOut) / 1_000_000
  );
}

/** JEV 判断本身的成本（输入一口价；输出免费） */
export function jevCost(priceInPer1M: number, inputTokens: number): number {
  return (inputTokens * priceInPer1M) / 1_000_000;
}

export interface DispatchCost {
  costUsd: number;
  baselineUsd: number;
  jevUsd: number;
  savingsUsd: number;
  executorUsd: number;
}

/**
 * 一次派发的总账：执行成本 + 本次派发内全部 JEV 判断成本 vs 最贵对照。
 * mostExpensive 由调用方从分区表算出传入。
 */
export function dispatchCost(args: {
  partition: Pick<Partition, "priceInPer1M" | "priceOutPer1M">;
  inputTokens: number;
  outputTokens: number;
  jevInputTokensTotal: number;
  jevPriceInPer1M: number;
  mostExpensiveIn: number;
  mostExpensiveOut: number;
}): DispatchCost {
  const executorUsd = executorCost(args.partition, args.inputTokens, args.outputTokens);
  const jevUsd = jevCost(args.jevPriceInPer1M, args.jevInputTokensTotal);
  const costUsd = executorUsd + jevUsd;
  const baselineUsd =
    baselineCost(
      args.mostExpensiveIn,
      args.mostExpensiveOut,
      args.inputTokens,
      args.outputTokens,
    ) + jevUsd; // JEV 判断在"全用最贵模型"世界里同样存在，两边相抵，保留实际侧如实显示
  return {
    costUsd,
    baselineUsd,
    jevUsd,
    executorUsd,
    savingsUsd: baselineUsd - costUsd,
  };
}

export function fmtUsd(v: number): string {
  if (v === 0) return "$0";
  const abs = Math.abs(v);
  if (abs < 0.0001) return `$${v.toExponential(2)}`;
  return `$${v.toFixed(abs < 0.01 ? 5 : abs < 1 ? 4 : 2)}`;
}
