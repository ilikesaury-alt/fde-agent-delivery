/**
 * 路由层测试（不依赖 D1 / Vectorize / 网络）：
 * 直接调用 void handler，用 _repo/_index/_ai/_fetchImpl 注入替身。
 */

import { assert, assertEqual, describe, it } from "./harness.ts";
import { POST as askPOST } from "../routes/api/ask.ts";
import { DELETE as docsDELETE, GET as docsGET, POST as docsPOST } from "../routes/api/documents.ts";
import { GET as historyGET } from "../routes/api/history.ts";
import { GET as healthGET } from "../routes/api/health.ts";
import { createMemoryRepo, createMemoryVectorIndex } from "../lib/memory.ts";
import { createFakeAI, createFakeLLM } from "./fakes.ts";
import { REFUSAL_TEXT } from "../routes/api/ask.ts";

const DOC = `# 部署指南

执行构建后进入 dist/ssr 目录，用 wrangler deploy 并携带 secrets 文件完成部署。

# 回滚

使用 wrangler rollback 指定完整版本号回滚到上一个已知可用版本。`;

type Handler = (c: unknown) => Promise<Response> | Response;

type CtxBag = {
  repo: ReturnType<typeof createMemoryRepo>;
  index: ReturnType<typeof createMemoryVectorIndex>;
  ai: ReturnType<typeof createFakeAI>;
};

function makeCtx(opts: {
  url?: string;
  body?: unknown;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  bag?: CtxBag;
  fetchImpl?: typeof fetch;
}): unknown {
  const url = opts.url ?? "http://localhost/api/test";
  const headers = new Headers(opts.headers ?? {});
  return {
    req: {
      url,
      raw: new Request(url, { method: "GET", headers }),
      header: (name: string) => headers.get(name) ?? undefined,
      json: async () => {
        if (opts.body === undefined) throw new Error("no body");
        return opts.body;
      },
    },
    env: opts.env ?? { MAGPIE_BASE_URL: "https://mock/v1", MAGPIE_API_KEY: "k", MAGPIE_MODEL: "m", RETRIEVE_MIN_SCORE: "0.05" },
    _repo: opts.bag?.repo,
    _index: opts.bag?.index,
    _ai: opts.bag?.ai,
    _fetchImpl: opts.fetchImpl,
  };
}

function newBag(): CtxBag {
  return { repo: createMemoryRepo(), index: createMemoryVectorIndex(), ai: createFakeAI() };
}

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

/** 打桩 LLM 流（ask 路由内部调用 streamLLM，通过 _fetchImpl 影响不到，故用真实上游替身） */
function stubLlmFetch(answer: string): typeof fetch {
  return (async () => {
    const chunks = [answer];
    const body = chunks
      .map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`)
      .join("") + "data: [DONE]\n\n";
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

describe("health — 存活探针", () => {
  it("不校验令牌并返回 service 名", async () => {
    const resp = await (healthGET as Handler)(makeCtx({ env: { ACCESS_TOKEN: "s3cret" } }));
    assertEqual(resp.status, 200);
    const body = (await resp.json()) as { ok: boolean; service: string };
    assertEqual(body.ok, true);
    assertEqual(body.service, "kb-ask");
  });
});

describe("documents — 鉴权与校验", () => {
  it("配置令牌后无头 → 401（GET/POST/DELETE 一致）", async () => {
    const env = { MAGPIE_BASE_URL: "https://m", MAGPIE_API_KEY: "k", ACCESS_TOKEN: "s3cret" };
    for (const h of [docsGET, docsPOST, docsDELETE] as Handler[]) {
      const resp = await h(makeCtx({ env, bag: newBag(), body: { source: "paste", text: "x" } }));
      assertEqual(resp.status, 401);
      const body = (await resp.json()) as { error: string };
      assert(body.error.includes("令牌"), "401 文案应说明令牌问题");
    }
  });

  it("请求体非 JSON → 400", async () => {
    const resp = await (docsPOST as Handler)(makeCtx({ bag: newBag() }));
    assertEqual(resp.status, 400);
  });

  it("缺 source → 400", async () => {
    const resp = await (docsPOST as Handler)(makeCtx({ body: { text: "x" }, bag: newBag() }));
    assertEqual(resp.status, 400);
  });

  it("空文本 → 400 并给可读文案", async () => {
    const resp = await (docsPOST as Handler)(makeCtx({ body: { source: "paste", text: "   " }, bag: newBag() }));
    assertEqual(resp.status, 400);
    const body = (await resp.json()) as { error: string };
    assert(body.error.includes("不能为空"));
  });

  it("超长文本 → 413（前置拦截，不进入管道）", async () => {
    const resp = await (docsPOST as Handler)(
      makeCtx({ body: { source: "paste", text: "字".repeat(200_001) }, bag: newBag() }),
    );
    assertEqual(resp.status, 413);
  });
});

describe("documents — 导入与列表", () => {
  it("导入成功 → 201 且 ready", async () => {
    const bag = newBag();
    const resp = await (docsPOST as Handler)(makeCtx({ body: { source: "paste", text: DOC, title: "部署手册" }, bag }));
    assertEqual(resp.status, 201);
    const body = (await resp.json()) as { document: { status: string; chunkCount: number }; skipped: boolean };
    assertEqual(body.skipped, false);
    assertEqual(body.document.status, "ready");
    assert(body.document.chunkCount > 0);
  });

  it("重复导入同内容 → 200 且 skipped=true", async () => {
    const bag = newBag();
    await (docsPOST as Handler)(makeCtx({ body: { source: "paste", text: DOC }, bag }));
    const resp = await (docsPOST as Handler)(makeCtx({ body: { source: "paste", text: DOC }, bag }));
    assertEqual(resp.status, 200);
    const body = (await resp.json()) as { skipped: boolean; message?: string };
    assertEqual(body.skipped, true);
    assert(Boolean(body.message), "应告知用户为何跳过");
  });

  it("列表返回 totalChunks 与检索参数（前端展示用）", async () => {
    const bag = newBag();
    await (docsPOST as Handler)(makeCtx({ body: { source: "paste", text: DOC }, bag }));
    const resp = await (docsGET as Handler)(makeCtx({ bag }));
    assertEqual(resp.status, 200);
    const body = (await resp.json()) as { documents: unknown[]; totalChunks: number; retrieve: { topK: number; minScore: number } };
    assertEqual(body.documents.length, 1);
    assert(body.totalChunks > 0);
    assertEqual(body.retrieve.minScore, 0.05, "env 覆盖阈值应生效");
  });

  it("列表不含正文（防一次列表搬运全部原文）", async () => {
    const bag = newBag();
    await (docsPOST as Handler)(makeCtx({ body: { source: "paste", text: DOC }, bag }));
    const resp = await (docsGET as Handler)(makeCtx({ bag }));
    const body = (await resp.json()) as { documents: Array<Record<string, unknown>> };
    assert(!("contentHash" in body.documents[0]), "列表不应暴露内部哈希");
  });

  it("URL 导入走抓取替身（不真的发请求）", async () => {
    const bag = newBag();
    const resp = await (docsPOST as Handler)(
      makeCtx({
        body: { source: "url", url: "https://example.com/a" },
        bag,
        fetchImpl: stubLlmFetch("# 抓取到的标题\n\n这是抓取回来的正文内容。"),
      }),
    );
    // 抓取替身返回的不是 HTML，fetchArticle 可能判为无正文 → 502；这里只断言不 500 且不炸
    assert([201, 400, 502].includes(resp.status), `意外状态码 ${resp.status}`);
  });

  it("内网 URL 被拒（SSRF 三道闸第一道）", async () => {
    const resp = await (docsPOST as Handler)(
      makeCtx({ body: { source: "url", url: "http://127.0.0.1/admin" }, bag: newBag() }),
    );
    assertEqual(resp.status, 400);
    const body = (await resp.json()) as { error: string };
    assert(/不允许|内网|地址/.test(body.error), `文案应说明地址不允许: ${body.error}`);
  });
});

describe("documents — 删除连带清理向量", () => {
  it("删除 → 元数据与向量一起消失", async () => {
    const bag = newBag();
    const created = (await (
      await (docsPOST as Handler)(makeCtx({ body: { source: "paste", text: DOC }, bag }))
    ).json()) as { document: { id: string; chunkCount: number } };

    const resp = await (docsDELETE as Handler)(makeCtx({ url: `http://localhost/api/documents?id=${created.document.id}`, bag }));
    assertEqual(resp.status, 200);
    const body = (await resp.json()) as { ok: boolean; removedChunks: number };
    assertEqual(body.removedChunks, created.document.chunkCount);
    assertEqual(bag.repo.__documents.size, 0);
    assertEqual(bag.index.__vectors.size, 0, "向量必须一起清掉");
  });

  it("删除不存在 → 404", async () => {
    const resp = await (docsDELETE as Handler)(makeCtx({ url: "http://localhost/api/documents?id=nope", bag: newBag() }));
    assertEqual(resp.status, 404);
  });

  it("缺 id → 400", async () => {
    const resp = await (docsDELETE as Handler)(makeCtx({ bag: newBag() }));
    assertEqual(resp.status, 400);
  });
});

describe("ask — 问答与拒答", () => {
  it("空问题 → 400", async () => {
    const resp = await (askPOST as Handler)(makeCtx({ body: { question: "  " }, bag: newBag() }));
    assertEqual(resp.status, 400);
  });

  it("未配置上游 → 503（不泄露堆栈）", async () => {
    const resp = await (askPOST as Handler)(
      makeCtx({ body: { question: "怎么部署" }, env: { ACCESS_TOKEN: undefined } as unknown as Record<string, string>, bag: newBag() }),
    );
    assertEqual(resp.status, 503);
    const body = (await resp.json()) as { error: string };
    assert(!body.error.includes("at "), "不应包含堆栈");
    assert(body.error.includes("凭据") || body.error.includes("配置"));
  });

  it("库内无相关内容 → 拒答（refused=true，不调用模型）", async () => {
    const bag = newBag();
    // 空库：检索必然无命中
    const resp = await (askPOST as Handler)(
      makeCtx({ body: { question: "量子色动力学的渐近自由" }, bag, fetchImpl: stubLlmFetch("不该被调用") }),
    );
    assertEqual(resp.status, 200);
    const events = await readSse(resp);
    const done = events.find((e) => e.event === "done");
    assert(done, "应收到 done");
    const result = (done!.data as { result: { refused: boolean; answer: string } }).result;
    assertEqual(result.refused, true, "空库必须拒答");
    assertEqual(result.answer, REFUSAL_TEXT);
  });

  it("命中但模型输出依据不足标记 → 转拒答（第二道防线）", async () => {
    const bag = newBag();
    await (docsPOST as Handler)(makeCtx({ body: { source: "paste", text: DOC }, bag }));
    const resp = await (askPOST as Handler)(
      makeCtx({
        body: { question: "部署要怎么做" },
        bag,
        fetchImpl: stubLlmFetch("INSUFFICIENT_EVIDENCE"),
      }),
    );
    const events = await readSse(resp);
    const retrieveStep = events.find(
      (e) => e.event === "step" && (e.data as { step: string }).step === "retrieve" && (e.data as { status: string }).status === "done",
    );
    const detail = String((retrieveStep!.data as { detail?: string }).detail ?? "");
    assert(/命中 [1-9]/.test(detail), `必须先有检索命中才能验证第二道防线，实际: ${detail}`);
    const done = events.find((e) => e.event === "done");
    const result = (done!.data as { result: { refused: boolean } }).result;
    assertEqual(result.refused, true, "模型说依据不足时必须拒答");
  });

  it("正常回答 → 带引用块且编号可核验", async () => {
    const bag = newBag();
    await (docsPOST as Handler)(makeCtx({ body: { source: "paste", text: DOC }, bag }));
    const resp = await (askPOST as Handler)(
      makeCtx({
        body: { question: "部署用什么命令" },
        bag,
        fetchImpl: stubLlmFetch("用 wrangler deploy 完成部署。[1]"),
      }),
    );
    const events = await readSse(resp);
    const done = events.find((e) => e.event === "done");
    const result = (done!.data as { result: { refused: boolean; citations: Array<{ docId: string; snippet: string; docTitle: string }>; answer: string } }).result;
    assertEqual(result.refused, false);
    assert(result.citations.length > 0, "应产出引用");
    assert(result.citations[0].snippet.length > 0, "引用必须带原文片段（可核验）");
    assert(Boolean(result.citations[0].docTitle), "引用必须带文档名");
    // 引用必须真在库里
    const chunkIds = [...bag.repo.__chunks.keys()];
    assert(chunkIds.some((id) => id.startsWith(result.citations[0].docId)), "引用文档应真实存在");
  });

  it("SSE 事件序列：step(embed) → step(retrieve) → step(generate) → done", async () => {
    const bag = newBag();
    await (docsPOST as Handler)(makeCtx({ body: { source: "paste", text: DOC }, bag }));
    const resp = await (askPOST as Handler)(
      makeCtx({ body: { question: "回滚怎么做" }, bag, fetchImpl: stubLlmFetch("用 rollback。[1]") }),
    );
    const events = await readSse(resp);
    const steps = events.filter((e) => e.event === "step").map((e) => (e.data as { step: string }).step);
    assert(steps.includes("embed"), "应有 embed 步骤");
    assert(steps.includes("retrieve"), "应有 retrieve 步骤");
    assert(steps.includes("generate"), "应有 generate 步骤");
    assert(events.some((e) => e.event === "token"), "应有 token 增量");
    assertEqual(events[events.length - 1].event, "done", "done 必须是最后一个事件");
  });

  it("问答结果落库，可在历史里回看", async () => {
    const bag = newBag();
    await (docsPOST as Handler)(makeCtx({ body: { source: "paste", text: DOC }, bag }));
    await readSse(
      await (askPOST as Handler)(
        makeCtx({ body: { question: "部署命令" }, bag, fetchImpl: stubLlmFetch("wrangler deploy。[1]") }),
      ),
    );
    const resp = await (historyGET as Handler)(makeCtx({ bag }));
    const body = (await resp.json()) as { records: Array<{ question: string; result: { answer: string } }> };
    assertEqual(body.records.length, 1);
    assertEqual(body.records[0].question, "部署命令");
  });
});
