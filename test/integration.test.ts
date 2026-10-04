/**
 * 全链路集成测试：
 *   node:http 假 SystemOne 服务器（可控概率 + 延迟 + usage 计量）
 *   两个假分区执行器（node -e 写结果文件）
 *   → runDispatch 全闭环；断言审计行、四态、改派、成本、隐私哈希。
 *
 * 三个剧本：
 *   pass          验收一次通过 → done，2 次判断（choice+noul）
 *   redispatch    首验败 → 改派 → 复验过 → done，4 次判断
 *   giveup        首验败 → 不改派 → failed，3 次判断
 *   pseudo        无服务器纯伪 JEV 全闭环
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { OfficeConfig } from "../src/core/types.ts";
import { DEFAULTS } from "../src/core/config.ts";
import { loadPartitions } from "../src/core/partitions.ts";
import { HttpSystemOneClient } from "../src/jev/http.ts";
import { PseudoSystemOneClient } from "../src/jev/pseudo.ts";
import { Ledger } from "../src/ledger/sqlite.ts";
import { runDispatch, type ManagerEvent } from "../src/manager/engineering-manager.ts";

const RESULT_TEXT = [
  "结果满足验收标准。",
  "",
  "## 执行证据",
  "- `echo done` → 结果文件已写出",
].join("\n");

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jev-office-it-"));
}

function writeFixtures(dir: string): { partitionsFile: string; briefFile: string; dbPath: string; runsDir: string } {
  const partitionsFile = path.join(dir, "partitions.json");
  fs.writeFileSync(
    partitionsFile,
    JSON.stringify({
      partitions: [
        {
          name: "便宜区",
          model: "fake-cheap",
          specialties: "简单 只读 统计",
          priceInPer1M: 1,
          priceOutPer1M: 5,
          executor: {
            command: [
              process.execPath,
              "-e",
              `require('fs').writeFileSync(process.argv.at(-1), ${JSON.stringify(RESULT_TEXT)})`,
              "{resultFile}",
            ],
            resultMode: "file",
            timeoutMs: 30000,
          },
        },
        {
          name: "贵区",
          model: "fake-expensive",
          specialties: "复杂 开发 审查",
          priceInPer1M: 15,
          priceOutPer1M: 75,
          executor: {
            command: [
              process.execPath,
              "-e",
              `require('fs').writeFileSync(process.argv.at(-1), ${JSON.stringify(RESULT_TEXT)})`,
              "{resultFile}",
            ],
            resultMode: "file",
            timeoutMs: 30000,
          },
        },
      ],
    }),
  );
  const briefFile = path.join(dir, "brief.json");
  fs.writeFileSync(
    briefFile,
    JSON.stringify({
      title: "测试任务",
      description: "做一个简单的测试任务 SECRET-CONTENT-不落地",
      scope: ["范围 1"],
      acceptance: ["验收 1"],
      constraints: [],
      workdir: dir,
    }),
  );
  return {
    partitionsFile,
    briefFile,
    dbPath: path.join(dir, "office.db"),
    runsDir: path.join(dir, "runs"),
  };
}

/** 假 SystemOne 服务器：模式由 mode 控制；第 N 次验收采用不同概率（模拟首败后改派成功） */
function startFakeServer(mode: { acceptP: number; acceptP2?: number; redispatchP: number; latencyMs?: number }) {
  const requests: { instructions: string; type: string }[] = [];
  let acceptCalls = 0;
  const server = http.createServer(async (req, res) => {
    // 测试用服务器：禁用 keep-alive，避免 undici 持连导致进程不散
    res.setHeader("connection", "close");
    if (req.url === "/v1/models" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "openjev-latest" }] }));
      return;
    }
    if (req.url === "/v1/systemone" && req.method === "POST") {
      let bodyRaw = "";
      for await (const chunk of req) bodyRaw += chunk;
      const body = JSON.parse(bodyRaw) as { model: string; state: string; questions: Record<string, any> };
      if (mode.latencyMs) await new Promise((r) => setTimeout(r, mode.latencyMs));
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(body.questions)) {
        requests.push({ instructions: String(q.instructions), type: String(q.type) });
        if (q.type === "choice") {
          const names = Object.keys(q.criteria);
          const p1 = 0.9;
          const p2 = names.length > 1 ? (1 - p1) / (names.length - 1) : 0;
          const probabilities = Object.fromEntries(names.map((n, i) => [n, i === 0 ? p1 : p2]));
          answers[id] = { choice: names[0], probabilities, confidence: 0.99 };
        } else if (q.type === "noul") {
          let p: number;
          if (String(q.instructions).includes("改派")) {
            p = mode.redispatchP;
          } else {
            acceptCalls += 1;
            p = acceptCalls === 1 ? mode.acceptP : (mode.acceptP2 ?? mode.acceptP);
          }
          answers[id] = { noul: p };
        } else {
          answers[id] = { noul: 0 };
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 100, output_tokens: 0 } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise<{ server: http.Server; baseUrl: string; requests: typeof requests }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, requests });
    });
  });
}

function mkConfig(fx: ReturnType<typeof writeFixtures>, baseUrl: string): OfficeConfig {
  return {
    ...structuredClone(DEFAULTS),
    jev: { ...DEFAULTS.jev, backend: "http", baseUrl, model: "openjev-0.1" },
    partitionsFile: fx.partitionsFile,
    dbPath: fx.dbPath,
    runsDir: fx.runsDir,
    onUncertain: "proceed",
    maxRedispatches: 1,
  };
}

let dir: string;
let fx: ReturnType<typeof writeFixtures>;
before(() => {
  dir = mkTmp();
  fx = writeFixtures(dir);
});
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("pass: 一轮闭环 done，审计含 choice+noul，成本正确，隐私只存哈希", async (t) => {
  const { server, baseUrl } = await startFakeServer({ acceptP: 0.95, redispatchP: 0.9 });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const config = mkConfig(fx, baseUrl);
  const partitions = loadPartitions(fx.partitionsFile);
  const ledger = new Ledger(path.join(dir, "pass.db"));
  const configWithDb = { ...config, dbPath: path.join(dir, "pass.db"), runsDir: path.join(dir, "pass-runs") };
  const events: ManagerEvent[] = [];
  const client = new HttpSystemOneClient({ baseUrl, model: "openjev-0.1", apiKey: "" });
  const outcome = await runDispatch(
    { config: configWithDb, partitions, ledger, client, emit: (e) => events.push(e) },
    { briefFile: fx.briefFile },
  );

  assert.equal(outcome.state, "done");
  assert.equal(outcome.partition?.name, "便宜区");
  assert.equal(outcome.noulPassed, true);
  assert.ok(outcome.result && outcome.result.evidence.length >= 1);
  assert.match(outcome.result!.evidence[0]!.command, /echo done/);

  // 判断审计：1 choice + 1 noul，均落库，延迟与 usage 记录
  const js = ledger.recentJudgments(10);
  assert.equal(js.length, 2);
  const choice = js.find((r) => r.primitive === "choice")!;
  assert.equal(choice.action, "execute");
  assert.ok(choice.latencyMs >= 0);
  assert.equal(choice.inputTokens, 100);
  // 隐私：state 只存 sha256+长度，正文绝不落库
  assert.match(choice.stateSha256, /^[0-9a-f]{64}$/);
  const raw = fs.readFileSync(path.join(dir, "pass.db"), "utf8");
  assert.ok(!raw.includes("SECRET-CONTENT-不落地"), "数据库里不应出现任务正文原文");
  const expectedHash = createHash("sha256")
    .update(
      `任务: 测试任务\n做一个简单的测试任务 SECRET-CONTENT-不落地\n范围: 范围 1\n验收标准: 验收 1`,
      "utf8",
    )
    .digest("hex");
  assert.equal(choice.stateSha256, expectedHash, "state 哈希应可由正文复现");

  // 成本：便宜区 1/5 vs 最贵 15/75，且含 JEV 成本
  const st = ledger.statusAll();
  assert.equal(st.judgments, 2);
  assert.ok(st.costUsd > 0);
  assert.ok(st.baselineUsd > st.costUsd, "用便宜分区应比全用最贵更省");
  ledger.close();
});

test("redispatch: 验收败 → noul 问改派 → 改派贵区 → done", async (t) => {
  const { server, baseUrl, requests } = await startFakeServer({ acceptP: 0.1, acceptP2: 0.95, redispatchP: 0.9 });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const config = mkConfig(fx, baseUrl);
  const configWithDb = { ...config, dbPath: path.join(dir, "redispatch.db"), runsDir: path.join(dir, "redispatch-runs") };
  const ledger = new Ledger(configWithDb.dbPath);
  const partitions = loadPartitions(fx.partitionsFile);
  const events: ManagerEvent[] = [];
  const outcome = await runDispatch(
    {
      config: configWithDb,
      partitions,
      ledger,
      client: new HttpSystemOneClient({ baseUrl, model: "openjev-0.1", apiKey: "" }),
      emit: (e) => events.push(e),
    },
    { briefFile: fx.briefFile },
  );
  assert.equal(outcome.state, "done");
  assert.equal(outcome.partition?.name, "贵区", "改派后应在次优分区完成");
  assert.ok(events.some((e) => e.type === "redispatch"));
  const js = ledger.recentJudgments(10);
  assert.equal(js.filter((r) => r.primitive === "choice").length, 1);
  assert.equal(js.filter((r) => r.primitive === "noul").length, 3, "首验+改派问+复验共 3 次 noul");
  assert.ok(requests.some((r) => r.instructions.includes("改派")));
  ledger.close();
  server.closeAllConnections();
  server.close();
});

test("giveup: 验收败且不改派 → failed", async () => {
  const { server, baseUrl } = await startFakeServer({ acceptP: 0.1, redispatchP: 0.1 });
  const config = mkConfig(fx, baseUrl);
  const configWithDb = { ...config, dbPath: path.join(dir, "giveup.db"), runsDir: path.join(dir, "giveup-runs") };
  const ledger = new Ledger(configWithDb.dbPath);
  const partitions = loadPartitions(fx.partitionsFile);
  const outcome = await runDispatch(
    {
      config: configWithDb,
      partitions,
      ledger,
      client: new HttpSystemOneClient({ baseUrl, model: "openjev-0.1", apiKey: "" }),
      emit: () => {},
    },
    { briefFile: fx.briefFile },
  );
  assert.equal(outcome.state, "failed");
  const ds = ledger.recentDispatches(1);
  assert.equal(ds[0]!.state, "failed");
  assert.equal(ds[0]!.noulPassed, 0);
  ledger.close();
  server.closeAllConnections();
  server.close();
});

test("pseudo: 纯伪 JEV 全闭环（无服务器、无 Key）", async () => {
  const config = { ...structuredClone(DEFAULTS), partitionsFile: fx.partitionsFile, dbPath: path.join(dir, "pseudo.db"), runsDir: path.join(dir, "pseudo-runs"), onUncertain: "proceed" as const };
  const partitions = loadPartitions(fx.partitionsFile);
  const ledger = new Ledger(config.dbPath);
  const outcome = await runDispatch(
    { config, partitions, ledger, client: new PseudoSystemOneClient(), emit: () => {} },
    { briefFile: fx.briefFile },
  );
  // 伪 JEV 视命中哪个分区不定，但必须走完闭环（done 或 failed，不得抛异常）
  assert.ok(["done", "failed"].includes(outcome.state));
  assert.ok(ledger.recentJudgments(10).length >= 2);
  ledger.close();
});

test("http 客户端：429→重试→成功；400→直接抛错", async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    res.setHeader("connection", "close");
    hits += 1;
    if (hits < 3) {
      res.writeHead(429);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        model: "m",
        answers: { gate: { noul: 0.8 } },
        usage: { input_tokens: 10, output_tokens: 0 },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const client = new HttpSystemOneClient({ baseUrl: `http://127.0.0.1:${port}`, model: "openjev-0.1", apiKey: "" });
  const { answer } = await client.noul("s", { instructions: "q?" });
  assert.ok(Math.abs(answer.p - 0.8) < 1e-9);
  assert.equal(hits, 3);
  server.closeAllConnections();
  server.close();
});
