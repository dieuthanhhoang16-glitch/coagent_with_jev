/**
 * 把握度（置信度）统一公式：confidence = 1 − H(p)/lnK
 * H(p) 是香农熵（自然对数），K 是候选数。
 * K=1 时约定 1（别无选择）；均匀分布 → 0；δ 分布 → 1。
 * 与 OpenJev 服务端返回的 confidence 是同一公式。
 */
export function confidenceOf(probs: readonly number[]): number {
  const k = probs.length;
  if (k <= 1) return 1;
  let h = 0;
  for (const p of probs) {
    if (p > 0) h -= p * Math.log(p);
  }
  const c = 1 - h / Math.log(k);
  // 数值噪声保护：均匀分布时理论上恰为 0
  return Math.min(1, Math.max(0, c));
}

/** 归一化：容忍后端返回的概率之和小于/超过 1 的浮点误差 */
export function normalized(values: readonly number[]): number[] {
  const sum = values.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    const u = 1 / values.length;
    return values.map(() => u);
  }
  return values.map((v) => v / sum);
}
