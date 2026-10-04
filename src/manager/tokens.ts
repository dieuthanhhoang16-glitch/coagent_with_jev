/** 共享的 token 粗估：英文单词 /0.75 + CJK 字符 /1 */
export function estimateTokens(text: string): number {
  const asciiWords = (text.match(/[a-zA-Z0-9]+/g) ?? []).length;
  const cjk = (text.match(/[一-鿿]/g) ?? []).length;
  return Math.ceil(asciiWords / 0.75 + cjk);
}
