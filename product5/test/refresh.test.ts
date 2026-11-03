/**
 * /api/refresh 契约测试：手动完整流程（抓取 → 去重 → 评分 → 日报）
 *
 * 2026-11-03 起产品⑤ 取消了全部定时任务，这个接口成了唯一的生产入口，
 * 所以它的鉴权与**降级路径**（LLM 挂 / 日报挂）必须有测试钉住 ——
 * 「点一下没反应」比「报错」更难排查。
 */
import { assert, assertEqual, describe, it } from "./harness.ts";
import * as refreshRoute from "../routes/api/refresh.ts";
import { createMemoryStore, type Store } from "../lib/store.ts";

const TOKEN = "secret-token";

type Handler = (c: unknown) => Promise<Response>;

function ctx(opts: {
  url: string;
  auth?: string | null;
  fetchImpl?: typeof fetch;
  env?: Record<string, unknown>;
  store?: Store;
}): unknown {
  const url = new URL(opts.url, "https://example.com");
  return {
    env: { ...(opts.env ?? {}) },
    _fetchImpl: opts.fetchImpl,
    _store: opts.store,
    req: {
      url,
      method: "POST",
      header(name: string) {
        if (name.toLowerCase() === "authorization") {
          return opts.auth === null ? undefined : (opts.auth ?? undefined);
        }
        return undefined;
      },
      query(name: string) {
        return url.searchParams.get(name) ?? undefined;
      },
    },
  };
}

/** 一个最小 RSS 源 */
const rss = (title: string, link: string, summary: string) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>` +
  `<item><title>${title}</title><link>${link}</link><description>${summary}</description>` +
  `<pubDate>Mon, 03 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>`;

/** 假 fetch：RSS 源正常，LLM 网关可控 */
function mockFetch(opts: {
  rss: (url: string) => Response;
  llm?: (url: string) => Response;
}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const u = String(input);
    if (u.includes("magpie") || u.includes("/chat/completions")) {
      return opts.llm ? opts.llm(u) : new Response("no llm mock", { status: 500 });
    }
    return opts.rss(u);
  }) as unknown as typeof fetch;
}

const POST = refreshRoute.POST as unknown as Handler;

const okRss = (url: string) =>
  new Response(
    rss(
      "OpenAI 发布新模型 " + url.slice(-6),
      `https://example.com/${url.slice(-6)}`,
      "官方博客介绍了新模型的推理能力与基准表现，附有对比数据与评测结果。",
    ),
    { headers: { "content-type": "application/xml" } },
  );

describe("/api/refresh · 鉴权", () => {
  it("未配置 ACCESS_TOKEN → 503（不匿名消耗额度）", async () => {
    const res = await POST(ctx({ url: "/api/refresh", env: {} }));
    assertEqual(res.status, 503);
  });

  it("缺令牌 → 401", async () => {
    const res = await POST(
      ctx({ url: "/api/refresh", env: { ACCESS_TOKEN: TOKEN }, auth: null }),
    );
    assertEqual(res.status, 401);
  });

  it("错令牌 → 401", async () => {
    const res = await POST(
      ctx({ url: "/api/refresh", env: { ACCESS_TOKEN: TOKEN }, auth: "Bearer nope" }),
    );
    assertEqual(res.status, 401);
  });

  it("无 D1 → 503", async () => {
    const res = await POST(
      ctx({ url: "/api/refresh", env: { ACCESS_TOKEN: TOKEN }, auth: `Bearer ${TOKEN}` }),
    );
    assertEqual(res.status, 503);
  });
});

describe("/api/refresh · 完整流程", () => {
  it("抓取 + 评分 + 日报一次跑完，返回汇总", async () => {
    const store = createMemoryStore();
    const res = await POST(
      ctx({
        url: "/api/refresh",
        auth: `Bearer ${TOKEN}`,
        env: {
          ACCESS_TOKEN: TOKEN,
          MAGPIE_BASE_URL: "https://magpie.example/v1",
          MAGPIE_API_KEY: "k",
          MAGPIE_MODEL: "test-model",
        },
        store,
        fetchImpl: mockFetch({
          rss: okRss,
          llm: () =>
            new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        relevance: 8,
                        novelty: 7,
                        usefulness: 8,
                        authority: 9,
                        reason: "重要发布",
                      }),
                    },
                  },
                ],
              }),
              { headers: { "content-type": "application/json" } },
            ),
        }),
      }),
    );
    assertEqual(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      feed: { fetched: number; inserted: number };
      score: { scored: number } | null;
      digest: { date: string; counts: { selected: number } } | null;
      warnings: string[];
    };
    assert(body.ok === true);
    assert(body.feed.fetched > 0, "应抓到条目");
    assert(body.score !== null, "应执行评分");
    assert((body.score?.scored ?? 0) > 0, "应有条目评分成功");
    assert(body.digest !== null, "应生成日报");
    assertEqual(body.warnings.length, 0);
  });

  it("LLM 网关挂 → 抓取仍成功，日报用已有评分生成，带 warning", async () => {
    const store = createMemoryStore();
    const res = await POST(
      ctx({
        url: "/api/refresh",
        auth: `Bearer ${TOKEN}`,
        env: {
          ACCESS_TOKEN: TOKEN,
          MAGPIE_BASE_URL: "https://magpie.example/v1",
          MAGPIE_API_KEY: "k",
        },
        store,
        fetchImpl: mockFetch({
          rss: okRss,
          llm: () => new Response("upstream down", { status: 502 }),
        }),
      }),
    );
    assertEqual(res.status, 200);
    const body = (await res.json()) as {
      feed: { inserted: number };
      score: { failed: number } | null;
      warnings: string[];
    };
    // 抓取结果必须入库（不能因为评分失败就丢掉）
    assert(body.feed.inserted > 0, "抓取结果应已入库");
    assert(body.warnings.length > 0, "应带 warning 说明评分失败");
  });

  it("未配置 magpie → 跳过评分但仍返回抓取结果与提示", async () => {
    const store = createMemoryStore();
    const res = await POST(
      ctx({
        url: "/api/refresh",
        auth: `Bearer ${TOKEN}`,
        env: { ACCESS_TOKEN: TOKEN },
        store,
        fetchImpl: mockFetch({ rss: okRss }),
      }),
    );
    assertEqual(res.status, 200);
    const body = (await res.json()) as {
      feed: { inserted: number };
      score: unknown;
      warnings: string[];
    };
    assert(body.feed.inserted > 0);
    assertEqual(body.score, null);
    assert(body.warnings.length > 0);
  });
});

describe("/api/refresh · 去重集成", () => {
  it("同批次跨源重复的条目只评一次（省下 LLM 调用）", async () => {
    const store = createMemoryStore();
    let llmCalls = 0;
    const res = await POST(
      ctx({
        url: "/api/refresh",
        auth: `Bearer ${TOKEN}`,
        env: {
          ACCESS_TOKEN: TOKEN,
          MAGPIE_BASE_URL: "https://magpie.example/v1",
          MAGPIE_API_KEY: "k",
        },
        store,
        fetchImpl: mockFetch({
          // 所有源都返回**同一篇**文章（不同链接 → 不会被 URL 去重挡掉）
          rss: (url) =>
            new Response(
              rss(
                "OpenAI releases a brand new frontier model",
                `https://example.com/${url.length}-${url.charCodeAt(5)}`,
                "官方博客介绍了新模型的推理能力与基准表现，附有对比数据与评测结果。",
              ),
              { headers: { "content-type": "application/xml" } },
            ),
          llm: () => {
            llmCalls++;
            return new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        relevance: 8,
                        novelty: 7,
                        usefulness: 8,
                        authority: 9,
                        reason: "重要发布",
                      }),
                    },
                  },
                ],
              }),
              { headers: { "content-type": "application/json" } },
            );
          },
        }),
      }),
    );
    assertEqual(res.status, 200);
    const body = (await res.json()) as {
      feed: { fetched: number };
      score: { scored: number; duplicated: number } | null;
    };
    assert(body.feed.fetched > 1, "应抓到多条");
    assert((body.score?.duplicated ?? 0) > 0, "应识别出重复条目");
    // 关键断言：评分条数 << 抓取条数（重复的被跳过，一次 LLM 调用没花）
    assert(
      (body.score?.scored ?? 0) < body.feed.fetched,
      `评分条数 ${body.score?.scored} 应少于抓取条数 ${body.feed.fetched}`,
    );
  });
});
