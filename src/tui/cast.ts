/**
 * asciinema .cast 录制器（零依赖）。格式：
 *   第 1 行：JSON header {version:2,width,height,timestamp,env}
 *   之后每行：[时刻秒, "o", 输出文本]
 * 每个 paint() 把整帧写一条事件，asciinema play 即回放成"录屏证明"。
 */
import { createWriteStream, type WriteStream } from "node:fs";

export interface CastWriter {
  /** 写一帧输出；tSec 为相对开场的秒数 */
  write(tSec: number, data: string): void;
  /** 收尾；返回的 Promise 在全部字节落盘后兑现 */
  close(): Promise<void>;
}

export function openCast(file: string, cols: number, rows: number): CastWriter {
  const ws: WriteStream = createWriteStream(file, { encoding: "utf8" });
  ws.write(
    JSON.stringify({
      version: 2,
      width: cols,
      height: rows,
      timestamp: Math.floor(Date.now() / 1000),
      env: { TERM: "xterm-256color" },
    }) + "\n",
  );
  return {
    write(tSec, data) {
      ws.write(JSON.stringify([Math.max(0, tSec), "o", data]) + "\n");
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        ws.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
      });
    },
  };
}
