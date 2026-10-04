/**
 * JEV 办公室核心类型。
 * 注意：全部类型为 erasableSyntaxOnly（Node 原生 type-stripping 兼容）——
 * 只用 interface / type union，不用 enum / parameter properties。
 */

/** JEV 三原语 */
export type Primitive = "choice" | "noul" | "score";

/** 决策结果四态 */
export type DecisionState = "execute" | "hand-back" | "unsure" | "need-you";

export const DECISION_STATES: readonly DecisionState[] = [
  "execute",
  "hand-back",
  "unsure",
  "need-you",
] as const;

export const DECISION_STATE_LABEL: Record<DecisionState, string> = {
  execute: "直接执行",
  "hand-back": "交回",
  unsure: "拿不准",
  "need-you": "需要你",
};

/** 任务书（主 Agent 产出；M1 里由老板手写 JSON） */
export interface TaskBrief {
  /** 简短标题，用于审计与展示（避免存正文原文） */
  title: string;
  /** 任务描述正文 */
  description: string;
  /** 范围：做什么 */
  scope: string[];
  /** 验收标准：noul 门禁逐条核对 */
  acceptance: string[];
  /** 约束（不得做 X、只做 Y） */
  constraints: string[];
  /** 执行器工作目录（相对 config 所在目录或绝对路径） */
  workdir?: string;
  /** 高危任务：派发前加一道 JEV noul 门禁（"是否允许继续"） */
  highRisk?: boolean;
}

/** 一次 choice 判断的结果 */
export interface ChoiceAnswer {
  choice: string;
  /** 归一化概率分布：候选名 → 概率 */
  distribution: Record<string, number>;
  /** 把握度 1 − H(p)/lnK，0..1 */
  confidence: number;
}

/** 一次 noul 判断的结果 */
export interface NoulAnswer {
  /** P(yes) */
  p: number;
  verdict: boolean;
  confidence: number;
}

/** 一次 score 判断的结果 */
export interface ScoreAnswer {
  /** 期望等级 Σ i·pᵢ（0-indexed） */
  score: number;
  legend: string[];
  distribution: number[];
  confidence: number;
}

/** 每次 JEV 判断的统一元数据（审计落库用） */
export interface JudgmentMeta {
  backend: "http" | "pseudo";
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

/** 模型分区（用户配置） */
export interface Partition {
  /** 分区名，如 "6.1 Sol" */
  name: string;
  /** 分区下的模型 id（记账/展示用） */
  model: string;
  /** 擅长工作类型文本（choice 判断里的 criteria 说明，伪 JEV 用它做语义匹配） */
  specialties: string;
  /** 每百万输入 token 价格（USD） */
  priceInPer1M: number;
  /** 每百万输出 token 价格（USD） */
  priceOutPer1M: number;
  executor: ExecutorSpec;
}

/** 执行器规格：把任务发成本机一个 shell 子进程 */
export interface ExecutorSpec {
  /**
   * argv 模板。占位符：
   *   {prompt}      内联任务 prompt（单个 argv 元素）
   *   {promptFile}  prompt 文件路径
   *   {briefFile}   任务书 JSON 路径
   *   {resultFile}  结果文件路径
   *   {workdir}     工作目录
   */
  command: string[];
  /**
   * 结果获取方式：
   *   "claude-json"  stdout 是 claude --output-format json，解析 result/usage
   *   "codex-jsonl"  stdout 是 codex --json JSONL，结果经 -o 文件，扫 token_count 事件取 usage
   *   "file"         执行器自己写 {resultFile}；token 用字符数估算
   *   "stdout"       stdout 原文即结果；token 用字符数估算
   */
  resultMode: "claude-json" | "codex-jsonl" | "file" | "stdout";
  /** 单次执行超时（毫秒），默认 600_000 */
  timeoutMs?: number;
}

/** 执行证据条目 */
export interface EvidenceItem {
  /** 执行过的命令（或动作描述） */
  command: string;
  /** 结论一句话 */
  conclusion: string;
}

/** 一次执行的产物 */
export interface ExecutionResult {
  resultFile: string;
  resultText: string;
  evidence: EvidenceItem[];
  exitCode: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  /** usage 是真实计量还是字符估算 */
  usageEstimated: boolean;
  stdoutLog: string;
  stderrLog: string;
}

/** 路由判定输出 */
export interface RoutingDecision {
  state: DecisionState;
  /** 判定依据（给人看的解释） */
  reason: string;
  /** 选中的候选（execute/unsure 时有值） */
  picked: string | null;
}

/** 一次派发（工程经理视角）的终态 */
export type DispatchState =
  | "dispatched"
  | "done"
  | "failed"
  | "hand-back"
  | "unsure"
  | "need-you";

/** 全局配置（jev-office.config.json） */
export interface OfficeConfig {
  jev: {
    /** "auto"：能连上 http 就用 http，否则回退 pseudo */
    backend: "auto" | "http" | "pseudo";
    baseUrl: string;
    apiKey: string;
    model: string;
    /** 把握线：confidence ≥ 线 → 直接执行 */
    confidenceThreshold: number;
    /** 拿不准下限：conf < 此值 → 需要你 */
    unsureThreshold: number;
    /** 均匀分布判交回的容差：max(p) < 1/K + ε */
    handBackEpsilon: number;
    timeoutMs: number;
    /** JEV 自身计费：每百万输入 token 单价（输出免费） */
    priceInPer1M: number;
  };
  partitionsFile: string;
  dbPath: string;
  runsDir: string;
  /** 工程经理实例名（M1 单实例） */
  managerName: string;
  /** 拿不准时策略：escalate=升级为"需要你"停下；proceed=选最高概率继续 */
  onUncertain: "escalate" | "proceed";
  /** 结果文件验收失败后的最大改派次数 */
  maxRedispatches: number;
}
