#!/usr/bin/env node
/**
 * jev — JEV 办公室命令行（M1）
 *
 *   jev init                                初始化配置/分区/演示参考目录
 *   jev partitions list                     列出全部型号分区
 *   jev dispatch --brief FILE [选项]         走完整一轮：任务书→choice→派发→noul 验收
 *   jev ledger                              成本账目（今日 + 累计）
 *   jev history [-n N]                      最近的判断与派发记录（审计）
 *   jev demo                                连跑三个异构演示任务（伪 JEV，无需 Key）
 */
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { existsSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, DEFAULTS } from "./core/config.ts";
import { loadPartitions, mostExpensive } from "./core/partitions.ts";
import { pickClient } from "./jev/probe.ts";
import { Ledger } from "./ledger/sqlite.ts";
import { fmtUsd } from "./ledger/costs.ts";
import { runDispatch, type ManagerEvent } from "./manager/engineering-manager.ts";
import { c } from "./ui/ansi.ts";
import { renderJudgmentPanel, renderEvidence, renderStatusBar } from "./ui/bars.ts";
import { DECISION_STATE_LABEL, type Partition } from "./core/types.ts";

const EXIT_BY_STATE: Record<string, number> = {
  done: 0,
  failed: 1,
  "need-you": 2,
  "hand-back": 3,
  unsure: 4,
  dispatched: 5,
};

function fail(msg: string): never {
  console.error(c.red(`✗ ${msg}`));
  process.exit(1);
}

type FlagSpec = NonNullable<Parameters<typeof parseArgs>[0]>["options"];
function parseRest<const T extends FlagSpec>(rest: string[], spec: T) {
  return parseArgs({ args: rest, options: spec, allowPositionals: true, strict: true }).values;
}

/** 把 config 根目录与分区表装齐，返回公共依赖 */
async function openOffice(flags: { config?: string | undefined; backend?: string | undefined }) {
  const { config, configPath, rootDir } = loadConfig(typeof flags.config === "string" ? flags.config : undefined);
  if (flags.backend && ["auto", "http", "pseudo"].includes(flags.backend)) {
    config.jev.backend = flags.backend as typeof config.jev.backend;
  }
  if (!existsSync(config.partitionsFile)) {
    const fallback = config.partitionsFile.replace(/partitions\.json$/, "partitions.example.json");
    if (existsSync(fallback)) {
      config.partitionsFile = fallback;
    } else {
      fail(`分区文件不存在: ${config.partitionsFile}（先跑 jev init）`);
    }
  }
  const partitions = loadPartitions(config.partitionsFile);
  const ledger = new Ledger(config.dbPath);
  const { client, note } = await pickClient(config);
  console.log(c.gray(`后端: ${note}`));
  return { config, configPath, rootDir, partitions, ledger, client };
}

function makeEmitter(partitions: Partition[], config: ReturnType<typeof loadConfig>["config"]) {
  const specs = Object.fromEntries(
    partitions.map((p) => [p.name, { name: p.name, specialty: p.specialties }]),
  );
  return (e: ManagerEvent) => {
    switch (e.type) {
      case "choice": {
        // 等到 decision 事件一起打面板（避免重复打印）——这里只存起来
        pendingChoice = e;
        break;
      }
      case "decision": {
        const choiceEvt = pendingChoice;
        if (choiceEvt) {
          pendingChoice = null;
          for (const line of renderJudgmentPanel({
            question: choiceEvt.question,
            distribution: choiceEvt.distribution,
            specs,
            confidence: choiceEvt.confidence,
            threshold: e.threshold,
            decisionLabel: `${icon(e.decision.state)} ${decisionLabelOf(e.decision, choiceEvt.distribution)}`,
            latencyMs: choiceEvt.latencyMs,
            backend: choiceEvt.backend,
          })) {
            console.log(line);
          }
        } else {
          console.log(`${icon(e.decision.state)} ${decisionLabelOf(e.decision, {})}`);
        }
        if (e.decision.state !== "execute") {
          console.log(c.gray(`  理由: ${e.decision.reason}`));
        }
        break;
      }
      case "command":
        console.log(`${c.bold("派发")} → ${c.cyan(e.partition.name)} 区（模型 ${e.partition.model}）`);
        console.log(`  命令: ${c.gray(e.displayCmd)}`);
        break;
      case "executed":
        console.log(
          c.gray(
            `  执行完毕: exit=${e.result.exitCode} 用时 ${(e.result.durationMs / 1000).toFixed(1)}s ` +
              `token in=${e.result.inputTokens} out=${e.result.outputTokens}${e.result.usageEstimated ? "(估算)" : "(实测)"}`,
          ),
        );
        break;
      case "evidence":
        for (const line of renderEvidence(e.items)) console.log(line);
        break;
      case "noul": {
        const p = `${(e.answer.p * 100).toFixed(1)}%`;
        const mark = e.answer.verdict ? c.green("是") : c.red("否");
        console.log(`  ${c.bold("noul")} [${e.purpose}] P(是)=${p} → ${mark}（把握 ${e.answer.confidence.toFixed(2)}）`);
        break;
      }
      case "redispatch":
        console.log(c.yellow(`  ↻ 改派: ${e.fromPartition} → ${e.toPartition}（${e.reason}）`));
        break;
      case "score":
        console.log(`  ${c.bold("score")} 质量评分: ${c.bold(e.score.toFixed(1))}/5`);
        break;
    }
  };
}

let pendingChoice: Extract<ManagerEvent, { type: "choice" }> | null = null;

function icon(s: string): string {
  return { execute: "✅", "hand-back": "🔙", unsure: "🤔", "need-you": "🙋" }[s] ?? "•";
}

function decisionLabelOf(
  d: { state: string; picked: string | null; reason: string },
  _dist: Record<string, number>,
): string {
  if (d.state === "execute" && d.picked) return `→ 派给 ${d.picked} 区 · ${DECISION_STATE_LABEL["execute"]}`;
  if (d.picked) return `→ 暂派 ${d.picked} 区 · ${DECISION_STATE_LABEL[d.state as keyof typeof DECISION_STATE_LABEL] ?? d.state}`;
  return `${DECISION_STATE_LABEL[d.state as keyof typeof DECISION_STATE_LABEL] ?? d.state}`;
}

/* ------------------------------- 子命令 ------------------------------- */

async function cmdInit() {
  const cwd = process.cwd();
  const cfgPath = path.join(cwd, "jev-office.config.json");
  const partsDir = path.join(cwd, "config");
  const partsFile = path.join(partsDir, "partitions.json");
  const exampleFile = path.join(partsDir, "partitions.example.json");
  const srcExample = new URL("../config/partitions.example.json", import.meta.url).pathname;

  mkdirSync(partsDir, { recursive: true });
  if (!existsSync(cfgPath)) {
    writeFileSync(cfgPath, JSON.stringify(DEFAULTS, null, 2) + "\n", "utf8");
    console.log(`✔ 已写 ${cfgPath}`);
  } else {
    console.log(`= 已存在，跳过 ${cfgPath}`);
  }
  const src = existsSync(exampleFile) ? exampleFile : srcExample;
  if (!existsSync(partsFile)) {
    copyFileSync(src, partsFile);
    console.log(`✔ 已写 ${partsFile}（按需改模型与价格）`);
  } else {
    console.log(`= 已存在，跳过 ${partsFile}`);
  }
  // 演示 refs：58 个 markdown 文件
  const refsDir = path.join(cwd, "examples", "refs");
  mkdirSync(refsDir, { recursive: true });
  let created = 0;
  for (let i = 1; i <= 58; i++) {
    const f = path.join(refsDir, `ref-${String(i).padStart(2, "0")}.md`);
    if (!existsSync(f)) {
      writeFileSync(f, `# 参考资料 ${i}\n\n这是 JEV 办公室演示用的第 ${i} 个 Markdown 参考文件。\n\n- 要点 ${i}.1\n- 要点 ${i}.2\n`, "utf8");
      created += 1;
    }
  }
  console.log(`✔ 演示 refs 就绪（新建 ${created}，共 58 个 md）: ${refsDir}`);
  console.log(`\n下一步:\n  jev dispatch --brief examples/briefs/doc-stats.json\n  jev demo`);
}

async function cmdPartitions(rest: string[]) {
  parseRest(rest, {});
  const { partitions } = await openOffice({});
  const maxExp = mostExpensive(partitions);
  console.log(c.bold("型号分区:"));
  for (const p of partitions) {
    console.log(
      `  ${p === partitions.find((x) => x.name === maxExp.name) ? c.red("◆") : " "} ${c.bold(p.name.padEnd(12))} 模型 ${p.model.padEnd(22)} ` +
        `${c.yellow(`$${p.priceInPer1M}/$${p.priceOutPer1M}`)} per1M  ${c.gray(p.specialties)}`,
    );
    console.log(`     执行器: ${c.gray(p.executor.command.join(" "))}`);
  }
  console.log(c.gray(`◆ = 最贵分区（成本对照基准: ${maxExp.name}）`));
}

async function cmdLedger() {
  const { ledger } = await openOffice({});
  const today = ledger.statusToday();
  const all = ledger.statusAll();
  console.log(renderStatusBar({
    judgments: today.judgments,
    byAction: today.byAction,
    byPartition: today.byPartition,
    costUsd: fmtUsd(today.costUsd),
    baselineUsd: fmtUsd(today.baselineUsd),
    savingsUsd: fmtUsd(today.baselineUsd - today.costUsd),
  }));
  console.log(
    c.gray(`累计: 判断 ${all.judgments} · 派发 ${all.dispatches} · 花费 ${fmtUsd(all.costUsd)} · 对照 ${fmtUsd(all.baselineUsd)} · 省 ${fmtUsd(all.baselineUsd - all.costUsd)}`),
  );
  ledger.close();
}

async function cmdHistory(rest: string[]) {
  const v = parseRest(rest, { n: { type: "string", default: "10" } });
  const n = Math.max(1, Number(v["n"]) || 10);
  const { ledger } = await openOffice({});
  console.log(c.bold(`最近 ${n} 次 JEV 判断:`));
  for (const r of ledger.recentJudgments(n)) {
    const dist = (() => { try { return JSON.parse(r.distribution) as Record<string, number>; } catch { return {}; } })();
    const top = Object.entries(dist).sort((a, b) => b[1] - a[1])[0];
    console.log(
      `  #${r.id} ${c.gray(r.ts.slice(0, 19))} ${r.primitive.padEnd(6)} ` +
        `${icon(String(r.action))} ${String(r.action).padEnd(9)} ` +
        `conf=${r.confidence.toFixed(2)}/线${r.threshold} ` +
        `${top ? c.cyan(`${top[0]} ${(top[1] * 100).toFixed(0)}%`) : ""} ` +
        c.gray(`[${r.backend} ${r.latencyMs.toFixed(0)}ms] ${r.question.slice(0, 40)}`),
    );
  }
  console.log(c.bold(`\n最近 ${n} 次派发:`));
  for (const d of ledger.recentDispatches(n)) {
    console.log(
      `  #${d.id} ${c.gray(d.startedTs.slice(0, 19))} ${d.state.padEnd(10)} ` +
        `${d.partition ?? "-"} ${c.gray(d.briefTitle)}${d.noulPassed === 1 ? c.green(" ✓验收") : d.noulPassed === 0 ? c.red(" ✗验收") : ""}`,
    );
  }
  ledger.close();
}

async function cmdDispatch(rest: string[]): Promise<number> {
  const v = parseRest(rest, {
    brief: { type: "string" },
    config: { type: "string" },
    backend: { type: "string" },
    yes: { type: "boolean", default: false },
    "on-uncertain": { type: "string", default: "escalate" },
    "with-score": { type: "boolean", default: false },
  });
  const brief = v["brief"];
  if (!brief || typeof brief !== "string") fail("缺少 --brief <任务书.json>");
  const office = await openOffice({
    config: typeof v["config"] === "string" ? v["config"] : undefined,
    backend: typeof v["backend"] === "string" ? v["backend"] : undefined,
  });
  console.log(c.bold(`工程经理 ${office.config.managerName} 接单`));

  const emit = makeEmitter(office.partitions, office.config);
  const yes = Boolean(v["yes"]);
  const confirmCommand = yes
    ? undefined
    : async (displayCmd: string) => {
        if (!process.stdin.isTTY) return true; // 非交互：打印过命令即视为已展示
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const ans = await rl.question(`  ${c.yellow("执行上面的命令?")} [y/N] `);
          return /^y(es)?$/i.test(ans.trim());
        } finally {
          rl.close();
        }
      };

  const outcome = await runDispatch(
    {
      config: office.config,
      partitions: office.partitions,
      ledger: office.ledger,
      client: office.client,
      emit,
      ...(confirmCommand ? { confirmCommand } : {}),
    },
    {
      briefFile: brief,
      onUncertain: v["on-uncertain"] === "proceed" ? "proceed" : "escalate",
      withScore: Boolean(v["with-score"]),
    },
  );

  // 结尾汇总
  console.log("");
  if (outcome.cost) {
    console.log(
      `${c.bold("成本")} 本次 ${c.yellow(fmtUsd(outcome.cost.costUsd))}` +
        `${outcome.cost.jevUsd > 0 ? c.gray(`（含 JEV ${fmtUsd(outcome.cost.jevUsd)}）`) : ""}` +
        ` │ 全用最贵模型对照 ${fmtUsd(outcome.cost.baselineUsd)} │ ${c.green(`省 ${fmtUsd(outcome.cost.savingsUsd)}`)}`,
    );
  }
  const today = office.ledger.statusToday();
  console.log(
    renderStatusBar({
      judgments: today.judgments,
      byAction: today.byAction,
      byPartition: today.byPartition,
      costUsd: fmtUsd(today.costUsd),
      baselineUsd: fmtUsd(today.baselineUsd),
      savingsUsd: fmtUsd(today.baselineUsd - today.costUsd),
    }),
  );
  if (outcome.result) {
    console.log(c.gray(`结果文件: ${outcome.result.resultFile}`));
  }
  console.log(
    outcome.state === "done"
      ? c.green("✔ done")
      : outcome.state === "failed"
        ? c.red("✖ failed")
        : c.yellow(`◐ ${outcome.state}`),
  );
  office.ledger.close();
  return EXIT_BY_STATE[outcome.state] ?? 1;
}

async function cmdDemo(rest: string[]): Promise<number> {
  const v = parseRest(rest, {
    config: { type: "string" },
    backend: { type: "string", default: "pseudo" },
    "with-score": { type: "boolean", default: false },
  });
  const examples = [
    "examples/briefs/code-review.json",
    "examples/briefs/doc-stats.json",
    "examples/briefs/frontend-page.json",
  ];
  let worst = 0;
  for (const brief of examples) {
    console.log(c.bold(`\n════════ DEMO: ${brief} ════════`));
    const code = await cmdDispatch([
      "--brief", brief,
      "--yes",
      ...(v["with-score"] ? ["--with-score"] : []),
      "--backend", String(v["backend"] ?? "pseudo"),
      ...(typeof v["config"] === "string" ? ["--config", v["config"]] : []),
      "--on-uncertain", "proceed",
    ]);
    worst = Math.max(worst, code);
  }
  console.log(c.bold("\n════════ DEMO 完 ════════"));
  return worst;
}

/* ------------------------------- 主入口 ------------------------------- */

const USAGE = `jev — JEV 办公室 ${c.gray("(M1)")}

用法:
  jev init                      初始化配置与演示目录
  jev dispatch --brief FILE     任务书 → JEV choice → 派发 → noul 验收
      [--config C] [--backend auto|http|pseudo] [--yes]
      [--on-uncertain escalate|proceed] [--with-score]
  jev partitions list           列出现有型号分区
  jev ledger                    成本账目（今日 + 累计）
  jev history [-n N]            审计流：最近的判断与派发
  jev demo                      连跑 3 个异构演示任务（默认 pseudo，无 Key 可跑）

环境变量: JEV_BASE_URL / JEV_API_KEY / JEV_MODEL / JEV_BACKEND
          （亦兼容 TYPESAFE_BASE_URL / TYPESAFE_API_KEY）`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "init":
      await cmdInit();
      return;
    case "partitions":
      await cmdPartitions(rest);
      return;
    case "dispatch":
      process.exit(await cmdDispatch(rest));
      return;
    case "ledger":
      await cmdLedger();
      return;
    case "history":
      await cmdHistory(rest);
      return;
    case "demo":
      process.exit(await cmdDemo(rest));
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    default:
      console.error(`未知命令: ${cmd}\n\n${USAGE}`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(c.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
