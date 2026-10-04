import { test } from "node:test";
import assert from "node:assert/strict";
import { evidenceDigest, parseEvidence } from "../src/manager/evidence.ts";

test("约定小节：- `cmd` → 结论", () => {
  const text = [
    "# 结果",
    "已经统计完成。",
    "",
    "## 执行证据",
    "- `find refs -type f -name '*.md' | wc -l` → 统计到 58 个 Markdown 文件",
    "- `wc -l refs/*.md` → 总行数 232 行",
    "",
    "## 其他",
    "云",
  ].join("\n");
  const items = parseEvidence(text);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.command, "find refs -type f -name '*.md' | wc -l");
  assert.match(items[0]!.conclusion, /58 个/);
});

test("英文小节头 + '->' 分隔也可", () => {
  const text = "## Execution Evidence\n- `ls out/` -> index.html 已生成\n";
  const items = parseEvidence(text);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.command, "ls out/");
});

test("无小节时回退到 bash 代码块", () => {
  const text = "完成了。\n```bash\ncargo test --all\n```\n42 项测试全部通过。\n";
  const items = parseEvidence(text);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.command, "cargo test --all");
  assert.match(items[0]!.conclusion, /全部通过/);
});

test("啥都没有时给 raw 兜底", () => {
  const items = parseEvidence("直接写了纯文本答案，没有证据小节。");
  assert.equal(items.length, 1);
  assert.match(items[0]!.command, /未按/);
});

test("evidenceDigest 限长", () => {
  const d = evidenceDigest(
    [{ command: "x".repeat(500), conclusion: "y".repeat(500) }],
    100,
  );
  assert.ok(d.length <= 100);
});
