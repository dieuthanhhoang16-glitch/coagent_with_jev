/**
 * 极简 ANSI 颜色（零依赖）。NO_COLOR / 非 TTY 时全部返回原文。
 * UI 与业务分离：M1 的命令行打印与 M2 的 OpenTUI 面板共用纯数据函数。
 */

const enabled =
  process.env["NO_COLOR"] === undefined &&
  process.stdout !== undefined &&
  (process.stdout.isTTY || process.env["JEV_FORCE_COLOR"] === "1");

function wrap(code: number, end = 39) {
  return (s: string) => (enabled ? `[${code}m${s}[${end}m` : s);
}

export const c = {
  green: wrap(32),
  yellow: wrap(33),
  red: wrap(31),
  blue: wrap(34),
  cyan: wrap(36),
  magenta: wrap(35),
  gray: wrap(90),
  bold: (s: string) => (enabled ? `[1m${s}[22m` : s),
  dim: wrap(2, 22),
};
