import { assert, assertEqual, describe, it } from "./harness.ts";
import { streamLLM, callLLM, MissingConfigError, LLMError } from "../lib/llm.ts";

const ENV = { MAGPIE_BASE_URL: "https://mock.test/v1", MAGPIE_API_KEY: "k", MAGPIE_MODEL: "m" };

/** 用可切碎的分片构造 SSE 响应体，模拟真实网络乱切 */
function sseResponse(chunks: string[], contentType = "text/event-stream"): Response {
  const encoder = new TextEncoder();
  let i = 0;
  return new Response(
    new ReadableStream({
      async pull(controller) {
        if (i >= chunks.length) {
          controller.close();
          return;
        }
        await new Promise((r) => setTimeout(r, 1));
        controller.enqueue(encoder.encode(chunks[i++]));
      },
    }),
    { headers: { "content-type": contentType } },
  );
}

async function collect(gen: AsyncGenerator<string>): Promise<string> {
  let out = "";
  for await (const d of gen) out += d;
  return out;
}

describe("streamLLM — SSE 增量解析", () => {
  it("跨 chunk 切断的帧能正确拼接", async () => {
    const resp = sseResponse([
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: {"choices":[{"del',
      'ta":{"content":"世界"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const fetchImpl = (async () => resp) as unknown as typeof fetch;
    const out = await collect(streamLLM(ENV, [{ role: "user", content: "hi" }], { fetchImpl }));
    assertEqual(out, "你好世界");
  });

  it("忽略 keep-alive 注释与 event: 行", async () => {
    const resp = sseResponse([
      ": ping\n\n",
      'event: message\ndata: {"choices":[{"delta":{"content":"A"}}]}\n\n',
      ": ping\n\n",
      'data: {"choices":[{"delta":{"content":"B"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const fetchImpl = (async () => resp) as unknown as typeof fetch;
    const out = await collect(streamLLM(ENV, [{ role: "user", content: "hi" }], { fetchImpl }));
    assertEqual(out, "AB");
  });

  it("末行无换行符也能产出", async () => {
    const resp = sseResponse(['data: {"choices":[{"delta":{"content":"尾巴"}}]}']);
    const fetchImpl = (async () => resp) as unknown as typeof fetch;
    const out = await collect(streamLLM(ENV, [{ role: "user", content: "hi" }], { fetchImpl }));
    assertEqual(out, "尾巴");
  });

  it("上游不认流式、直接回整段 JSON 时降级为一次性产出", async () => {
    const resp = new Response(
      JSON.stringify({ choices: [{ message: { content: "整段内容" } }] }),
      { headers: { "content-type": "application/json" } },
    );
    const fetchImpl = (async () => resp) as unknown as typeof fetch;
    const out = await collect(streamLLM(ENV, [{ role: "user", content: "hi" }], { fetchImpl }));
    assertEqual(out, "整段内容");
  });

  it("真 SSE 但全是空 delta（模型不吐 content）时报错而不是静默成功", async () => {
    const resp = sseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const fetchImpl = (async () => resp) as unknown as typeof fetch;
    let message = "";
    try {
      await collect(streamLLM(ENV, [{ role: "user", content: "hi" }], { fetchImpl }));
    } catch (e) {
      message = (e as Error).message;
    }
    assert(message.includes("为空"), `应报空结果错误，实际：${message}`);
  });

  it("401 → 凭据无效文案", async () => {
    const fetchImpl = (async () => new Response("denied", { status: 401 })) as unknown as typeof fetch;
    let err: unknown = null;
    try {
      await collect(streamLLM(ENV, [{ role: "user", content: "hi" }], { fetchImpl }));
    } catch (e) {
      err = e;
    }
    assert(err instanceof LLMError);
    assert((err as LLMError).message.includes("凭据"));
  });

  it("429 → 频率文案", async () => {
    const fetchImpl = (async () => new Response("slow down", { status: 429 })) as unknown as typeof fetch;
    let err: unknown = null;
    try {
      await collect(streamLLM(ENV, [{ role: "user", content: "hi" }], { fetchImpl }));
    } catch (e) {
      err = e;
    }
    assert(err instanceof LLMError);
    assert((err as LLMError).message.includes("频繁"));
  });

  it("未配置 base/key → MissingConfigError（不发起请求）", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("");
    }) as unknown as typeof fetch;
    let err: unknown = null;
    try {
      await collect(streamLLM({}, [{ role: "user", content: "hi" }], { fetchImpl }));
    } catch (e) {
      err = e;
    }
    assert(err instanceof MissingConfigError);
    assert(!called, "未配置时不应发起网络请求");
  });

  it("请求体带 stream:true（流式的前提）", async () => {
    let sentBody = "";
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sentBody = String(init.body);
      return sseResponse(['data: {"choices":[{"delta":{"content":"x"}}]}\n\n', "data: [DONE]\n\n"]);
    }) as unknown as typeof fetch;
    await collect(streamLLM(ENV, [{ role: "user", content: "hi" }], { fetchImpl }));
    assert(sentBody.includes('"stream":true'), `请求体应含 stream:true，实际：${sentBody.slice(0, 120)}`);
  });
});

describe("callLLM — 非流式（压缩用）", () => {
  it("正常返回内容", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "  要点一  " } }] }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const out = await callLLM(ENV, [{ role: "user", content: "x" }], { fetchImpl });
    assertEqual(out, "要点一");
  });

  it("空内容报错", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "   " } }] }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    let err: unknown = null;
    try {
      await callLLM(ENV, [{ role: "user", content: "x" }], { fetchImpl });
    } catch (e) {
      err = e;
    }
    assert(err instanceof LLMError);
  });

  it("请求体显式 stream:false（避免把 SSE 当 JSON 解析）", async () => {
    let sentBody = "";
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      sentBody = String(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await callLLM(ENV, [{ role: "user", content: "x" }], { fetchImpl });
    assert(sentBody.includes('"stream":false'), `应含 stream:false，实际：${sentBody.slice(0, 120)}`);
  });
});

describe("streamLLM — 上游错误帧不能静默（对抗审查反例）", () => {
  it("吃饱一半正文后来 error 帧 → 报错，而不是返回截断笔记", async () => {
    const resp = sseResponse([
      'data: {"choices":[{"delta":{"content":"正文开头"}}]}\n\n',
      'data: {"error":{"message":"content filter"}}\n\n',
      "data: [DONE]\n\n",
    ]);
    const fetchImpl = (async () => resp) as unknown as typeof fetch;
    let message = "";
    try {
      await collect(streamLLM(ENV, [{ role: "user", content: "hi" }], { fetchImpl }));
    } catch (e) {
      message = (e as Error).message;
    }
    assert(message.includes("中断"), `应报上游中断，实际：「${message}」`);
  });

  it("非 SSE、非 JSON、非纯文本（如 HTML 错误页）→ 报错，不当作正文", async () => {
    const resp = new Response("<html><body>502 Bad Gateway</body></html>", {
      headers: { "content-type": "text/html" },
    });
    const fetchImpl = (async () => resp) as unknown as typeof fetch;
    let message = "";
    try {
      await collect(streamLLM(ENV, [{ role: "user", content: "hi" }], { fetchImpl }));
    } catch (e) {
      message = (e as Error).message;
    }
    assert(message.length > 0, "应报错");
    assert(!message.includes("Bad Gateway"), "不应把错误页文本当结果传下去");
  });

  it("非 SSE 的纯文本降级仍保留（网关可能直接回 text/plain）", async () => {
    const resp = new Response("纯文本内容", { headers: { "content-type": "text/plain" } });
    const fetchImpl = (async () => resp) as unknown as typeof fetch;
    const out = await collect(streamLLM(ENV, [{ role: "user", content: "hi" }], { fetchImpl }));
    assertEqual(out, "纯文本内容");
  });
});
