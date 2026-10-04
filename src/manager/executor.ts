/**
 * 执行器：把派发变成一次独立 shell 子进程，结果写结果文件（spec FR-3）。
 *
 * 占位符替换在 argv 粒度完成（不经 shell 解释，无注入面）：
 *   {prompt} {promptFile} {briefFile} {resultFile} {workdir}
 *
 * usage 适配：
 *   claude-json  — claude -p --output-format json → 解析 stdout JSON 的 result/usage
 *   codex-jsonl  — codex exec --json -o {resultFile} → 扫 stdout JSONL 的 token_count 事件
 *   file/stdout  — 无真实计量，按字符数估算（usageEstimated=true 明示）
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { ExecutionResult, ExecutorSpec, TaskBrief } from "../core/types.ts";
import { parseEvidence } from "./evidence.ts";
import { estimateTokens } from "./tokens.ts";

/** 喂给执行者的任务 prompt（含证据书写约定） */
export function buildTaskPrompt(brief: TaskBrief, resultFile: string): string {
  return [
    `你是 JEV 办公室的一名执行 Agent。请完成以下任务书，并把最终答案写到 ${resultFile}（纯文本/Markdown）。`,
    ``,
    `# 任务书：${brief.title}`,
    ``,
    brief.description,
    ``,
    `## 范围`,
    ...brief.scope.map((s) => `- ${s}`),
    ``,
    `## 验收标准（逐条必须满足）`,
    ...brief.acceptance.map((s) => `- ${s}`),
    ...(brief.constraints.length > 0
      ? [``, `## 约束`, ...brief.constraints.map((s) => `- ${s}`)]
      : []),
    ``,
    `## 输出要求`,
    `1. 先把结论写进结果文件正文。`,
    `2. 文件末尾必须有 "## 执行证据" 小节，列出你实际运行过的命令/动作与结论，每条一行：`,
    "   - `命令` → 结论一句话",
    `3. 不要写与任务无关的内容。`,
  ].join("\n");
}

export interface SpawnPaths {
  promptFile: string;
  resultFile: string;
  stdoutLog: string;
  stderrLog: string;
}

export function prepareRunDir(runsDir: string, dispatchId: number, attempt: number): SpawnPaths {
  const dir = path.join(runsDir, `${dispatchId}-${attempt}`);
  mkdirSync(dir, { recursive: true });
  return {
    promptFile: path.join(dir, "prompt.md"),
    resultFile: path.join(dir, "result.md"),
    stdoutLog: path.join(dir, "stdout.log"),
    stderrLog: path.join(dir, "stderr.log"),
  };
}

/** 把占位符展开成可见的最终 argv（打印与执行共用，保证"展示的命令=执行的命令"） */
export function expandArgv(
  spec: ExecutorSpec,
  vars: Record<string, string>,
): string[] {
  return spec.command.map((arg) =>
    arg.replace(/\{(prompt|promptFile|briefFile|resultFile|workdir)\}/g, (_m, k: string) => {
      const v = vars[k];
      return v === undefined ? `{${k}}` : v;
    }),
  );
}

/**
 * 展开含字面量 "{prompt}" 的实际值：与其把整段 prompt 内联进 argv，
 * 不如把 {prompt} 换成 promptFile 路径引用（避免超长 argv / 转义问题）。
 * 这样所有占位符在展开后都是文件路径级长度。
 */
export function expandForSpawn(
  spec: ExecutorSpec,
  vars: Record<string, string>,
): string[] {
  const v = { ...vars };
  if (spec.command.some((a) => a.includes("{prompt}"))) {
    v["prompt"] = readFileSync(vars["promptFile"]!, "utf8");
  }
  return expandArgv(spec, v);
}

export interface SpawnedRun {
  argv: string[];
  displayCmd: string;
  promise: Promise<{
    exitCode: number;
    durationMs: number;
    stdoutPath: string;
    stderrPath: string;
    timedOut: boolean;
  }>;
}

export function spawnExecutor(args: {
  argv: string[];
  workdir: string;
  stdoutLog: string;
  stderrLog: string;
  timeoutMs: number;
}): SpawnedRun {
  const displayCmd = args.argv
    .map((a) => (a.length > 120 ? a.slice(0, 117) + "…" : a))
    .join(" ");
  const promise = new Promise<{
    exitCode: number;
    durationMs: number;
    stdoutPath: string;
    stderrPath: string;
    timedOut: boolean;
  }>((resolve, reject) => {
    const t0 = performance.now();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    const child = spawn(args.argv[0]!, args.argv.slice(1), {
      cwd: args.workdir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 5_000).unref();
    }, args.timeoutMs);
    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`无法启动执行器 ${args.argv[0]}: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      writeFileSync(args.stdoutLog, Buffer.concat(stdoutChunks));
      writeFileSync(args.stderrLog, Buffer.concat(stderrChunks));
      resolve({
        exitCode: timedOut ? 124 : (code ?? 1),
        durationMs: performance.now() - t0,
        stdoutPath: args.stdoutLog,
        stderrPath: args.stderrLog,
        timedOut,
      });
    });
  });
  return { argv: args.argv, displayCmd, promise };
}

/** 按 resultMode 从一次运行抽结果与 usage */
export function collectResult(
  run: Awaited<SpawnedRun["promise"]>,
  spec: ExecutorSpec,
  paths: SpawnPaths,
  prompt: string,
): ExecutionResult {
  const stdout = readFileSync(run.stdoutPath, "utf8");
  let resultText: string;
  let inputTokens = estimateTokens(prompt);
  let outputTokens = 0;
  let usageEstimated = true;

  switch (spec.resultMode) {
    case "claude-json": {
      const parsed = tryJson(stdout);
      resultText =
        (typeof parsed?.["result"] === "string" ? parsed["result"] : null) ??
        stdout.trim();
      const u = (parsed?.["usage"] ?? {}) as Record<string, unknown>;
      const sum = (keys: string[]) =>
        keys.reduce((a, k) => a + (typeof u[k] === "number" ? (u[k] as number) : 0), 0);
      const inTok = sum([
        "input_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
      ]);
      const outTok = sum(["output_tokens"]);
      if (inTok > 0 || outTok > 0) {
        inputTokens = inTok;
        outputTokens = outTok;
        usageEstimated = false;
      }
      ensureResultFile(paths.resultFile, resultText);
      break;
    }
    case "codex-jsonl": {
      const usage = scanCodexJsonl(stdout);
      if (usage) {
        inputTokens = usage.inputTokens;
        outputTokens = usage.outputTokens;
        usageEstimated = false;
      }
      resultText = existsSync(paths.resultFile)
        ? readFileSync(paths.resultFile, "utf8")
        : lastTextEvent(stdout) ?? stdout.trim();
      ensureResultFile(paths.resultFile, resultText);
      break;
    }
    case "file": {
      resultText = existsSync(paths.resultFile)
        ? readFileSync(paths.resultFile, "utf8")
        : "";
      outputTokens = estimateTokens(resultText);
      break;
    }
    case "stdout": {
      resultText = stdout.trim();
      outputTokens = estimateTokens(resultText);
      ensureResultFile(paths.resultFile, resultText);
      break;
    }
  }
  if (usageEstimated) {
    outputTokens = outputTokens || estimateTokens(resultText);
  }
  return {
    resultFile: paths.resultFile,
    resultText,
    evidence: parseEvidence(resultText),
    exitCode: run.exitCode,
    durationMs: run.durationMs,
    inputTokens,
    outputTokens,
    usageEstimated,
    stdoutLog: run.stdoutPath,
    stderrLog: run.stderrPath,
  };
}

function ensureResultFile(file: string, text: string): void {
  if (!existsSync(file)) writeFileSync(file, text, "utf8");
}

function tryJson(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** codex exec --json 的 JSONL 事件流里，最后的 token_count 事件是累计用量 */
function scanCodexJsonl(stdout: string): { inputTokens: number; outputTokens: number } | null {
  let found: { inputTokens: number; outputTokens: number } | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    const j = tryJson(t);
    if (!j) continue;
    const msg = (j["msg"] ?? j) as Record<string, unknown>;
    if (msg["type"] !== "token_count") continue;
    const info = (msg["info"] ?? {}) as Record<string, unknown>;
    const total = (info["total_token_usage"] ?? info) as Record<string, unknown>;
    const inT = typeof total["input_tokens"] === "number" ? (total["input_tokens"] as number) : 0;
    const outT = typeof total["output_tokens"] === "number" ? (total["output_tokens"] as number) : 0;
    if (inT > 0 || outT > 0) found = { inputTokens: inT, outputTokens: outT };
  }
  return found;
}

/** codex JSONL 里 assistant 最后一条 message 文本（-o 文件缺失时的备胎） */
function lastTextEvent(stdout: string): string | null {
  let last: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    const j = tryJson(t);
    if (!j) continue;
    const msg = (j["msg"] ?? j) as Record<string, unknown>;
    if (msg["type"] === "agent_message" && typeof msg["message"] === "string") {
      last = msg["message"];
    }
    const item = j["item"] as Record<string, unknown> | undefined;
    if (
      j["type"] === "item.completed" &&
      item?.["item_type"] === "assistant_message" &&
      typeof item["text"] === "string"
    ) {
      last = item["text"];
    }
  }
  return last;
}
