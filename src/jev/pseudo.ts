/**
 * 伪 JEV：无 API Key 可跑的 TF-IDF 本地判断器。
 *
 * choice：把 state 与每个候选的"名称+说明"分别做 TF-IDF 向量，cosine 相似度
 *         为 logits，softmax（温度固定）得概率分布。完全确定性：同一输入同一分布。
 * noul ： state 中命中 true/false 侧关键词的比例差 → sigmoid。
 * score： 用档次说明文本与 state 的相似度分布。
 *
 * 置信度与真后端共用同一公式 1 − H(p)/lnK（见 confidence.ts），
 * 这样演示里"把握度 vs 把握线"的语义与真实 OpenJev 完全一致。
 */
import type {
  ChoiceAnswer,
  JudgmentMeta,
  NoulAnswer,
  ScoreAnswer,
} from "../core/types.ts";
import { confidenceOf, normalized } from "./confidence.ts";
import type {
  AnswerWithMeta,
  ChoiceQuestion,
  NoulQuestion,
  ScoreQuestion,
  SystemOneClient,
} from "./client.ts";

/** softmax 温度与增益：cos ∈ [0,1] 需放大才能有区分度而不饱和 */
const TEMPERATURE = 0.35;
const GAIN = 12;

/** 估算 token 数（记账用）：英文单词数 + 中文字符数，按 ~0.75 token/词、1 token/字 */
function estimateTokens(text: string): number {
  const asciiWords = (text.match(/[a-zA-Z0-9]+/g) ?? []).length;
  const cjk = (text.match(/[一-鿿]/g) ?? []).length;
  return Math.ceil(asciiWords / 0.75 + cjk);
}

/** ASCII 小写按词切；CJK 按字符二元组切（中文无空格，bigram 有区分度） */
function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const words = lower.match(/[a-z0-9_./-]+/g) ?? [];
  const cjkChars = lower.match(/[一-鿿]/g) ?? [];
  const bigrams: string[] = [];
  for (let i = 0; i < cjkChars.length - 1; i++) {
    bigrams.push(cjkChars[i]! + cjkChars[i + 1]!);
  }
  return [...words, ...bigrams];
}

type Vec = Map<string, number>;

/** 对数词频 TF */
function tf(tokens: string[]): Vec {
  const v: Vec = new Map();
  for (const t of tokens) v.set(t, (v.get(t) ?? 0) + 1);
  for (const [t, c] of v) v.set(t, 1 + Math.log(c));
  return v;
}

/** 在候选语料上算 IDF：独有词（如某个分区专属的"代码审查"）大幅加权，共有词近乎无效 */
function idfMap(docs: Vec[]): Map<string, number> {
  const n = docs.length;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const m = new Map<string, number>();
  for (const [t, c] of df) m.set(t, Math.log((n + 1) / c) + 1);
  return m;
}

/** 一侧向量做 TF×IDF 加权 */
function applyIdf(v: Vec, idf: Map<string, number>): Vec {
  for (const [t, x] of v) v.set(t, x * (idf.get(t) ?? 1));
  return v;
}

function cosine(a: Vec, b: Vec): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [, x] of a) na += x * x;
  for (const [, y] of b) nb += y * y;
  if (na === 0 || nb === 0) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const [t, x] of small) {
    const y = big.get(t);
    if (y !== undefined) dot += x * y;
  }
  return dot / Math.sqrt(na * nb);
}

function softmax(logits: number[], temperature: number): number[] {
  const m = Math.max(...logits);
  const exps = logits.map((l) => Math.exp((l - m) / temperature));
  const s = exps.reduce((a, b) => a + b, 0);
  return s > 0 ? exps.map((e) => e / s) : logits.map(() => 1 / logits.length);
}

export class PseudoSystemOneClient implements SystemOneClient {
  readonly backend = "pseudo" as const;
  readonly label = "pseudo-tfidf";

  /** 简易延迟模型：模拟真后端 70–500ms 的量级感，但保持测试快 */
  private readonly simulatedLatencyMs: number;
  constructor(opts: { simulatedLatencyMs?: number } = {}) {
    this.simulatedLatencyMs = Math.max(0, opts.simulatedLatencyMs ?? 0);
  }

  async choice(
    state: string,
    q: ChoiceQuestion,
  ): Promise<AnswerWithMeta<ChoiceAnswer>> {
    const t0 = performance.now();
    const stateVecRaw = tf(tokenize(state));
    const names = Object.keys(q.criteria);
    const candidateVecs = names.map((n) => tf(tokenize(`${n} ${q.criteria[n]}`)));
    const idf = idfMap(candidateVecs);
    const stateVec = applyIdf(stateVecRaw, idf);
    candidateVecs.forEach((v) => applyIdf(v, idf));
    const logits = candidateVecs.map((v) => cosine(stateVec, v) * GAIN);
    const probs = softmax(logits, TEMPERATURE);
    const distribution = Object.fromEntries(names.map((n, i) => [n, probs[i]!]));
    const choice = names[probs.indexOf(Math.max(...probs))]!;
    if (this.simulatedLatencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.simulatedLatencyMs));
    }
    return {
      answer: {
        choice,
        distribution,
        confidence: confidenceOf(probs),
      },
      meta: this.meta(state, t0),
    };
  }

  async noul(state: string, q: NoulQuestion): Promise<AnswerWithMeta<NoulAnswer>> {
    const t0 = performance.now();
    const stateTokens = new Set(tokenize(state));
    const trueTokens = tokenize(q.criteria?.true ?? "");
    const falseTokens = tokenize(q.criteria?.false ?? "");
    const hit = (cands: string[]) =>
      cands.filter((t) => stateTokens.has(t)).length;
    const tHits = 1 + hit(trueTokens); // Laplace 平滑
    const fHits = 1 + hit(falseTokens);
    const p = tHits / (tHits + fHits);
    if (this.simulatedLatencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.simulatedLatencyMs));
    }
    return {
      answer: {
        p,
        verdict: p >= 0.5,
        confidence: confidenceOf([
          p,
          1 - p,
        ]),
      },
      meta: this.meta(state, t0),
    };
  }

  async score(state: string, q: ScoreQuestion): Promise<AnswerWithMeta<ScoreAnswer>> {
    const t0 = performance.now();
    const stateVec = tf(tokenize(state));
    const logits = q.legend.map((l) => cosine(stateVec, tf(tokenize(l))));
    const probs = normalized(softmax(logits, TEMPERATURE));
    const score = probs.reduce((acc, p, i) => acc + i * p, 0);
    if (this.simulatedLatencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.simulatedLatencyMs));
    }
    return {
      answer: {
        score,
        legend: q.legend,
        distribution: probs,
        confidence: confidenceOf(probs),
      },
      meta: this.meta(state, t0),
    };
  }

  private meta(state: string, t0: number): JudgmentMeta {
    return {
      backend: "pseudo",
      latencyMs: performance.now() - t0,
      inputTokens: estimateTokens(state),
      outputTokens: 0,
    };
  }
}
