/**
 * 终端显示宽度工具：CJK/emoji 双宽、ANSI 转义零宽。
 * 三栏对齐全靠它 —— 纯函数，单测对着宽度断言。
 */

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** 单字符显示宽度（wcwidth 的够用版：CJK 双宽、emoji 双宽、其余 1） */
export function charWidth(ch: string): number {
  const cp = ch.codePointAt(0)!;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || // CJK 部首→彝文
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul 音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展 B+
  ) {
    return 2;
  }
  return 1;
}

/** 字符串显示宽度（ANSI 序列不计） */
export function strWidth(s: string): number {
  let w = 0;
  const plain = s.replace(ANSI_RE, "");
  for (const ch of plain) w += charWidth(ch);
  return w;
}

export function padEndWidth(s: string, width: number): string {
  const w = strWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}

/** 按显示宽度截断；ANSI 序列原样保留不计宽；着色内容截断后补 reset 防串色 */
export function sliceToWidth(s: string, width: number): string {
  let out = "";
  let w = 0;
  let i = 0;
  while (i < s.length && w < width) {
    if (s.charCodeAt(i) === 0x1b && s[i + 1] === "[") {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(ch);
    if (w + cw > width) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  if (out.includes("\x1b[")) out += "\x1b[39m\x1b[22m";
  return out;
}

/** 截断 + 补齐到精确显示宽度 */
export function fit(s: string, width: number): string {
  return padEndWidth(sliceToWidth(s, width), width);
}
