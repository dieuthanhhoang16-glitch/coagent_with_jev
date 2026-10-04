/**
 * 后端选择：auto 时先探测 http baseUrl，连不上回退 pseudo；
 * 显式 http/pseudo 则无条件使用（http 探测失败时给警告但仍返回 http 客户端，
 * 好让真正的错误暴露在第一笔判断时）。
 */
import type { OfficeConfig } from "../core/types.ts";
import { HttpSystemOneClient } from "./http.ts";
import { PseudoSystemOneClient } from "./pseudo.ts";
import type { SystemOneClient } from "./client.ts";

export async function pickClient(config: OfficeConfig): Promise<{
  client: SystemOneClient;
  note: string;
}> {
  const j = config.jev;
  const makeHttp = () =>
    new HttpSystemOneClient({
      baseUrl: j.baseUrl,
      model: j.model,
      apiKey: j.apiKey,
      timeoutMs: j.timeoutMs,
      label: `${j.baseUrl.replace(/^https?:\/\//, "")}(${j.model})`,
    });
  const makePseudo = () => new PseudoSystemOneClient();

  if (j.backend === "pseudo") {
    return { client: makePseudo(), note: "按配置使用伪 JEV（TF-IDF，本机）" };
  }
  const probe = await HttpSystemOneClient.probe(j.baseUrl, j.apiKey);
  if (j.backend === "http") {
    if (!probe.ok) {
      return {
        client: makeHttp(),
        note: `警告：探测 ${j.baseUrl}/v1/models 失败（${probe.error}），仍按配置使用 http`,
      };
    }
    return {
      client: makeHttp(),
      note: `已连接 System One 后端（models: ${probe.models.join(", ") || "?"}）`,
    };
  }
  // auto
  if (probe.ok) {
    return {
      client: makeHttp(),
      note: `auto 探测到后端 ${j.baseUrl}（models: ${probe.models.join(", ") || "?"}）`,
    };
  }
  return {
    client: makePseudo(),
    note: `auto 未探测到 ${j.baseUrl}（${probe.error}），回退伪 JEV 演示模式`,
  };
}
