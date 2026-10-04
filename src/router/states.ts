/**
 * 决策结果四态（spec FR-1）——图书馆里最值得引用的 40 行：
 *
 *   把握度 conf = 1 − H(p)/lnK 由 JEV（或伪 JEV）给出，这里只管判定：
 *
 *   ┌─ conf ≥ 把握线(默认 .70) ──────────────→ execute   直接执行（argmax 候选）
 *   ├─ 把握线 > conf ≥ 拿不准线(默认 .40) ────→ unsure    拿不准（顾问/继续策略）
 *   ├─ conf < 拿不准线 ───────────────────────→ need-you  需要你（升级老板）
 *   └─ max(p) < 1/K + ε 且 conf 低 ──────────→ hand-back 交回（任务书写得不清，主 Agent 重写）
 *
 * 判定次序：并列(need-you) 在 均匀容差(hand-back) 之前——
 * 两名精确打平是真实信号冲突，要老板来打破；而近均匀分布说明
 * 任务书本身没写清，应把笔还给主 Agent，而不是让老板背锅。
 */
import type { DecisionState, RoutingDecision } from "../core/types.ts";

export interface RouterThresholds {
  confidenceThreshold: number; // 把握线
  unsureThreshold: number; // 拿不准线
  handBackEpsilon: number; // 均匀分布容差 ε
}

export function decide(
  distribution: Record<string, number>,
  confidence: number,
  t: RouterThresholds,
): RoutingDecision {
  const entries = Object.entries(distribution).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    return { state: "hand-back", reason: "没有候选分区", picked: null };
  }
  const [topName, topP] = entries[0]!;
  const k = entries.length;
  const uniformLike = topP < 1 / k + t.handBackEpsilon;
  const tied = entries.length > 1 && entries[1]![1] >= topP - 1e-9;

  if (confidence >= t.confidenceThreshold) {
    return {
      state: "execute",
      picked: topName,
      reason: `把握度 ${confidence.toFixed(2)} ≥ 把握线 ${t.confidenceThreshold}`,
    };
  }
  if (tied) {
    // 精确并列在“均匀容差”之前判定：两名打平是真实信号冲突，要老板来打破
    return {
      state: "need-you",
      picked: null,
      reason: `前两名概率并列（各 ~${(topP * 100).toFixed(1)}%），需要你人工定夺`,
    };
  }
  if (uniformLike) {
    return {
      state: "hand-back",
      picked: null,
      reason: `最高概率 ${(topP * 100).toFixed(1)}% 接近均匀分布（1/${k}），任务书写法没有区分度——交回主 Agent 重新写任务书`,
    };
  }
  if (confidence < t.unsureThreshold) {
    return {
      state: "need-you",
      picked: null,
      reason: `把握度 ${confidence.toFixed(2)} < 拿不准线 ${t.unsureThreshold}，需要你人工定夺`,
    };
  }
  return {
    state: "unsure",
    picked: topName,
    reason: `把握度 ${confidence.toFixed(2)} 处于 [${t.unsureThreshold}, ${t.confidenceThreshold}) 区间，拿不准`,
  };
}

/** 除某候选外取次优（改派用） */
export function nextBest(
  distribution: Record<string, number>,
  exclude: ReadonlySet<string>,
): string | null {
  const entries = Object.entries(distribution)
    .filter(([n]) => !exclude.has(n))
    .sort((a, b) => b[1] - a[1]);
  return entries.length > 0 ? entries[0]![0] : null;
}
