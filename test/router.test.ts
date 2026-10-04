import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, nextBest } from "../src/router/states.ts";

const T = { confidenceThreshold: 0.7, unsureThreshold: 0.4, handBackEpsilon: 0.05 };

test("把握 ≥ 线 → 直接执行，选 argmax", () => {
  const d = decide({ A: 0.95, B: 0.03, C: 0.02 }, 0.72, T);
  assert.equal(d.state, "execute");
  assert.equal(d.picked, "A");
});

test("conf 恰在 0.70 → 直接执行（≥）", () => {
  assert.equal(decide({ A: 0.9, B: 0.1 }, 0.7, T).state, "execute");
  assert.equal(decide({ A: 0.9, B: 0.1 }, 0.6999, T).state, "unsure");
});

test("中间区间 → 拿不准（unsure 仍给出 picked 备参考）", () => {
  const d = decide({ A: 0.7, B: 0.3 }, 0.55, T);
  assert.equal(d.state, "unsure");
  assert.equal(d.picked, "A");
});

test("conf < 拿不准线 → 需要你", () => {
  const d = decide({ A: 0.6, B: 0.4 }, 0.39, T);
  assert.equal(d.state, "need-you");
});

test("并列 → 需要你", () => {
  const d = decide({ A: 0.5, B: 0.5 }, 0.5, T);
  assert.equal(d.state, "need-you");
});

test("近乎均匀 → 交回（任务书没写清）", () => {
  // K=4, max p = 0.29 < 0.25+0.05=0.30
  const d = decide({ A: 0.29, B: 0.25, C: 0.25, D: 0.21 }, 0.35, T);
  assert.equal(d.state, "hand-back");
  assert.equal(d.picked, null);
});

test("hand-back 优先于 need-you", () => {
  const d = decide({ A: 0.29, B: 0.26, C: 0.25, D: 0.2 }, 0.1, T);
  assert.equal(d.state, "hand-back");
});

test("空分布 → 交回", () => {
  assert.equal(decide({}, 0, T).state, "hand-back");
});

test("nextBest: 排除已试过的分区", () => {
  const dist = { A: 0.5, B: 0.3, C: 0.2 };
  assert.equal(nextBest(dist, new Set()), "A");
  assert.equal(nextBest(dist, new Set(["A"])), "B");
  assert.equal(nextBest(dist, new Set(["A", "B"])), "C");
  assert.equal(nextBest(dist, new Set(["A", "B", "C"])), null);
});
