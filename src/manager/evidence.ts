/**
 * 执行证据解析（spec FR-3）：从结果文件里抽出"运行过的命令 + 结论"条目。
 *
 * 结果文件约定（prompt 模板会要求执行者遵守）：文件末尾有一个
 * "## 执行证据"（或 "## Execution Evidence"）小节，里面每条证据形如：
 *
 *   - `find refs -type f -name '*.md' | wc -l` → 统计到 58 个 Markdown 文件
 *
 * 解析策略三级回退，永远返回至少一条（不会空手）：
 *   1) 约定小节里的 `- \`cmd\` → conclusion` 行（任意分隔符：→ / -> / :)
 *   2) 任一 ```bash / ```sh / ```console 代码块的完整内容（结论=紧随其后的一行文字）
 *   3) 全文压缩成一条 raw 证据（结论取首个非空行）
 */
import type { EvidenceItem } from "../core/types.ts";

const SECTION_RE = /^#{1,3}\s*(执行证据|Execution Evidence|Evidence)\s*$/im;
const ITEM_RE = /^\s*[-*]\s*`([^`]+)`\s*(?:→|->|⇒|:：?|：)\s*(.+?)\s*$/;
const FENCE_RE = /```(?:bash|sh|console|shell)\n([\s\S]*?)```/g;

export function parseEvidence(resultText: string): EvidenceItem[] {
  // 第 1 级：约定小节
  const lines = resultText.split(/\r?\n/);
  let inSection = false;
  const out: EvidenceItem[] = [];
  for (const line of lines) {
    if (SECTION_RE.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^#{1,3}\s/.test(line)) break; // 下一个标题，小节结束
    if (!inSection) continue;
    const m = ITEM_RE.exec(line);
    if (m) out.push({ command: m[1]!, conclusion: m[2]! });
  }
  if (out.length > 0) return out;

  // 第 2 级：bash/sh 代码块 + 块后首个非空行作为结论
  const fenced: EvidenceItem[] = [];
  for (const m of resultText.matchAll(FENCE_RE)) {
    const idx = m.index + m[0].length;
    const after = resultText
      .slice(idx)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("```"));
    fenced.push({
      command: m[1]!.trim().replace(/\s*\n\s*/g, " && "),
      conclusion: after ?? "（无文字结论）",
    });
  }
  if (fenced.length > 0) return fenced;

  // 第 3 级：raw
  const firstLine = resultText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return [
    {
      command: "（结果文件未按证据格式书写）",
      conclusion: firstLine ?? "（空文件）",
    },
  ];
}

/** 把证据压成一小段喂给 noul 门禁的 state（控制长度） */
export function evidenceDigest(items: EvidenceItem[], maxChars = 800): string {
  const digest = items
    .map((e, i) => `${i + 1}. ${e.command} → ${e.conclusion}`)
    .join("\n");
  return digest.length <= maxChars ? digest : digest.slice(0, maxChars - 1) + "…";
}
