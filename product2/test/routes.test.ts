/**
 * 路由层测试（不依赖 D1 / 网络）：直接调用 void 的 handler，
 * 用 _store 注入内存实现、_deps 注入假流水线依赖。
 */

import { assert, assertEqual, describe, it } from "./harness.ts";
import { POST as generatePOST } from "../routes/api/generate.ts";
import { GET as jobsGET, DELETE as jobsDELETE } from "../routes/api/jobs.ts";
import { createMemoryStore } from "../lib/store.ts";
import type { GenerationJob } from "../lib/types.ts";

const NOTE_RAW = `[标题]
路由测试标题
[正文]
这是一段足够长的正文内容，用于通过可用性校验，确保路由测试可以跑通完整链路。
[标签]
#一 #二 #三`;

type Handler = (c: unknown) => Promise<Response> | Response;

/** 构造最小 Context：void handler 只用 req/env/_xxx */
function makeCtx(opts: {
  method?: string;
  url?: string;
  body?: unknown;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  store?: ReturnType<typeof createMemoryStore>;
  deps?: Record<string, unknown>;
}): unknown {
  const url = opts.url ?? "http://localhost/api/test";
  const headers = new Headers(opts.headers ?? {});
  return {
    req: {
      url,
      raw: new Request(url, { method: opts.method ?? "GET", headers }),
      header: (name: string) => headers.get(name) ?? undefined,
      json: async () => {
        if (opts.body === undefined) throw new Error("no body");
        return opts.body;
      },
    },
    env: opts.env ?? { MAGPIE_BASE_URL: "https://mock/v1", MAGPIE_API_KEY: "k", MAGPIE_MODEL: "m" },
    _store: opts.store,
    _deps: opts.deps,
  };
}

/** 读取 SSE 响应，返回结构化事件 */
async function readSse(resp: Response): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const text = await resp.text();
  const out: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let event = "message";
    const dataLines: string[] = [];
    for (const raw of block.split("\n")) {
      const line = raw.replace(/\r$/, "");
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length) out.push({ event, data: JSON.parse(dataLines.join("\n")) });
  }
  return out;
}

const okDeps = {
  fetchArticle: async () => ({ text: "抓取到的正文", title: "T" }),
  callLLM: async () => "要点",
  streamLLM: async function* () {
    yield NOTE_RAW;
  },
};

describe("generate — 准入与错误码", () => {
  it("未配置令牌时放行", async () => {
    const resp = await (generatePOST as Handler)(
      makeCtx({ method: "POST", body: { sourceType: "text", text: "素材" }, deps: okDeps, store: createMemoryStore() }),
    );
    assertEqual(resp.status, 200);
    assertEqual(resp.headers.get("content-type")?.includes("text/event-stream"), true);
    // 必须把流读完：未消费的 SSE 流会让 void/sse 的 keepAlive interval 悬着（测试会挂住不退出）
    const events = await readSse(resp);
    assert(events.some((e) => e.event === "done"), "应收到 done");
  });

  it("配置令牌后缺失头 → 401", async () => {
    const resp = await (generatePOST as Handler)(
      makeCtx({
        method: "POST",
        body: { sourceType: "text", text: "x" },
        env: { MAGPIE_BASE_URL: "https://m", MAGPIE_API_KEY: "k", ACCESS_TOKEN: "s3cret" },
        deps: okDeps,
        store: createMemoryStore(),
      }),
    );
    assertEqual(resp.status, 401);
    const body = (await resp.json()) as { error: string };
    assert(body.error.includes("令牌"));
  });

  it("请求体非 JSON → 400", async () => {
    const resp = await (generatePOST as Handler)(makeCtx({ method: "POST", deps: okDeps }));
    assertEqual(resp.status, 400);
  });

  it("缺 sourceType → 400", async () => {
    const resp = await (generatePOST as Handler)(makeCtx({ method: "POST", body: {}, deps: okDeps }));
    assertEqual(resp.status, 400);
  });

  it("text 模式空文本 → 400", async () => {
    const resp = await (generatePOST as Handler)(
      makeCtx({ method: "POST", body: { sourceType: "text", text: "  " }, deps: okDeps }),
    );
    assertEqual(resp.status, 400);
  });

  it("url 模式空链接 → 400", async () => {
    const resp = await (generatePOST as Handler)(
      makeCtx({ method: "POST", body: { sourceType: "url", url: "" }, deps: okDeps }),
    );
    assertEqual(resp.status, 400);
  });

  it("未配置上游 → 503 且文案不含堆栈", async () => {
    const resp = await (generatePOST as Handler)(
      makeCtx({
        method: "POST",
        body: { sourceType: "text", text: "x" },
        env: {},
        deps: okDeps,
      }),
    );
    assertEqual(resp.status, 503);
    const body = (await resp.json()) as { error: string };
    assert(body.error.includes("未配置"), `实际：${body.error}`);
    assert(!body.error.includes("at "), "不应含堆栈");
  });
});

describe("generate — 成功路径（SSE 事件序列）", () => {
  it("step* → token* → done，且落库", async () => {
    const store = createMemoryStore();
    const resp = await (generatePOST as Handler)(
      makeCtx({ method: "POST", body: { sourceType: "text", text: "素材" }, deps: okDeps, store }),
    );
    const events = await readSse(resp);

    assert(events.some((e) => e.event === "step" && e.data.step === "fetch"), "应有 fetch 步骤事件");
    assert(events.filter((e) => e.event === "token").length >= 1, "应有 token 事件");
    const done = events.find((e) => e.event === "done");
    assert(done !== undefined, "应有 done 事件");
    assertEqual(done!.data.persisted, true);

    const job = done!.data.job as GenerationJob;
    assertEqual(job.sourceType, "text");
    const saved = await store.get(job.id);
    assert(saved !== null, "应已落库");
    assertEqual(saved!.note?.titles[0], "路由测试标题");
  });

  it("存储失败时仍返回结果，但标记 persisted=false 并给 warning", async () => {
    const brokenStore = {
      insert: async () => {
        throw new Error("D1 down");
      },
      list: async () => [],
      get: async () => null,
      remove: async () => false,
    };
    const resp = await (generatePOST as Handler)(
      makeCtx({ method: "POST", body: { sourceType: "text", text: "素材" }, deps: okDeps, store: brokenStore as never }),
    );
    const events = await readSse(resp);
    const done = events.find((e) => e.event === "done");
    assertEqual(done!.data.persisted, false);
    assert(String(done!.data.warning).includes("保存失败"));
  });

  it("流水线失败 → error 事件（不产生 done、不落库）", async () => {
    const store = createMemoryStore();
    const resp = await (generatePOST as Handler)(
      makeCtx({
        method: "POST",
        body: { sourceType: "url", url: "https://example.com/x" },
        deps: {
          ...okDeps,
          fetchArticle: async () => {
            throw new Error("抓取超时，请稍后重试或改用「粘贴文本」。");
          },
        },
        store,
      }),
    );
    const events = await readSse(resp);
    assert(!events.some((e) => e.event === "done"), "不应有 done");
    const err = events.find((e) => e.event === "error");
    assert(err !== undefined, "应有 error");
    assertEqual(err!.data.phase, "fetch");
    assert(String(err!.data.hint).includes("粘贴"), "抓取失败应带粘贴引导");
    assertEqual((await store.list()).length, 0, "失败不应落库");
  });
});

describe("jobs — 列表/详情/删除", () => {
  async function seeded() {
    const store = createMemoryStore();
    const job: GenerationJob = {
      id: "job-1",
      createdAt: 2000,
      sourceType: "text",
      sourceUrl: null,
      sourceExcerpt: "摘要文本",
      sourceText: "完整素材原文",
      materialBrief: null,
      note: { titles: ["标题A"], body: "正文".repeat(30), tags: ["t1"] },
      status: "succeeded",
      error: null,
    };
    await store.insert(job);
    return store;
  }

  it("列表返回记录且不含 sourceText（省流量）", async () => {
    const store = await seeded();
    const resp = await (jobsGET as Handler)(makeCtx({ store }));
    assertEqual(resp.status, 200);
    const data = (await resp.json()) as { jobs: Array<Record<string, unknown>> };
    assertEqual(data.jobs.length, 1);
    assertEqual(data.jobs[0].id, "job-1");
    assert(!("sourceText" in data.jobs[0]), "列表不应带原文");
    assert(!("materialBrief" in data.jobs[0]), "列表不应带压缩要点");
  });

  it("按 id 取详情含原文（重新生成需要）", async () => {
    const store = await seeded();
    const resp = await (jobsGET as Handler)(
      makeCtx({ store, url: "http://localhost/api/jobs?id=job-1" }),
    );
    const data = (await resp.json()) as { job: GenerationJob };
    assertEqual(data.job.sourceText, "完整素材原文");
  });

  it("不存在的 id → 404", async () => {
    const store = await seeded();
    const resp = await (jobsGET as Handler)(makeCtx({ store, url: "http://localhost/api/jobs?id=nope" }));
    assertEqual(resp.status, 404);
  });

  it("删除存在项 → 200 且列表变空", async () => {
    const store = await seeded();
    const resp = await (jobsDELETE as Handler)(
      makeCtx({ method: "DELETE", store, url: "http://localhost/api/jobs?id=job-1" }),
    );
    assertEqual(resp.status, 200);
    const listResp = await (jobsGET as Handler)(makeCtx({ store }));
    const list = (await listResp.json()) as { jobs: unknown[] };
    assertEqual(list.jobs.length, 0);
  });

  it("删除缺 id → 400", async () => {
    const store = await seeded();
    const resp = await (jobsDELETE as Handler)(makeCtx({ method: "DELETE", store }));
    assertEqual(resp.status, 400);
  });

  it("令牌错误 → 401", async () => {
    const store = await seeded();
    const resp = await (jobsGET as Handler)(
      makeCtx({ store, env: { ACCESS_TOKEN: "s3cret" } }),
    );
    assertEqual(resp.status, 401);
  });
});
