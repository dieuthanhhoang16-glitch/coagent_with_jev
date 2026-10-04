/**
 * 本地 SQLite（node:sqlite 内置驱动，零依赖）。
 *
 * 隐私设计（spec 非功能需求）：不落对话正文。
 *   - state（任务书/结果正文）只存 sha256 哈希 + 字符数，可审计可复现
 *   - 问题文本（instructions）与候选说明是我们自写的路由约束文本，不是对话正文，可存
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DecisionState, Primitive } from "../core/types.ts";

export interface JudgmentRow {
  id: number;
  dispatchId: number | null;
  ts: string;
  primitive: Primitive;
  backend: string;
  question: string;
  stateSha256: string;
  stateChars: number;
  candidates: string; // JSON
  distribution: string; // JSON
  confidence: number;
  threshold: number;
  action: DecisionState | "yes" | "no" | "scored";
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface DispatchRow {
  id: number;
  briefTitle: string;
  briefFile: string;
  manager: string;
  state: string; // DispatchState
  partition: string | null;
  executorCmd: string | null;
  startedTs: string;
  finishedTs: string | null;
  resultFile: string | null;
  noulP: number | null;
  noulPassed: number | null;
  score: number | null;
  redispatchOf: number | null;
}

export interface CostRow {
  id: number;
  dispatchId: number;
  partition: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  baselineUsd: number;
}

export class Ledger {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS judgments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dispatch_id INTEGER,
        ts TEXT NOT NULL,
        primitive TEXT NOT NULL,
        backend TEXT NOT NULL,
        question TEXT NOT NULL,
        state_sha256 TEXT NOT NULL,
        state_chars INTEGER NOT NULL,
        candidates TEXT NOT NULL,
        distribution TEXT NOT NULL,
        confidence REAL NOT NULL,
        threshold REAL NOT NULL,
        action TEXT NOT NULL,
        latency_ms REAL NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_judgments_ts ON judgments(ts);
      CREATE TABLE IF NOT EXISTS dispatches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        brief_title TEXT NOT NULL,
        brief_file TEXT NOT NULL,
        manager TEXT NOT NULL,
        state TEXT NOT NULL,
        partition TEXT,
        executor_cmd TEXT,
        started_ts TEXT NOT NULL,
        finished_ts TEXT,
        result_file TEXT,
        noul_p REAL,
        noul_passed INTEGER,
        score REAL,
        redispatch_of INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_dispatches_ts ON dispatches(started_ts);
      CREATE TABLE IF NOT EXISTS costs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dispatch_id INTEGER NOT NULL,
        partition TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        baseline_usd REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_costs_dispatch ON costs(dispatch_id);
    `);
  }

  static hashState(state: string): string {
    return createHash("sha256").update(state, "utf8").digest("hex");
  }

  insertJudgment(j: {
    dispatchId: number | null;
    primitive: Primitive;
    backend: string;
    question: string;
    state: string; // 只取哈希与长度，不存原文
    candidates: string;
    distribution: string;
    confidence: number;
    threshold: number;
    action: JudgmentRow["action"];
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
  }): number {
    const r = this.db
      .prepare(
        `INSERT INTO judgments
          (dispatch_id, ts, primitive, backend, question, state_sha256, state_chars,
           candidates, distribution, confidence, threshold, action, latency_ms,
           input_tokens, output_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        j.dispatchId,
        new Date().toISOString(),
        j.primitive,
        j.backend,
        j.question,
        Ledger.hashState(j.state),
        j.state.length,
        j.candidates,
        j.distribution,
        j.confidence,
        j.threshold,
        j.action,
        j.latencyMs,
        j.inputTokens,
        j.outputTokens,
      );
    return Number(r.lastInsertRowid);
  }

  startDispatch(d: {
    briefTitle: string;
    briefFile: string;
    manager: string;
    state: string;
    partition: string | null;
    redispatchOf: number | null;
  }): number {
    const r = this.db
      .prepare(
        `INSERT INTO dispatches
          (brief_title, brief_file, manager, state, partition, started_ts, redispatch_of)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        d.briefTitle,
        d.briefFile,
        d.manager,
        d.state,
        d.partition,
        new Date().toISOString(),
        d.redispatchOf,
      );
    return Number(r.lastInsertRowid);
  }

  /** 派发终止（成功/失败/升级）时一次性回填 */
  finishDispatch(
    id: number,
    patch: {
      state?: string;
      partition?: string | null;
      executorCmd?: string | null;
      resultFile?: string | null;
      noulP?: number | null;
      noulPassed?: boolean | null;
      score?: number | null;
    },
  ): void {
    const colMap: Record<string, string> = {
      state: "state",
      partition: "partition",
      executorCmd: "executor_cmd",
      resultFile: "result_file",
      noulP: "noul_p",
      noulPassed: "noul_passed",
      score: "score",
    };
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, col] of Object.entries(colMap)) {
      const v = patch[k as keyof typeof patch];
      if (v === undefined) continue;
      sets.push(`${col} = ?`);
      vals.push(k === "noulPassed" && v !== null ? (v ? 1 : 0) : v);
    }
    if (sets.length === 0) return;
    sets.push("finished_ts = ?");
    vals.push(new Date().toISOString());
    this.db
      .prepare(`UPDATE dispatches SET ${sets.join(", ")} WHERE id = ?`)
      .run(...(vals as never[]), id as never);
  }

  insertCost(c: Omit<CostRow, "id">): void {
    this.db
      .prepare(
        `INSERT INTO costs (dispatch_id, partition, input_tokens, output_tokens, cost_usd, baseline_usd)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(c.dispatchId, c.partition, c.inputTokens, c.outputTokens, c.costUsd, c.baselineUsd);
  }

  /** 今日四态计数 + 分区命中 + 花费/节省（M2 顶部状态条的数据源，M1 已可打印） */
  statusToday(): {
    judgments: number;
    byAction: Record<string, number>;
    byPartition: Record<string, number>;
    costUsd: number;
    baselineUsd: number;
  } {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const since = todayStart.toISOString();
    const byAction = Object.fromEntries(
      (
        this.db
          .prepare(`SELECT action, COUNT(*) AS n FROM judgments WHERE ts >= ? GROUP BY action`)
          .all(since) as { action: string; n: number }[]
      ).map((r) => [r.action, r.n]),
    );
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM judgments WHERE ts >= ?`).get(since) as {
        n: number;
      }
    ).n;
    const byPartition = Object.fromEntries(
      (
        this.db
          .prepare(
            `SELECT partition, COUNT(*) AS n FROM dispatches
             WHERE started_ts >= ? AND partition IS NOT NULL GROUP BY partition`,
          )
          .all(since) as { partition: string; n: number }[]
      ).map((r) => [r.partition, r.n]),
    );
    const money = this.db
      .prepare(
        `SELECT COALESCE(SUM(c.cost_usd),0) AS cost, COALESCE(SUM(c.baseline_usd),0) AS base
         FROM costs c JOIN dispatches d ON d.id = c.dispatch_id WHERE d.started_ts >= ?`,
      )
      .get(since) as { cost: number; base: number };
    return {
      judgments: total,
      byAction,
      byPartition,
      costUsd: money.cost,
      baselineUsd: money.base,
    };
  }

  /** 全时段汇总（ledger 命令用） */
  statusAll(): {
    judgments: number;
    dispatches: number;
    byAction: Record<string, number>;
    costUsd: number;
    baselineUsd: number;
  } {
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM judgments`).get() as { n: number }).n;
    const dispatches = (this.db.prepare(`SELECT COUNT(*) AS n FROM dispatches`).get() as { n: number }).n;
    const byAction = Object.fromEntries(
      (
        this.db
          .prepare(`SELECT action, COUNT(*) AS n FROM judgments GROUP BY action`)
          .all() as { action: string; n: number }[]
      ).map((r) => [r.action, r.n]),
    );
    const money = this.db
      .prepare(`SELECT COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(baseline_usd),0) AS base FROM costs`)
      .get() as { cost: number; base: number };
    return { judgments: total, dispatches, byAction, costUsd: money.cost, baselineUsd: money.base };
  }

  recentJudgments(limit: number): JudgmentRow[] {
    return (
      this.db.prepare(`SELECT * FROM judgments ORDER BY id DESC LIMIT ?`).all(limit) as Record<
        string,
        unknown
      >[]
    ).map((r) => ({
      id: r["id"] as number,
      dispatchId: (r["dispatch_id"] as number | null) ?? null,
      ts: r["ts"] as string,
      primitive: r["primitive"] as Primitive,
      backend: r["backend"] as string,
      question: r["question"] as string,
      stateSha256: r["state_sha256"] as string,
      stateChars: r["state_chars"] as number,
      candidates: r["candidates"] as string,
      distribution: r["distribution"] as string,
      confidence: r["confidence"] as number,
      threshold: r["threshold"] as number,
      action: r["action"] as JudgmentRow["action"],
      latencyMs: r["latency_ms"] as number,
      inputTokens: r["input_tokens"] as number,
      outputTokens: r["output_tokens"] as number,
    }));
  }

  recentDispatches(limit: number): DispatchRow[] {
    return (
      this.db.prepare(`SELECT * FROM dispatches ORDER BY id DESC LIMIT ?`).all(limit) as Record<
        string,
        unknown
      >[]
    ).map((r) => ({
      id: r["id"] as number,
      briefTitle: r["brief_title"] as string,
      briefFile: r["brief_file"] as string,
      manager: r["manager"] as string,
      state: r["state"] as string,
      partition: (r["partition"] as string | null) ?? null,
      executorCmd: (r["executor_cmd"] as string | null) ?? null,
      startedTs: r["started_ts"] as string,
      finishedTs: (r["finished_ts"] as string | null) ?? null,
      resultFile: (r["result_file"] as string | null) ?? null,
      noulP: (r["noul_p"] as number | null) ?? null,
      noulPassed: (r["noul_passed"] as number | null) ?? null,
      score: (r["score"] as number | null) ?? null,
      redispatchOf: (r["redispatch_of"] as number | null) ?? null,
    }));
  }

  close(): void {
    this.db.close();
  }
}
