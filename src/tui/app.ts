/**
 * M2 TUI 薄壳：alternate screen + raw 键盘 + 250ms 重绘。
 * 所有状态流转都交给 state.ts 的 reducer，渲染交给 frame.ts 的纯函数；
 * 这里只做 IO 粘接（键盘/stdin/计时器/派发循环）。
 *
 * 键位：
 *   d    底行输入任务书路径（Enter 派发 · Esc 取消）——派发自动排队，各经理泳道并行取单
 *   q    退出；有派发在跑时先武装一次，再按强制退出
 *   y/n  confirm 模式（执行命令前的人工门禁，M1 的 [y/N] 搬进面板）
 */
import readline from "node:readline";
import type { OfficeConfig, Partition } from "../core/types.ts";
import type { Ledger } from "../ledger/sqlite.ts";
import { fmtUsd } from "../ledger/costs.ts";
import type { SystemOneClient } from "../jev/client.ts";
import { runDispatch, type ManagerEvent } from "../manager/engineering-manager.ts";
import {
  mkInitialState,
  reduce,
  type OfficeSummary,
  type TuiEvent,
  type TuiState,
} from "./state.ts";
import { renderFrame } from "./frame.ts";
import type { CastWriter } from "./cast.ts";

export function readSummary(ledger: Ledger): OfficeSummary {
  const t = ledger.statusToday();
  return {
    judgments: t.judgments,
    byAction: t.byAction,
    byPartition: t.byPartition,
    costUsd: fmtUsd(t.costUsd),
    baselineUsd: fmtUsd(t.baselineUsd),
    savingsUsd: fmtUsd(t.baselineUsd - t.costUsd),
  };
}

export async function runTui(args: {
  config: OfficeConfig;
  partitions: Partition[];
  ledger: Ledger;
  client: SystemOneClient;
  baselineName: string;
  state?: TuiState; // 可选预填（--once 与交互共享 hydration 逻辑）
  cast?: CastWriter; // M3 录屏：非空则每帧同时写 .cast
  castSpeed?: number; // 回放时间压缩倍率（默认 1 = 真实时间）
  skipConfirm?: boolean; // --yes：跳过 [y/N] 门禁（脚本化演示/录屏用）
}): Promise<number> {
  const { config, partitions, ledger, client } = args;
  const state =
    args.state ??
    mkInitialState({
      managerName: config.managerName,
      backendLabel: client.backend === "pseudo" ? `pseudo(${client.label})` : `http ${config.jev.baseUrl}`,
      threshold: config.jev.confidenceThreshold,
      partitions,
      baselineName: args.baselineName,
      managers: config.managers && config.managers.length > 0 ? config.managers : [config.managerName],
      advisorName: config.advisorName ?? "sage",
    });
  const cast = args.cast ?? null;
  const castSpeed = args.castSpeed && args.castSpeed > 0 ? args.castSpeed : 1;
  const castT0 = Date.now();

  const out = process.stdout;
  const inp = process.stdin;
  let dirty = true;
  let exited = false;
  let activeLanes = 0;
  const queue: string[] = [];
  let pendingResolve: ((v: boolean) => void) | null = null;

  const apply = (e: TuiEvent) => {
    reduce(state, e);
    dirty = true;
  };

  const paint = () => {
    if (!dirty || exited) return;
    dirty = false;
    const cols = out.columns || 100;
    const rows = out.rows || 30;
    const lines = renderFrame(state, cols, rows, Date.now());
    const payload = "\x1b[H" + lines.map((l) => l + "\x1b[K").join("\n") + "\n\x1b[J";
    out.write(payload);
    cast?.write((Date.now() - castT0) / 1000 / castSpeed, payload);
  };

  // 把 M1 的 readline [y/N] 搬进面板：挂起派发，等 y/n 键。
  // M3 多经理：两条泳道可能同时到门禁，串行化 —— 后来的排队，一个问完再问下一个。
  let confirmBusy = false;
  const confirmWaiters: Array<() => void> = [];
  const confirmCommand = (_displayCmd: string, _partition: Partition): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const ask = () => {
        pendingResolve = (v) => {
          pendingResolve = null;
          confirmBusy = false;
          const next = confirmWaiters.shift();
          if (next) {
            confirmBusy = true;
            next();
          }
          resolve(v);
        };
        apply({ type: "mode", mode: "confirm" });
        paint();
      };
      if (confirmBusy) {
        confirmWaiters.push(ask);
        apply({ type: "log", text: "另一位经理在门禁排队等待确认…" });
      } else {
        confirmBusy = true;
        ask();
      }
    });

  // M3 多经理：一条泳道一个经理，各自从队列取任务书，并行跑派发。
  const lanes = state.managers.map((m) => m.name);
  const laneWakeups: Array<() => void> = [];

  const lanePump = async (lane: number): Promise<void> => {
    const manager = lanes[lane]!;
    while (!exited) {
      const briefFile = queue.shift();
      if (briefFile === undefined) {
        await new Promise<void>((r) => laneWakeups.push(r));
        continue;
      }
      if (exited) return;
      activeLanes += 1;
      apply({ type: "queue-set", items: [...queue] });
      apply({ type: "owned-start", briefFile, nowMs: Date.now(), lane, manager });
      paint();
      try {
        const outcome = await runDispatch(
          {
            config,
            partitions,
            ledger,
            client,
            emit: (e: ManagerEvent) => apply({ ...e, lane }),
            ...(args.skipConfirm ? {} : { confirmCommand }),
          },
          { briefFile, onUncertain: config.onUncertain, managerName: manager },
        );
        apply({ type: "owned-finish", outcome, lane });
      } catch (err) {
        apply({ type: "error", message: err instanceof Error ? err.message : String(err), lane });
      }
      activeLanes -= 1;
      apply({ type: "summary", summary: readSummary(ledger) });
      apply({ type: "quit-disarm" });
      paint();
    }
  };

  const queueBrief = (file: string): void => {
    queue.push(file);
    apply({ type: "queue-set", items: [...queue] });
    laneWakeups.shift()?.();
  };

  readline.emitKeypressEvents(inp);
  if (inp.isTTY) inp.setRawMode(true);
  out.write("\x1b[?1049h\x1b[?25l");

  const timer = setInterval(() => {
    apply({ type: "tick" });
    if (state.tickCount % 8 === 0) apply({ type: "summary", summary: readSummary(ledger) });
    paint();
  }, 250);

  out.on("resize", () => {
    dirty = true;
    paint();
  });

  const finished = new Promise<number>((resolve) => {
    const quit = (code: number) => {
      if (exited) return;
      exited = true;
      clearInterval(timer);
      // 唤醒所有睡眠泳道，让它们的 while(!exited) 循环退出
      while (laneWakeups.length > 0) laneWakeups.shift()?.();
      if (inp.isTTY) inp.setRawMode(false);
      out.write("\x1b[?25h\x1b[?1049l");
      // 录屏文件必须先落盘完毕再退出（main 里 process.exit 会杀未完成的写流）
      if (cast) void cast.close().then(() => resolve(code));
      else resolve(code);
    };

    inp.on("keypress", (str: string | undefined, key: { name?: string; ctrl?: boolean }) => {
      if (exited) return;
      dirty = true;
      // confirm 门禁：y/n/Esc
      if (state.mode === "confirm") {
        if (str === "y" || str === "Y") {
          pendingResolve?.(true);
          pendingResolve = null;
          apply({ type: "mode", mode: "dashboard" });
        } else if (str === "n" || str === "N" || key?.name === "escape") {
          pendingResolve?.(false);
          pendingResolve = null;
          apply({ type: "mode", mode: "dashboard" });
        }
        paint();
        return;
      }
      // 输入模式：收集任务书路径
      if (state.mode === "input") {
        if (key?.name === "escape") {
          apply({ type: "mode", mode: "dashboard" });
        } else if (key?.name === "return") {
          const v = state.inputBuffer.trim();
          apply({ type: "mode", mode: "dashboard" });
          if (v) queueBrief(v);
        } else if (key?.name === "backspace") {
          apply({ type: "input-set", text: state.inputBuffer.slice(0, -1) });
        } else if (str && str >= " " && !key?.ctrl) {
          apply({ type: "input-set", text: state.inputBuffer + str });
        }
        paint();
        return;
      }
      // dashboard
      if (key?.ctrl && key?.name === "c") return quit(130);
      if (str === "d") {
        apply({ type: "mode", mode: "input" });
        paint();
        return;
      }
      if (str === "q") {
        if (activeLanes > 0 && !state.quitArmed) {
          apply({ type: "quit-arm" });
          paint();
          return;
        }
        return quit(0);
      }
      paint();
    });
  });

  apply({ type: "summary", summary: readSummary(ledger) });
  for (let i = 0; i < lanes.length; i++) void lanePump(i);
  paint();
  return finished;
}
