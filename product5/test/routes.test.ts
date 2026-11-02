/** 路由层契约测试：/api/feed 的令牌、源筛选、失败隔离、去重计数、limit */
import { assert, assertEqual, describe, it } from "./harness.ts";
import * as feedRoute from "../routes/api/feed.ts";

const TOKEN = "secret-token";

type Handler = (c: unknown) => Promise<Response>;

/** 最小上下文：路由只用到 env / req.query / req.header / _fetchImpl */
function ctx(opts: {
  url: string;
  auth?: string | null;
  fetchImpl?: typeof fetch;
  env?: Record<string, unknown>;
}): unknown {
  const url = new URL(opts.url, "https://example.com");
  return {
    env: { ...(opts.env ?? {}) },
    _fetchImpl: opts.fetchImpl,
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
      "huggingface.co": () =>
        new Response(rss([{ title: "HF 文章", link: "https://hf.co/p1" }])),
    });

    const res = await GET(ctx({ url: "/api/feed?src=hn,hf-blog", fetchImpl }));
    assertEqual(res.status, 200);
    const body = (await res.json()) as {
      items: Array<{ title: string }>;
      failures: Array<{ sourceId: string; error: string }>;
      sources: Array<{ id: string; health: { level: string } }>;
    };
    assertEqual(body.items.length, 1);
    assertEqual(body.items[0]?.title, "HF 文章");
    assertEqual(body.failures.length, 1);
    assertEqual(body.failures[0]?.sourceId, "hn");
    assertEqual(body.failures[0]?.error, "http_status");
    assertEqual(body.sources[0]?.health.level, "broken");
    assertEqual(body.sources[1]?.health.level, "ok");
  });

  it("跨源重复被去重并计数（A2）", async () => {
    const same = { title: "同一篇", link: "https://dup.com/post" };
    const fetchImpl = mockFetch({
      "hnrss.org": () => new Response(rss([same])),
      "huggingface.co": () => new Response(rss([{ ...same, link: "https://dup.com/post?utm_source=x" }])),
    });

    const res = await GET(ctx({ url: "/api/feed?src=hn,hf-blog", fetchImpl }));
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