/**
 * 路由层测试（不依赖 D1 / Vectorize / 网络）：
 * 直接调用 void handler，用 _repo/_index/_ai/_fetchImpl 注入替身。
 */

import { assert, assertEqual, describe, it } from "./harness.ts";
import { POST as askPOST } from "../routes/api/ask.ts";
import { DELETE as docsDELETE, GET as docsGET, POST as docsPOST } from "../routes/api/documents.ts";
import { GET as historyGET } from "../routes/api/history.ts";
import { DELETE as convDELETE, GET as convGET } from "../routes/api/conversations.ts";
import { POST as ocrPOST } from "../routes/api/ocr.ts";
import { POST as probePOST } from "../routes/api/probe.ts";
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
    assertEqual(bag.repo.__terms.size, 0, "关键词倒排也必须一起清掉（否则孤儿片段会被关键词通道召回）");
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

// ── 索引延迟提示（线上实测：导入后 0–40s 必拒答，第 50s 才命中）────────
describe("拒答时的「刚导入的文档可能还在索引中」提示", () => {
  it("库内有 90 秒内刚导入的文档 → refused 结果带 indexingRecently=true", async () => {
    const bag = newBag();
    await (docsPOST as Handler)(makeCtx({ body: { source: "paste", text: DOC }, bag }));
    const resp = await (askPOST as Handler)(
      makeCtx({ body: { question: "量子色动力学的渐近自由" }, bag, fetchImpl: stubLlmFetch("不该被调用") }),
    );
    const events = await readSse(resp);
    const result = (events.find((e) => e.event === "done")!.data as {
      result: { refused: boolean; indexingRecently?: boolean };
    }).result;
    assertEqual(result.refused, true);
    assertEqual(result.indexingRecently, true, "刚导入就拒答，必须提示索引尚未生效");
  });

  it("索引早已完成（indexedAt 很旧）→ 不带该提示", async () => {
    const bag = newBag();
    const imported = await (docsPOST as Handler)(makeCtx({ body: { source: "paste", text: DOC }, bag }));
    const doc = ((await imported.json()) as { document: { id: string } }).document;
    await bag.repo.updateDocument(doc.id, { indexedAt: Date.now() - 10 * 60_000 });

    const resp = await (askPOST as Handler)(
      makeCtx({ body: { question: "量子色动力学的渐近自由" }, bag, fetchImpl: stubLlmFetch("不该被调用") }),
    );
    const events = await readSse(resp);
    const result = (events.find((e) => e.event === "done")!.data as {
      result: { refused: boolean; indexingRecently?: boolean };
    }).result;
    assertEqual(result.refused, true);
    assertEqual(result.indexingRecently, undefined, "旧的文档不应触发索引提示");
  });
});

// ── 二期：多轮会话（A1）──────────────────────────────────────────

/** 打桩 LLM 并记录请求体（用于断言 prompt 里到底塞了什么） */
function captureLlmFetch(answer: string, seen: string[]): typeof fetch {
  return (async (_url: unknown, init?: { body?: unknown }) => {
    seen.push(String(init?.body ?? ""));
    const body = `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\ndata: [DONE]\n\n`;
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

describe("ask — 多轮会话", () => {
  async function askOnce(bag: CtxBag, body: Record<string, unknown>, answer = "wrangler deploy。[1]") {
    const events = await readSse(await (askPOST as Handler)(makeCtx({ body, bag, fetchImpl: stubLlmFetch(answer) })));
    return events.find((e) => e.event === "done")!.data as {
      result: { refused: boolean; retrievalQuery?: string; rewritten?: boolean };
      conversationId?: string;
      messageId?: string;
      persisted: boolean;
    };
  }

  it("首问自动建会话，并把 conversationId / messageId 返回给前端", async () => {
    const bag = newBag();
    await (docsPOST as Handler)(makeCtx({ body: { source: "paste", text: DOC }, bag }));
    const d = await askOnce(bag, { question: "部署用什么命令" });
    assert(Boolean(d.conversationId), "首次提问必须返回 conversationId（前端靠它继续追问）");
    assert(Boolean(d.messageId), "应返回 messageId");
    assertEqual(d.persisted, true);
    assertEqual(bag.repo.__messages.length, 1);
  });

  it("追问复用同一会话，且检索查询被规则改写", async () => {
    const bag = newBag();
    await (docsPOST as Handler)(makeCtx({ body: { source: "paste", text: DOC }, bag }));
    const first = await askOnce(bag, { question: "回滚怎么做" });

    const d = await askOnce(bag, { question: "它需要注意什么？", conversationId: first.conversationId });
    assertEqual(d.conversationId, first.conversationId, "必须在同一会话里");
    assertEqual(d.result.rewritten, true, "指代式追问应被改写");
    assert(
      String(d.result.retrievalQuery).includes("回滚怎么做"),
      `改写后的查询应带上上一轮问题: ${d.result.retrievalQuery}`,
    );
    assertEqual(bag.repo.__messages.length, 2, "两轮都落库");
  });

  it("生成 prompt 带上历史块，且声明不构成回答依据", async () => {
    const bag = newBag();
    await (docsPOST as Handler)(makeCtx({ body: { source: "paste", text: DOC }, bag }));
    const first = await askOnce(bag, { question: "回滚怎么做" });

    const seen: string[] = [];
    const events = await readSse(
      await (askPOST as Handler)(
        makeCtx({
          body: { question: "它呢？", conversationId: first.conversationId },
          bag,
          fetchImpl: captureLlmFetch("用 rollback。[1]", seen),
        }),
      ),
    );
    assert(events.some((e) => e.event === "done"));
    assertEqual(seen.length, 1);
    assert(seen[0].includes("不构成回答依据"), "历史块必须声明它不是依据（防跨轮幻觉继承）");
    assert(seen[0].includes("回滚怎么做"), "历史块应包含上一轮问题");
  });

  it("幽灵 conversationId → 404（不默默新建）", async () => {
    const resp = await (askPOST as Handler)(
      makeCtx({ body: { question: "部署", conversationId: "conv_nope" }, bag: newBag() }),
    );
    assertEqual(resp.status, 404);
    const body = (await resp.json()) as { error: string };
    assert(body.error.includes("会话"), `文案应指向会话: ${body.error}`);
  });

  it("无依据也不影响建会话与落库（拒答轮同样可回看）", async () => {
    const bag = newBag();
    const d = await askOnce(bag, { question: "量子色动力学的渐近自由" });
    assertEqual(d.result.refused, true);
    assert(Boolean(d.conversationId), "空库提问也应建会话");
    assertEqual(bag.repo.__messages.length, 1);
    assertEqual(bag.repo.__messages[0].refused, true);
  });

  it("关闭改写开关（CONTEXT_REWRITE=0）→ 追问不被改写", async () => {
    const bag = newBag();
    await (docsPOST as Handler)(makeCtx({ body: { source: "paste", text: DOC }, bag }));
    const first = await askOnce(bag, { question: "回滚怎么做" });
    const events = await readSse(
      await (askPOST as Handler)(
        makeCtx({
          body: { question: "它呢？", conversationId: first.conversationId },
          bag,
          env: {
            MAGPIE_BASE_URL: "https://mock/v1",
            MAGPIE_API_KEY: "k",
            MAGPIE_MODEL: "m",
            RETRIEVE_MIN_SCORE: "0.05",
            CONTEXT_REWRITE: "0",
          },
          fetchImpl: stubLlmFetch("用 rollback。[1]"),
        }),
      ),
    );
    const result = (events.find((e) => e.event === "done")!.data as {
      result: { rewritten?: boolean; retrievalQuery?: string };
    }).result;
    assertEqual(result.rewritten, false, "开关关闭时必须按原问题检索（消融对比用）");
    assertEqual(result.retrievalQuery, "它呢？");
  });
});

describe("conversations — 会话管理", () => {
  async function seeded() {
    const bag = newBag();
    await (docsPOST as Handler)(makeCtx({ body: { source: "paste", text: DOC }, bag }));
    const events = await readSse(
      await (askPOST as Handler)(
        makeCtx({ body: { question: "部署命令" }, bag, fetchImpl: stubLlmFetch("wrangler deploy。[1]") }),
      ),
    );
    const d = events.find((e) => e.event === "done")!.data as { conversationId: string };
    return { bag, conversationId: d.conversationId };
  }

  it("缺令牌 → 401（GET / DELETE）", async () => {
    const env = { MAGPIE_BASE_URL: "https://m", MAGPIE_API_KEY: "k", ACCESS_TOKEN: "s3cret" };
    for (const h of [convGET, convDELETE] as Handler[]) {
      const resp = await h(makeCtx({ env, bag: newBag() }));
      assertEqual(resp.status, 401);
    }
  });

  it("列表含轮数；详情按时间正序返回消息", async () => {
    const { bag, conversationId } = await seeded();
    const convResp = await (convGET as Handler)(makeCtx({ bag }));
    const list = (await convResp.json()) as {
      conversations: Array<{ id: string; turnCount: number; title: string }>;
    };
    assertEqual(list.conversations.length, 1);
    assertEqual(list.conversations[0].id, conversationId);
    assertEqual(list.conversations[0].turnCount, 1);
    assertEqual(list.conversations[0].title, "部署命令", "标题取首问");

    const detail = (await (
      await (convGET as Handler)(makeCtx({ url: `http://localhost/api/conversations?id=${conversationId}`, bag }))
    ).json()) as { conversation: { id: string }; messages: Array<{ question: string }> };
    assertEqual(detail.conversation.id, conversationId);
    assertEqual(detail.messages.length, 1);
    assertEqual(detail.messages[0].question, "部署命令");
  });

  it("不存在的会话 → 404（GET / DELETE）", async () => {
    const bag = newBag();
    for (const h of [convGET, convDELETE] as Handler[]) {
      const resp = await h(makeCtx({ url: "http://localhost/api/conversations?id=nope", bag }));
      assertEqual(resp.status, 404);
    }
  });

  it("删除会话连带消息，并返回删除条数", async () => {
    const { bag, conversationId } = await seeded();
    const resp = await (convDELETE as Handler)(
      makeCtx({ url: `http://localhost/api/conversations?id=${conversationId}`, bag }),
    );
    assertEqual(resp.status, 200);
    const body = (await resp.json()) as { ok: boolean; removedMessages: number };
    assertEqual(body.removedMessages, 1);
    assertEqual(bag.repo.__conversations.size, 0);
    assertEqual(bag.repo.__messages.length, 0);
  });

  it("缺 id → 400", async () => {
    const resp = await (convDELETE as Handler)(makeCtx({ bag: newBag() }));
    assertEqual(resp.status, 400);
  });
});

// ── 二期：历史接口改读 messages（D23）──────────────────────────────
describe("history — 新真源与兼容读", () => {
  it("默认读会话消息；includeLegacy=1 时一并带出一期 qa_history", async () => {
    const bag = newBag();
    await (docsPOST as Handler)(makeCtx({ body: { source: "paste", text: DOC }, bag }));
    await readSse(
      await (askPOST as Handler)(makeCtx({ body: { question: "部署命令" }, bag, fetchImpl: stubLlmFetch("deploy。[1]") })),
    );
    // 造一条一期遗留记录（二期不再写入，只为兼容读验证）
    await bag.repo.insertQa({
      id: "qa_legacy",
      question: "旧的提问",
      result: { answer: "旧的回答", citations: [], refused: false },
      citedDocIds: [],
      createdAt: Date.now() - 60_000,
    });

    const histResp = await (historyGET as Handler)(makeCtx({ bag }));
    const naive = (await histResp.json()) as { records: Array<{ id: string }> };
    assertEqual(naive.records.length, 1, "默认只读 messages（不含旧表）");

    const withLegacy = (await (
      await (historyGET as Handler)(makeCtx({ url: "http://localhost/api/history?includeLegacy=1", bag }))
    ).json()) as { records: Array<{ id: string }>; legacyIncluded: boolean };
    assertEqual(withLegacy.legacyIncluded, true);
    assertEqual(withLegacy.records.length, 2, "带 legacy 时两条都在");
    assert(withLegacy.records.some((r) => r.id === "qa_legacy"));
  });
});

// ── 二期：索引探针（A5）────────────────────────────────────────────
describe("probe — 索引可见性探针", () => {
  async function seedReady() {
    const bag = newBag();
    const created = (await (
      await (docsPOST as Handler)(makeCtx({ body: { source: "paste", text: DOC }, bag }))
    ).json()) as { document: { id: string } };
    return { bag, docId: created.document.id };
  }

  it("向量可检索 → searchable=true", async () => {
    const { bag, docId } = await seedReady();
    const resp = await (probePOST as Handler)(makeCtx({ body: { id: docId }, bag }));
    assertEqual(resp.status, 200);
    const body = (await resp.json()) as { searchable: boolean; checked: number; matches: string[] };
    assertEqual(body.searchable, true);
    assert(body.checked >= 1);
    assert(body.matches.length >= 1, "应报出命中的 chunk id");
  });

  it("向量尚未可见 → 200 + searchable=false（「还没好」不是错误）", async () => {
    const { bag, docId } = await seedReady();
    // 模拟 Vectorize 异步窗口：索引里暂时没有这些向量
    for (const id of [...bag.index.__vectors.keys()]) bag.index.__vectors.delete(id);
    const resp = await (probePOST as Handler)(makeCtx({ body: { id: docId }, bag }));
    assertEqual(resp.status, 200, "探测不到不得回 5xx，否则用户以为导入坏了");
    const body = (await resp.json()) as { searchable: boolean; message?: string };
    assertEqual(body.searchable, false);
    assert(Boolean(body.message), "应给可行动文案");
  });

  it("不覆盖已有的 indexed_at（同一字段两个语义，见 CONTEXT §12.2）", async () => {
    const { bag, docId } = await seedReady();
    const before = (await bag.repo.getDocument(docId))?.indexedAt;
    assert(before != null, "导入时应已记录「写入被接受」的时刻");
    await (probePOST as Handler)(makeCtx({ body: { id: docId }, bag }));
    const after = (await bag.repo.getDocument(docId))?.indexedAt;
    assertEqual(after, before, "探针不得改写 indexed_at（否则会污染 /api/ask 的「刚导入」提示窗口）");
  });

  it("缺 id → 400；文档不存在 → 404；缺令牌 → 401", async () => {
    const { bag } = await seedReady();
    assertEqual((await (probePOST as Handler)(makeCtx({ body: {}, bag }))).status, 400);
    assertEqual((await (probePOST as Handler)(makeCtx({ body: { id: "doc_nope" }, bag }))).status, 404);
    const env = { MAGPIE_BASE_URL: "https://m", MAGPIE_API_KEY: "k", ACCESS_TOKEN: "s3cret" };
    assertEqual((await (probePOST as Handler)(makeCtx({ env, body: { id: "x" }, bag: newBag() }))).status, 401);
  });
});

// ── 二期：扫描件 OCR（A4）───────────────────────────────────────────
describe("ocr — 单页识别接口", () => {
  const IMG = "data:image/jpeg;base64," + Buffer.from("p1").toString("base64");

  it("正常识别 → 200 + 文本 + 回显页号", async () => {
    const bag = newBag();
    const resp = await (ocrPOST as Handler)(makeCtx({ body: { image: IMG, page: 2 }, bag }));
    assertEqual(resp.status, 200);
    const body = (await resp.json()) as { ok: boolean; text: string; page: number; chars: number };
    assertEqual(body.ok, true);
    assertEqual(body.page, 2);
    assert(body.chars > 0 && body.text.length > 0);
  });

  it("远程 URL 图片 → 400（只收 data URL）", async () => {
    const resp = await (ocrPOST as Handler)(
      makeCtx({ body: { image: "https://example.com/a.jpg", page: 1 }, bag: newBag() }),
    );
    assertEqual(resp.status, 400);
  });

  it("页号超上限 / 缺 image → 400", async () => {
    const bag = newBag();
    assertEqual((await (ocrPOST as Handler)(makeCtx({ body: { image: IMG, page: 6 }, bag }))).status, 400);
    assertEqual((await (ocrPOST as Handler)(makeCtx({ body: { page: 1 }, bag }))).status, 400);
  });

  it("配额耗尽 → 429，且文案指向额度而不是「服务坏了」", async () => {
    const ai = createFakeAI({ ocr: { error: () => new Error("429 neuron quota exceeded") } });
    const bag = { repo: createMemoryRepo(), index: createMemoryVectorIndex(), ai };
    const resp = await (ocrPOST as Handler)(makeCtx({ body: { image: IMG, page: 1 }, bag }));
    assertEqual(resp.status, 429);
    const body = (await resp.json()) as { error: string };
    assert(/额度/.test(body.error), `文案应说明额度: ${body.error}`);
  });

  it("上游异常 → 502；缺令牌 → 401", async () => {
    const ai = createFakeAI({ ocr: { error: () => new Error("500 upstream") } });
    const bag = { repo: createMemoryRepo(), index: createMemoryVectorIndex(), ai };
    assertEqual((await (ocrPOST as Handler)(makeCtx({ body: { image: IMG }, bag }))).status, 502);

    const env = { MAGPIE_BASE_URL: "https://m", MAGPIE_API_KEY: "k", ACCESS_TOKEN: "s3cret" };
    assertEqual((await (ocrPOST as Handler)(makeCtx({ env, body: { image: IMG }, bag: newBag() }))).status, 401);
  });

  it("AI 绑定缺失 → 503（部署配置问题给明确文案）", async () => {
    const resp = await (ocrPOST as Handler)(makeCtx({ body: { image: IMG }, env: {}, bag: undefined }));
    assertEqual(resp.status, 503);
  });
});
