/**
 * SystemOneClient：JEV 判断的可替换接口。
 * 两个实现：
 *   - HttpSystemOneClient（OpenJev / Jev / SemIf 兼容 base URL）
 *   - PseudoSystemOneClient（TF-IDF 伪 JEV，无 Key 可跑）
 */
import type {
  ChoiceAnswer,
  JudgmentMeta,
  NoulAnswer,
  ScoreAnswer,
} from "../core/types.ts";

export interface ChoiceQuestion {
  instructions: string;
  /** 候选项：名称 → 说明 */
  criteria: Record<string, string>;
}

export interface NoulQuestion {
  instructions: string;
  /** 可选 true/false 侧说明 */
  criteria?: { true?: string; false?: string };
}

export interface ScoreQuestion {
  instructions: string;
  /** 等级说明，level0..levelN */
  legend: string[];
}

export interface AnswerWithMeta<T> {
  answer: T;
  meta: JudgmentMeta;
}

export interface SystemOneClient {
  readonly backend: "http" | "pseudo";
  readonly label: string; // 给 UI 显示的后端名，如 "OpenJev@127.0.0.1:8080(openjev-latest)"
  choice(state: string, q: ChoiceQuestion): Promise<AnswerWithMeta<ChoiceAnswer>>;
  noul(state: string, q: NoulQuestion): Promise<AnswerWithMeta<NoulAnswer>>;
  score(state: string, q: ScoreQuestion): Promise<AnswerWithMeta<ScoreAnswer>>;
}
