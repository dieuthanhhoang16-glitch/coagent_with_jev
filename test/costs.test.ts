import { test } from "node:test";
import assert from "node:assert/strict";
import {
  baselineCost,
  dispatchCost,
  executorCost,
  fmtUsd,
  jevCost,
} from "../src/ledger/costs.ts";

test("executorCost: 便宜 PK 贵分区", () => {
  // 1M in @1 + 1M out @5 = $6
  assert.equal(executorCost({ priceInPer1M: 1, priceOutPer1M: 5 }, 1_000_000, 1_000_000), 6);
  assert.equal(executorCost({ priceInPer1M: 15, priceOutPer1M: 75 }, 1_000_000, 1_000_000), 90);
});

test("baselineCost: 同样 token 全用最贵", () => {
  assert.equal(baselineCost(15, 75, 2_000_000, 500_000), 2 * 15 + 0.5 * 75);
});

test("jevCost: OpenJev $0.042/1M 输入", () => {
  assert.ok(Math.abs(jevCost(0.042, 1000) - 0.000042) < 1e-12);
});

test("dispatchCost: 节省 = 对照 − 实际，公式可复核（误差容限 <5% 的算术根）", () => {
  const c = dispatchCost({
    partition: { priceInPer1M: 1, priceOutPer1M: 5 }, // 便宜分区
    inputTokens: 50_000,
    outputTokens: 10_000,
    jevInputTokensTotal: 300,
    jevPriceInPer1M: 0.042,
    mostExpensiveIn: 15,
    mostExpensiveOut: 75,
  });
  // 执行：0.05*1 + 0.01*5 = $0.10；JEV：300*0.042/1M = $0.0000126
  assert.ok(Math.abs(c.executorUsd - 0.1) < 1e-9);
  assert.ok(Math.abs(c.jevUsd - 0.0000126) < 1e-12);
  // 对照：0.05*15 + 0.01*75 = $1.50 + 同额 JEV
  assert.ok(Math.abs(c.baselineUsd - (1.5 + c.jevUsd)) < 1e-9);
  assert.ok(Math.abs(c.savingsUsd - (c.baselineUsd - c.costUsd)) < 1e-12);
  // 展示金额与逐项计量一致（=误差 0%）
  assert.ok(Math.abs((c.baselineUsd - c.costUsd) - (1.5 - 0.1)) < 1e-9);
});

test("fmtUsd: 微额科学计数, 常见两位", () => {
  assert.equal(fmtUsd(0), "$0");
  assert.equal(fmtUsd(1.2345), "$1.23");
  assert.match(fmtUsd(0.0000126), /\$/);
});
