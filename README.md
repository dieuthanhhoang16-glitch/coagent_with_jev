# JEV 办公室（Jev Office）

**本地优先的多 Agent 调度工作站**：用 System One 决策模型（Jev / OpenJev 兼容 API）当 "judge"，把任务按类型路由派发给不同模型分区的执行 Agent，全程可审计 —— 概率分布、把握度、四态、执行证据、成本节省。

```
老板（你）
  │  任务书（范围/验收标准/约束）
  ▼
工程经理 azir ──→ JEV choice:「派给哪个型号分区？」──→ 概率分布 + 把握度
  │                                                     │ 把握线(0.70)
  │                     ┌─ 直接执行 ─┬─ 拿不准 ─┬─ 交回 ─┴─ 需要你
  ▼                     ▼
执行器(独立 shell 子进程, claude / codex …)  →  结果文件  →  JEV noul:「满足验收标准吗？」
  │                                                        │ 否 → 改派 / 挂起
  ▼                                                        ▼
SQLite 审计（问题/候选/概率/置信度/把握线/动作/延迟）   成本账目（分区分价 + 最贵对照 = 节省）
```

## 快速开始

要求：**Node ≥ 24**（原生跑 TypeScript，无需构建、零运行时依赖）。

```bash
node src/cli.ts init        # 写配置、分区模板、演示参考目录（58 个 md）
node src/cli.ts dispatch --brief examples/briefs/doc-stats.json --yes
node src/cli.ts demo        # 连续派发 3 个异构任务（代码审查/文档统计/前端页面）
node src/cli.ts ledger      # 今日/累计成本账目
node src/cli.ts history     # 审计流:最近的判断与派发
node --no-warnings=ExperimentalWarning --test test/   # 全部测试
```

默认 **伪 JEV**（TF-IDF 本地判断器）——无 API Key、无 GPU 也能走通全流程，分布与把握度语义与真后端一致。检测到活后端时自动切换。

## 接真实 OpenJev（无云端调用）

```bash
# 你的 RTX 3090 机器上：
git clone https://github.com/razorback16/openjev && cd openjev
docker compose up -d        # 模型就绪后服务在 127.0.0.1:8080

# 本机直接指过去（同一线协议，也可用官方 Jev 托管或 SemIf）：
export JEV_BASE_URL=http://<3090-机器>:8080     # 或 export TYPESAFE_BASE_URL=...
export JEV_MODEL=openjev-latest
node src/cli.ts dispatch --brief examples/briefs/code-review.json --yes --backend auto
```

单次判断延迟实测 70–500ms（OpenJev README 数据：3 问题 ~116ms）。

## 决策规则（M1 核心，见 `src/router/states.ts`）

| 条件 | 四态 | 动作 |
|---|---|---|
| conf ≥ 把握线 0.70 | ✅ 直接执行 | 派发 argmax 分区 |
| 0.40 ≤ conf < 0.70 | 🤔 拿不准 | 默认升级"需要你"；`--on-uncertain proceed` 可续行 |
| conf < 0.40 或前两名并列 | 🙋 需要你 | 交给老板定夺 |
| max(p) ≈ 均匀分布 | 🔙 交回 | 任务书没写清，主 Agent 重写 |

把握度统一公式 `1 − H(p)/lnK`（与 OpenJev 服务端同式）。高危任务（任务书 `highRisk: true`）派发前加一道 noul 门禁。验收失败时 JEV 再判断"要不要改派"，命中则取同分布次优分区重试（`maxRedispatches`）。

## 成本账（spec FR-4）

实际 = 该分区输入/输出 token × 分区单价 + JEV 判断 token × $0.042/1M（输出免费)
对照 = 同样 token 全按最贵分区价。**节省 = 对照 − 实际**。`jev ledger` 实时出，数据来源就是逐次落库计量（claude/codex 实报 usage；其它执行器按字符估算并显式标注"[估算]"）。

## 隐私与审计

- **`judgments`**：每次判断的问题、候选、完整概率分布、置信度、把握线、动作、延迟、token usage
- **`dispatches`**：派发全貌——分区、命令、结果文件路径、noul 概率、评分、改派链
- **`costs`**：逐条 token 用量与两口径金额
- 对话正文（任务书/结果文件）一律**只存 sha256 + 字符数**，不落数据库。

## 分区配置（`config/partitions.json`）

每个分区：名称 / 模型 / 擅长工作类型（路由的语义依据）/ 输入输出单价 / 执行器 argv（占位符 `{prompt} {promptFile} {briefFile} {resultFile} {workdir}`）/ 结果模式。内置 claude-json、codex-jsonl 两种 usage 实测适配器。

## 路线

- **M1 ✅** 决策客户端 + 成本账目 + 单工程经理命令行闭环（任务书→choice→派发→noul 验收→落账）
- **M2** OpenTUI 单屏：JEV 判断面板（复用 `src/ui/bars.ts` 纯函数内核）+ 会话记录
- **M3** 完整办公室：角色条 + 分区工位 + 多工程经理 + 顾问 + 录屏证明

## 免责声明

OpenJev / Jev / SemIf 均为各自作者的项目；本仓库只是架在它们之上的调度层。伪 JEV 仅供演示路由语义，不代表真实模型质量。
