/**
 * 验收核心：伪 JEV 连续派发 3 个异构任务（代码审查 / 文档统计 / 前端页面），
 * 分区命中率必须与人工预期一致，且分布归一、确定性可复现。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPartitions } from "../src/core/partitions.ts";
import { loadBrief, briefToState } from "../src/core/brief.ts";
import { PseudoSystemOneClient } from "../src/jev/pseudo.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED: [string, string][] = [
  ["examples/briefs/code-review.json", "6.1 Sol"],
  ["examples/briefs/doc-stats.json", "3.2 弧光"],
  ["examples/briefs/frontend-page.json", "4.0 织造"],
];

test("3 个异构任务路由命中人工预期分区", async () => {
  const partitions = loadPartitions(path.join(ROOT, "config/partitions.example.json"));
  const client = new PseudoSystemOneClient();
  const criteria = Object.fromEntries(partitions.map((p) => [p.name, p.specialties]));

  for (const [briefRel, expected] of EXPECTED) {
    const { brief } = loadBrief(path.join(ROOT, briefRel));
    const { answer } = await client.choice(briefToState(brief), {
      instructions: "这个任务派给哪个型号分区最合适？",
      criteria,
    });
    assert.equal(answer.choice, expected, `${briefRel} 应命中 ${expected}`);
    const sum = Object.values(answer.distribution).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, "分布必须归一");
    assert.ok(answer.confidence >= 0 && answer.confidence <= 1);
    // 演示可复现性：命中分区的把握度应明显高于均匀分布水平（> 0.05）
    assert.ok(
      answer.confidence > 0.05,
      `${briefRel} 把握度过低（${answer.confidence}），说明 specialty 文本区分度不足`,
    );
  }
});

test("伪 JEV 确定性：同一输入三次结果一致", async () => {
  const partitions = loadPartitions(path.join(ROOT, "config/partitions.example.json"));
  const client = new PseudoSystemOneClient();
  const criteria = Object.fromEntries(partitions.map((p) => [p.name, p.specialties]));
  const { brief } = loadBrief(path.join(ROOT, "examples/briefs/doc-stats.json"));
  const state = briefToState(brief);
  const r1 = await client.choice(state, { instructions: "q", criteria });
  const r2 = await client.choice(state, { instructions: "q", criteria });
  const r3 = await client.choice(state, { instructions: "q", criteria });
  assert.deepEqual(r1.answer.distribution, r2.answer.distribution);
  assert.deepEqual(r2.answer.distribution, r3.answer.distribution);
});
