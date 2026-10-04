import { test } from "node:test";
import assert from "node:assert/strict";
import { confidenceOf, normalized } from "../src/jev/confidence.ts";

test("confidence: δ 分布 → 1", () => {
  assert.equal(confidenceOf([1, 0, 0]), 1);
  assert.equal(confidenceOf([0.9999, 0.0001]), 1 - (() => {
    const p = [0.9999, 0.0001];
    let h = 0;
    for (const x of p) if (x > 0) h -= x * Math.log(x);
    return h / Math.log(2);
  })());
});

test("confidence: 均匀分布 → 0", () => {
  assert.equal(confidenceOf([1 / 3, 1 / 3, 1 / 3]), 0);
  assert.equal(confidenceOf([0.5, 0.5]), 0);
});

test("confidence: 已知值 0.9/0.1 (K=2)", () => {
  const p = [0.9, 0.1];
  const h = -(0.9 * Math.log(0.9) + 0.1 * Math.log(0.1));
  assert.ok(Math.abs(confidenceOf(p) - (1 - h / Math.log(2))) < 1e-12);
  // 0.9/0.1 的把握度应 ~0.53，低于 0.70 把握线——合理：二元 90% 不算"很有把握"
  assert.ok(confidenceOf(p) < 0.7);
});

test("confidence: K=1 恒为 1", () => {
  assert.equal(confidenceOf([1]), 1);
});

test("normalized: 未归一 {A:2,B:1} → {A:2/3,B:1/3}", () => {
  const [a, b] = normalized([2, 1]);
  assert.ok(Math.abs(a! - 2 / 3) < 1e-12);
  assert.ok(Math.abs(b! - 1 / 3) < 1e-12);
});

test("normalized: 全零 → 均匀", () => {
  const r = normalized([0, 0, 0, 0]);
  assert.ok(r.every((v) => Math.abs(v - 0.25) < 1e-12));
});
