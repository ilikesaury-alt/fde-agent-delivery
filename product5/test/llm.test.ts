/** LLM 适配层契约测试（全用注入 fetch，不触网） */
import { assert, assertEqual, describe, it } from "./harness.ts";
import { LLM_MESSAGES, scoreMany, scoreOne } from "../lib/llm.ts";

const ENV = { MAGPIE_BASE_URL: "https://mock/v1", MAGPIE_API_KEY: "k", MAGPIE_MODEL: "m" };
const GOOD = '{"relevance":8,"novelty":7,"usefulness":6,"authority":9,"reason":"官方发布"}';

const input = (title = "OpenAI 发布新模型，支持更长上下文") => ({
  title,
  summary: "官方博客介绍新模型的推理能力与基准表现。",
  sourceId: "hn",
  lang: "en",
});

function mockLLM(content: string, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("scoreOne · 成功路径", () => {
  it("解析出四维分与总分", async () => {
    const r = await scoreOne(ENV, input(), { fetchImpl: mockLLM(GOOD) });
    assert(r.ok);
    assertEqual(r.score.relevance, 8);
    assertEqual(r.score.total, 76, "8*0.4+7*0.2+6*0.2+9*0.2 = 7.6 → 76");
  });

  it("请求体带上模型名与 system prompt（换模型时必须传对）", async () => {
    const captured: { body?: Record<string, unknown> } = {};
    const spy = (async (_url: string, init?: RequestInit) => {
      captured.body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: GOOD } }] }), { status: 200 });
    }) as unknown as typeof fetch;

    await scoreOne(ENV, input(), { fetchImpl: spy });
    const body = captured.body;
    assert(body !== undefined);
    assertEqual(body.model, "m");
    const messages = body.messages as Array<{ role: string; content: string }>;
    assertEqual(messages[0]?.role, "system");
    assert(messages[0]!.content.includes("relevance"), "system prompt 应包含评分维度");
    assertEqual(messages[1]?.role, "user");
    assert(messages[1]!.content.includes("OpenAI 发布新模型"));
  });
});

describe("scoreOne · 失败分类（面向用户文案，不泄露上游）", () => {
  it("未配置 → not_configured", async () => {
    const r = await scoreOne({}, input(), { fetchImpl: mockLLM(GOOD) });
    assert(!r.ok);
    assertEqual(r.error, "not_configured");
    assertEqual(r.message, LLM_MESSAGES.not_configured);
  });

  it("上游 500 → upstream，且不含上游响应体", async () => {
    const r = await scoreOne(ENV, input(), { fetchImpl: mockLLM("internal stack trace", 500) });
    assert(!r.ok);
    assertEqual(r.error, "upstream");
    assert(!r.message.includes("stack"), "不应回显上游内容");
  });

  it("网络异常 → upstream", async () => {
    const boom = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const r = await scoreOne(ENV, input(), { fetchImpl: boom });
    assert(!r.ok);
    assertEqual(r.error, "upstream");
  });

  it("超时 → timeout", async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          rej(e);
        });
      })) as unknown as typeof fetch;
    const r = await scoreOne(ENV, input(), { fetchImpl: hang, timeoutMs: 20 });
    assert(!r.ok);
    assertEqual(r.error, "timeout");
  });

  it("模型返回不符合 schema → bad_response（带原因，便于复核）", async () => {
    const r = await scoreOne(ENV, input(), { fetchImpl: mockLLM('{"relevance":9}') });
    assert(!r.ok);
    assertEqual(r.error, "bad_response");
    assert(r.message.includes("维度"));
  });
});

describe("scoreMany · 批量隔离", () => {
  it("单条失败不影响其它条；返回顺序与输入一致", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      // 第 2 次调用返回坏 JSON，其余正常
      const content = n === 2 ? "不是 JSON" : GOOD;
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const inputs = [input("条目 A"), input("条目 B"), input("条目 C")];
    const out = await scoreMany(ENV, inputs, { fetchImpl, concurrency: 1 });

    assertEqual(out.length, 3);
    assertEqual(out[0]!.input.title, "条目 A");
    assertEqual(out[1]!.input.title, "条目 B");
    assertEqual(out[2]!.input.title, "条目 C");
    assertEqual(out[0]!.result.ok, true);
    assertEqual(out[1]!.result.ok, false, "坏返回应只影响自己");
    assertEqual(out[2]!.result.ok, true);
  });
});