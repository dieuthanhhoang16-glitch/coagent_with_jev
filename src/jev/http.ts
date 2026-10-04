/**
 * TypeSafe System One API 兼容 HTTP 客户端。
 * 线协议（与 OpenJev README 核对）：
 *   POST {baseUrl}/v1/systemone
 *   {model, state, questions: {id: {type, instructions, criteria}}}
 *   → {model, answers, usage:{input_tokens, output_tokens}}
 *   choice: answers[id] = {choice, probabilities:{name:p}, confidence}
 *   noul : answers[id] = {noul: P(yes)}
 *   score: answers[id] = {score, legend, probabilities:[p], confidence}
 *   错误：422 / 400(api_usage_error) / 401 / 403 / 429 / 529（后两者重试退避）
 * 兼容 base URL：OpenJev（Docker/MLX）、官方 Jev（api.codiv.ai 等托管）、SemIf——
 * 只改 baseUrl，不用换代码。
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

interface SystemOneResponse {
  answers: Record<string, unknown>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class HttpSystemOneClient implements SystemOneClient {
  readonly backend = "http" as const;
  readonly label: string;

  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(opts: {
    baseUrl: string;
    model: string;
    apiKey?: string;
    timeoutMs?: number;
    label?: string;
    maxRetries?: number;
  }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.model = opts.model;
    this.apiKey = opts.apiKey ?? "";
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.label = opts.label ?? `${this.baseUrl}(${this.model})`;
  }

  async choice(
    state: string,
    q: ChoiceQuestion,
  ): Promise<AnswerWithMeta<ChoiceAnswer>> {
    const { res, meta } = await this.call(state, {
      route: { type: "choice", instructions: q.instructions, criteria: q.criteria },
    });
    const a = this.unwrap(res, "route") as {
      choice: string;
      probabilities: Record<string, number>;
      confidence?: number;
    };
    if (typeof a.choice !== "string" || typeof a.probabilities !== "object") {
      throw new Error("choice 响应缺 choice/probabilities 字段");
    }
    const names = Object.keys(a.probabilities);
    const probs = normalized(names.map((n) => Number(a.probabilities[n]) || 0));
    return {
      answer: {
        choice: a.choice,
        distribution: Object.fromEntries(names.map((n, i) => [n, probs[i]!])),
        confidence:
          typeof a.confidence === "number" ? a.confidence : confidenceOf(probs),
      },
      meta,
    };
  }

  async noul(state: string, q: NoulQuestion): Promise<AnswerWithMeta<NoulAnswer>> {
    const { res, meta } = await this.call(state, {
      gate: {
        type: "noul",
        instructions: q.instructions,
        ...(q.criteria
          ? {
              criteria: {
                true: q.criteria.true ?? "是",
                false: q.criteria.false ?? "否",
              },
            }
          : {}),
      },
    });
    const a = this.unwrap(res, "gate") as { noul: number };
    if (typeof a.noul !== "number") {
      throw new Error("noul 响应缺 noul 字段");
    }
    const p = Math.min(1, Math.max(0, a.noul));
    return {
      answer: { p, verdict: p >= 0.5, confidence: confidenceOf([p, 1 - p]) },
      meta,
    };
  }

  async score(state: string, q: ScoreQuestion): Promise<AnswerWithMeta<ScoreAnswer>> {
    const { res, meta } = await this.call(state, {
      grade: { type: "score", instructions: q.instructions, criteria: q.legend },
    });
    const a = this.unwrap(res, "grade") as {
      score: number;
      legend?: string[];
      probabilities?: number[];
      confidence?: number;
    };
    if (typeof a.score !== "number") {
      throw new Error("score 响应缺 score 字段");
    }
    const probs = normalized(a.probabilities ?? []);
    return {
      answer: {
        score: a.score,
        legend: a.legend ?? q.legend,
        distribution: probs,
        confidence:
          typeof a.confidence === "number" ? a.confidence : confidenceOf(probs),
      },
      meta,
    };
  }

  /** 探测后端是否可用：GET /v1/models */
  static async probe(baseUrl: string, apiKey: string, timeoutMs = 2500): Promise<{
    ok: boolean;
    models: string[];
    error?: string;
  }> {
    try {
      const r = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) return { ok: false, models: [], error: `HTTP ${r.status}` };
      const body = (await r.json()) as { data?: { id: string }[] };
      return { ok: true, models: (body.data ?? []).map((m) => m.id) };
    } catch (err) {
      return { ok: false, models: [], error: String((err as Error).message ?? err) };
    }
  }

  private async call(
    state: string,
    questions: Record<string, unknown>,
  ): Promise<{ res: SystemOneResponse; meta: JudgmentMeta }> {
    const t0 = performance.now();
    const body = JSON.stringify({ model: this.model, state, questions });
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let r: Response;
      try {
        r = await fetch(`${this.baseUrl}/v1/systemone`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        // 网络级错误：重试
        lastErr = err as Error;
        if (attempt === this.maxRetries) break;
        await sleep(backoffMs(attempt));
        continue;
      }
      if (r.status === 429 || r.status === 529) {
        if (attempt === this.maxRetries) {
          lastErr = new Error(`后端过载 HTTP ${r.status}，重试已用尽`);
          break;
        }
        await sleep(backoffMs(attempt));
        continue;
      }
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`SystemOne HTTP ${r.status}: ${text.slice(0, 300)}`);
      }
      const res = (await r.json()) as SystemOneResponse;
      const latencyMs = performance.now() - t0;
      const meta: JudgmentMeta = {
        backend: "http",
        latencyMs,
        inputTokens: res.usage?.input_tokens ?? 0,
        outputTokens: res.usage?.output_tokens ?? 0,
      };
      return { res, meta };
    }
    throw lastErr ?? new Error("SystemOne 请求失败");
  }

  private unwrap(res: SystemOneResponse, id: string): unknown {
    const a = res.answers?.[id];
    if (a === undefined) {
      throw new Error(`SystemOne 响应缺少 answers.${id}`);
    }
    return a;
  }
}

function backoffMs(attempt: number): number {
  return 250 * 2 ** attempt + Math.floor(Math.random() * 100);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
