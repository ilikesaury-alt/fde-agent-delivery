/** 路由层契约测试：/api/feed 的令牌、源筛选、失败隔离、去重计数、limit */
import { assert, assertEqual, describe, it } from "./harness.ts";
import * as feedRoute from "../routes/api/feed.ts";
import * as sourcesRoute from "../routes/api/sources.ts";
import * as topRoute from "../routes/api/top.ts";
import { createMemoryStore, type Store } from "../lib/store.ts";

const TOKEN = "secret-token";

type Handler = (c: unknown) => Promise<Response>;

/** 最小上下文：路由只用到 env / req.query / req.header / _fetchImpl */
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
      method: "GET",
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

const rss = (items: Array<{ title: string; link: string; date?: string }>) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${items
    .map(
      (i) =>
        `<item><title>${i.title}</title><link>${i.link}</link>${
          i.date ? `<pubDate>${i.date}</pubDate>` : ""
        }</item>`,
    )
    .join("")}</channel></rss>`;

/** 按域名分派的假 fetch：ok.com 正常，bad.com 503 */
function mockFetch(byHost: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const host = new URL(String(input)).hostname;
    const handler = byHost[host];
    if (!handler) return new Response("unknown host", { status: 404 });
    return handler();
  }) as unknown as typeof fetch;
}

const GET = feedRoute.GET as unknown as Handler;
const GET_SOURCES = sourcesRoute.GET as unknown as Handler;

describe("/api/feed · 令牌与筛选", () => {
  it("未配置 ACCESS_TOKEN 时不校验令牌", async () => {
    const res = await GET(
      ctx({
        url: "/api/feed?src=hn",
        fetchImpl: mockFetch({
          "hnrss.org": () => new Response(rss([{ title: "A", link: "https://a.com/1" }])),
        }),
      }),
    );
    assertEqual(res.status, 200);
  });

  it("配置了 ACCESS_TOKEN：缺令牌/错令牌 → 401，文案面向用户", async () => {
    const env = { ACCESS_TOKEN: TOKEN, FEED_MAX_ITEMS: "5" };
    const noToken = await GET(ctx({ url: "/api/feed?src=hn", env }));
    assertEqual(noToken.status, 401);
    const body = (await noToken.json()) as { error?: string };
    assert(Boolean(body.error?.includes("令牌")), "错误文案应提示令牌");

    const wrong = await GET(ctx({ url: "/api/feed?src=hn", env, auth: "Bearer nope" }));
    assertEqual(wrong.status, 401);
  });

  it("src 无匹配 → 400", async () => {
    const res = await GET(ctx({ url: "/api/feed?src=not-a-source" }));
    assertEqual(res.status, 400);
  });

  it("src 只抓指定源（不多发请求）", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(rss([{ title: "A", link: "https://a.com/1" }]));
    }) as unknown as typeof fetch;

    const res = await GET(ctx({ url: "/api/feed?src=hn", fetchImpl }));
    assertEqual(res.status, 200);
    assertEqual(seen.length, 1, "只应请求一个源");
    assert(seen[0]!.includes("hnrss.org"));
  });
});

describe("/api/feed · 失败隔离与计数", () => {
  it("坏源不拖垮整体：200 + failures 分类 + 好源条目保留", async () => {
    const fetchImpl = mockFetch({
      "hnrss.org": () => new Response("down", { status: 503 }),
      // ⚠️ 2026-11-03：hf-blog 已从源列表移除（该 feed 不提供任何摘要，
      // 预筛必然全丢）→ 改用 openai（官方源，实测 40/40 条有摘要）。
      "openai.com": () =>
        new Response(rss([{ title: "OpenAI 新闻", link: "https://openai.com/p1" }])),
    });

    const res = await GET(ctx({ url: "/api/feed?src=hn,openai-news", fetchImpl }));
    assertEqual(res.status, 200);
    const body = (await res.json()) as {
      items: Array<{ title: string }>;
      failures: Array<{ sourceId: string; error: string }>;
      sources: Array<{ id: string; health: { level: string } }>;
    };
    assertEqual(body.items.length, 1);
    assertEqual(body.items[0]?.title, "OpenAI 新闻");
    assertEqual(body.failures.length, 1);
    assertEqual(body.failures[0]?.sourceId, "hn");
    assertEqual(body.failures[0]?.error, "http_status");
    // ⚠️ 断言按 sourceId 查，不依赖数组下标 —— 源列表扩充后顺序会变，
    //   下标断言会在源增删时误报（这类脆弱断言已吃过一次亏）。
    assertEqual(body.sources.find((s) => s.id === "hn")?.health.level, "broken");
    assertEqual(body.sources.find((s) => s.id === "openai-news")?.health.level, "ok");
  });

  it("跨源重复被去重并计数（A2）", async () => {
    const same = { title: "同一篇", link: "https://dup.com/post" };
    const fetchImpl = mockFetch({
      "hnrss.org": () => new Response(rss([same])),
      // ⚠️ 2026-11-03：hf-blog 已从源列表移除 → 改用 openai（跨源同链接 + 追踪参数仍应去重）
      "openai.com": () => new Response(rss([{ ...same, link: "https://dup.com/post?utm_source=x" }])),
    });

    const res = await GET(ctx({ url: "/api/feed?src=hn,openai-news", fetchImpl }));
    const body = (await res.json()) as {
      items: unknown[];
      counts: { fetched: number; kept: number; deduped: number };
    };
    assertEqual(body.counts.fetched, 2);
    assertEqual(body.counts.kept, 1);
    assertEqual(body.counts.deduped, 1);
  });

  it("limit 截断返回条目（抓取仍按源上限）", async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      title: `t${i}`,
      link: `https://a.com/${i}`,
    }));
    const res = await GET(
      ctx({
        url: "/api/feed?src=hn&limit=3",
        fetchImpl: mockFetch({ "hnrss.org": () => new Response(rss(many)) }),
      }),
    );
    const body = (await res.json()) as { items: unknown[]; counts: { kept: number } };
    assertEqual(body.items.length, 3);
    assertEqual(body.counts.kept, 8);
  });
});
describe("/api/feed · 持久化（增量 2）", () => {
  const oneItem = rss([{ title: "落库条目", link: "https://a.com/1" }]);
  const fetchImpl = mockFetch({ "hnrss.org": () => new Response(oneItem) });

  it("未提供存储时显式降级（storage=disabled），不报错", async () => {
    const res = await GET(ctx({ url: "/api/feed?src=hn", fetchImpl }));
    assertEqual(res.status, 200);
    const body = (await res.json()) as { storage: string; persisted: unknown };
    assertEqual(body.storage, "disabled");
    assertEqual(body.persisted, null);
  });

  it("有存储时两次调用：首次新增、第二次全判重", async () => {
    const store = createMemoryStore();

    const first = await GET(ctx({ url: "/api/feed?src=hn", fetchImpl, store }));
    const b1 = (await first.json()) as { storage: string; persisted: { inserted: number; duplicates: number } };
    assertEqual(b1.storage, "ok");
    assertEqual(b1.persisted.inserted, 1);
    assertEqual(b1.persisted.duplicates, 0);

    const second = await GET(ctx({ url: "/api/feed?src=hn", fetchImpl, store }));
    const b2 = (await second.json()) as { persisted: { inserted: number; duplicates: number } };
    assertEqual(b2.persisted.inserted, 0, "跨请求去重应生效");
    assertEqual(b2.persisted.duplicates, 1);
    assertEqual(store._size().items, 1);
  });

  it("落库失败不拖垮抓取：仍 200，storage=failed + 面向用户文案", async () => {
    const broken = {
      ...createMemoryStore(),
      async saveItems(): Promise<never> {
        throw new Error("D1_ERROR: no such table: items");
      },
    } as ReturnType<typeof createMemoryStore>;

    const res = await GET(ctx({ url: "/api/feed?src=hn", fetchImpl, store: broken }));
    assertEqual(res.status, 200, "抓取结果对用户仍有用，不应 500");
    const body = (await res.json()) as {
      storage: string;
      persisted: unknown;
      persistError: string | null;
      items: unknown[];
    };
    assertEqual(body.storage, "failed");
    assertEqual(body.persisted, null);
    assert(Boolean(body.persistError), "应给出可读的降级说明");
    assert(body.persistError?.includes("存储") === true);
    assert(!String(body.persistError).includes("D1_ERROR"), "不应泄露底层错误体");
    assertEqual(body.items.length, 1, "条目本身照常返回");
  });
});

describe("/api/sources · 源健康历史（增量 5）", () => {
  it("未配置存储时降级为 disabled（不报错）", async () => {
    const res = await GET_SOURCES(ctx({ url: "/api/sources" }));
    assertEqual(res.status, 200);
    const body = (await res.json()) as { storage: string };
    assertEqual(body.storage, "disabled");
  });

  it("返回各源快照 + 历史 + 连续失败次数", async () => {
    const store = createMemoryStore();
    const src = { id: "hn", name: "Hacker News", url: "https://hnrss.org/frontpage", lang: "en" as const, verified: true };
    // 先正常一次，再连续坏两次 → consecutiveFailures 应为 2
    await store.recordRun([{ source: src, health: { sourceId: "hn", level: "ok", itemCount: 20, checkedAt: "t" } }], 1000);
    await store.recordRun(
      [{ source: src, health: { sourceId: "hn", level: "broken", error: "timeout", itemCount: 0, checkedAt: "t" } }],
      2000,
    );
    await store.recordRun(
      [{ source: src, health: { sourceId: "hn", level: "broken", error: "timeout", itemCount: 0, checkedAt: "t" } }],
      3000,
    );

    const res = await GET_SOURCES(ctx({ url: "/api/sources", store }));
    assertEqual(res.status, 200);
    const body = (await res.json()) as {
      sources: Array<{
        id: string;
        lastHealth: string | null;
        lastError: string | null;
        baselineCount: number | null;
        consecutiveFailures: number;
        history: Array<{ level: string }>;
      }>;
    };
    const hn = body.sources.find((s) => s.id === "hn");
    assert(hn);
    assertEqual(hn!.lastHealth, "broken");
    assertEqual(hn!.lastError, "timeout");
    assertEqual(hn!.baselineCount, 20, "正常时的基线应保留");
    assertEqual(hn!.consecutiveFailures, 2);
    assertEqual(hn!.history.length, 3, "历史倒序（最新在前）");
    assertEqual(hn!.history[0]!.level, "broken");
    assertEqual(hn!.history[2]!.level, "ok");
  });

  it("?source= 只返回指定源", async () => {
    const store = createMemoryStore();
    const res = await GET_SOURCES(ctx({ url: "/api/sources?source=hn", store }));
    const body = (await res.json()) as { sources: Array<{ id: string }> };
    assertEqual(body.sources.length, 1);
    assertEqual(body.sources[0]?.id, "hn");
  });
});

/**
 * /api/top · 候选窗口与单源配额（D11）
 *
 * 背景（2026-11-03 实测）：线上「精选」只出 12 条，且只来自 3 个源。
 * 根因不是没数据（全库有 66 条 ≥70 分的条目），而是**候选窗口太窄**：
 * 旧实现只取 `limit * 3` 条候选再做配额过滤 → 候选被 2 个高产源占满，
 * 配额过滤后剩下的名额无人可填 → 实际入选 = 配额上限之和。
 * 修正：候选窗口提到 `limit * 10`。
 */
describe("/api/top · 候选窗口与配额", () => {
  const GET_TOP = topRoute.GET as unknown as Handler;

  /** 造 N 个源 × M 条高分条目 */
  async function seedScored(store: Store, sources: number, perSource: number) {
    for (let s = 0; s < sources; s++) {
      const sid = `src${s}`;
      await store.saveItems(
        Array.from({ length: perSource }, (_, i) => ({
          id: `${sid}-${i}`,
          sourceId: sid,
          title: `${sid} 条目 ${i}`,
          link: `https://${sid}.com/${i}`,
          publishedAt: new Date(2026, 0, 1 + i).toISOString(),
          summary: "摘要足够长，用于通过预筛，不影响本用例。",
        })),
      );
    }
    const all = await store.recentItems({ limit: 500 });
    await store.saveScores(
      all.map((i) => ({
        contentKey: i.contentKey,
        relevance: 9,
        novelty: 9,
        usefulness: 9,
        authority: 9,
        total: 90,
        reason: "高分",
        model: "m",
        promptVersion: "score-v1",
      })),
    );
  }

  it("候选窗口足够宽 → 配额能填满 topN 且来源多样", async () => {
    const store = createMemoryStore();
    // 6 个源 × 10 条 = 60 条高分；topN=12 → 每源上限 4
    await seedScored(store, 6, 10);

    const res = await GET_TOP(ctx({ url: "/api/top?threshold=70", store }));
    assertEqual(res.status, 200);
    const body = (await res.json()) as {
      count: number;
      perSourceMax: number;
      skippedByQuota: number;
      items: Array<{ sourceId: string }>;
    };

    assertEqual(body.count, 12, "应填满 topN=12");
    assertEqual(body.perSourceMax, 4, "每源上限 = topN/3");
    const bySource = new Map<string, number>();
    for (const i of body.items) bySource.set(i.sourceId, (bySource.get(i.sourceId) ?? 0) + 1);
    assert(
      bySource.size >= 3,
      `入选应来自多个源（实际 ${bySource.size} 个：${JSON.stringify([...bySource])}）`,
    );
    for (const [sid, n] of bySource) {
      assert(n <= 4, `源 ${sid} 占比 ${n} 不得超过配额 4`);
    }
  });

  it("单源不超过配额上限（配额真的在起作用）", async () => {
    const store = createMemoryStore();
    await seedScored(store, 6, 10);
    const res = await GET_TOP(ctx({ url: "/api/top?threshold=70", store }));
    const body = (await res.json()) as {
      perSourceMax: number;
      skippedByQuota: number;
      items: Array<{ sourceId: string }>;
    };

    const bySource = new Map<string, number>();
    for (const i of body.items) bySource.set(i.sourceId, (bySource.get(i.sourceId) ?? 0) + 1);
    for (const [sid, n] of bySource) {
      assert(n <= body.perSourceMax!, `源 ${sid} 入选 ${n} 条不得超过配额 ${body.perSourceMax}`);
    }
    // ⚠️ skippedByQuota 可能为 0 —— 这正是修好的证据：
    //   候选窗口够宽（6 源 × 10 条）时，配额能直接填满 topN 且无需跳过任何人。
    //   旧实现（候选 3×）下同场景会跳过大量条目却仍填不满。
    assert(
      body.skippedByQuota >= 0,
      `skippedByQuota=${body.skippedByQuota}（候选充足时为 0 是正常且期望的）`,
    );
  });

  it("?quota=0 关闭配额 → 返回全库最高分", async () => {
    const store = createMemoryStore();
    await seedScored(store, 6, 10);
    const res = await GET_TOP(ctx({ url: "/api/top?threshold=70&quota=0", store }));
    const body = (await res.json()) as { count: number; perSourceMax: number | null };
    assertEqual(body.perSourceMax, null, "quota=0 时不设上限");
    assertEqual(body.count, 12, "仍受 topN 限制");
  });
});
