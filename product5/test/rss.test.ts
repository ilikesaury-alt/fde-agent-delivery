/**
 * lib/rss.ts 的契约测试（先于路由实现）
 * 覆盖：RSS/Atom 解析、错误分类、去重、失败隔离、源健康分级。
 */
import { assert, assertEqual, describe, it } from "./harness.ts";
import {
  dedupeItems,
  fetchAllFeeds,
  fetchFeed,
  hashId,
  healthOf,
  normalizeUrl,
  parseDate,
  parseFeedXml,
  toPlainText,
} from "../lib/rss.ts";
import type { FeedSource, RawItem } from "../lib/types.ts";

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>示例源</title>
    <item>
      <title><![CDATA[OpenAI 发布 新模型]]></title>
      <link>https://example.com/a?utm_source=rss</link>
      <guid isPermaLink="false">guid-a</guid>
      <pubDate>Tue, 03 Nov 2026 08:00:00 GMT</pubDate>
      <description><![CDATA[<p>正文摘要 &amp; 更多</p>]]></description>
    </item>
    <item>
      <title>第二条 &amp; 带实体</title>
      <link>https://example.com/b</link>
      <pubDate>not-a-date</pubDate>
      <description>纯文本</description>
    </item>
    <item>
      <title>没有链接的条目</title>
    </item>
    <item>
      <link>https://example.com/no-title</link>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom 源</title>
  <entry>
    <title>Atom 条目一</title>
    <link rel="alternate" type="text/html" href="https://example.org/posts/1"/>
    <id>tag:example.org,2026:1</id>
    <updated>2026-11-02T10:00:00Z</updated>
    <summary type="html">&lt;p&gt;摘要&lt;/p&gt;</summary>
  </entry>
  <entry>
    <title>Atom 条目二（无 id）</title>
    <link href="https://example.org/posts/2"/>
    <published>2026-11-01T09:30:00Z</published>
  </entry>
</feed>`;

const src = (id: string, url = "https://example.com/feed"): FeedSource => ({
  id,
  name: id,
  url,
  lang: "en",
  verified: false,
});

describe("parseFeedXml · RSS 2.0", () => {
  it("解析条条目、CDATA、实体、guid、日期", () => {
    const out = parseFeedXml(RSS, "s1");
    assert(out.ok, "应解析成功");
    assertEqual(out.items.length, 2, "缺标题/缺链接的条目应被跳过");
    const [a, b] = out.items;
    assertEqual(a?.id, "guid-a", "guid 优先作为去重键");
    assertEqual(a?.title, "OpenAI 发布 新模型", "CDATA 应被解包");
    assertEqual(a?.link, "https://example.com/a?utm_source=rss", "链接保留原样（归一化在去重阶段）");
    assertEqual(a?.publishedAt, "2026-11-03T08:00:00.000Z", "pubDate 转 ISO");
    assertEqual(a?.summary, "正文摘要 & 更多", "摘要去标签并解码实体");
    assertEqual(b?.publishedAt, null, "非法日期应为 null（不猜）");
    assertEqual(b?.id, "https://example.com/b", "无 guid 时用链接作去重键");
  });

  it("非订阅源内容 → parse_error", () => {
    const out = parseFeedXml("<html><body>404</body></html>", "s1");
    assert(!out.ok, "应失败");
    assertEqual(out.error, "parse_error");
  });

  it("空内容 → parse_error；空 feed → empty", () => {
    const blank = parseFeedXml("   ", "s1");
    assert(!blank.ok);
    assertEqual(blank.error, "parse_error");

    const empty = parseFeedXml('<rss version="2.0"><channel><title>空</title></channel></rss>', "s1");
    assert(!empty.ok);
    assertEqual(empty.error, "empty");
  });

  it("maxItems 截断", () => {
    const out = parseFeedXml(RSS, "s1", { maxItems: 1 });
    assert(out.ok);
    assertEqual(out.items.length, 1);
  });
});

describe("parseFeedXml · Atom", () => {
  it("href 链接、id、updated/published", () => {
    const out = parseFeedXml(ATOM, "s2");
    assert(out.ok);
    assertEqual(out.items.length, 2);
    const [a, b] = out.items;
    assertEqual(a?.id, "tag:example.org,2026:1", "atom id 作去重键");
    assertEqual(a?.link, "https://example.org/posts/1", "取 rel=alternate 的 href");
    assertEqual(a?.publishedAt, "2026-11-02T10:00:00.000Z");
    assertEqual(a?.summary, "摘要", "HTML 实体应被解码后去标签");
    assertEqual(b?.id, "https://example.org/posts/2", "无 id 时回退链接");
    assertEqual(b?.publishedAt, "2026-11-01T09:30:00.000Z");
  });
});

describe("工具函数", () => {
  it("normalizeUrl 去追踪参数/锚点/尾斜杠", () => {
    assertEqual(
      normalizeUrl("https://Example.com/post/?utm_source=x&id=2#top"),
      "https://example.com/post?id=2",
    );
    assertEqual(normalizeUrl("not a url"), "not a url", "非法 URL 原样返回");
  });

  it("hashId 稳定且区分内容", () => {
    assertEqual(hashId("a"), hashId("a"));
    assert(hashId("a") !== hashId("b"));
  });

  it("parseDate 边界", () => {
    assertEqual(parseDate(null), null);
    assertEqual(parseDate("1800-01-01"), null, "早于 1990 视为坏日期");
    assertEqual(parseDate("Tue, 03 Nov 2026 08:00:00 GMT"), "2026-11-03T08:00:00.000Z");
  });

  it("toPlainText 截断", () => {
    const long = "x".repeat(500);
    const out = toPlainText(`<p>${long}</p>`, 100);
    assertEqual(out.length, 100);
    assert(out.endsWith("…"));
  });
});

describe("dedupeItems", () => {
  const item = (over: Partial<RawItem>): RawItem => ({
    id: "x",
    sourceId: "s",
    title: "标题",
    link: "https://example.com/p",
    publishedAt: null,
    summary: "",
    ...over,
  });

  it("同链接（含追踪参数差异）去重", () => {
    const { items, dropped } = dedupeItems([
      item({ title: "A", link: "https://example.com/p?utm_source=a" }),
      item({ title: "B", link: "https://example.com/p" }),
    ]);
    assertEqual(items.length, 1);
    assertEqual(dropped, 1);
    assertEqual(items[0]?.title, "A", "保留先出现者");
  });

  it("同标题不同链接去重（跨源转载）", () => {
    const { items } = dedupeItems([
      item({ title: "同一篇", link: "https://a.com/1" }),
      item({ title: "同一篇", link: "https://b.com/2" }),
    ]);
    assertEqual(items.length, 1);
  });

  it("不同内容都保留，顺序不变", () => {
    const { items, dropped } = dedupeItems([
      item({ title: "一", link: "https://a.com/1" }),
      item({ title: "二", link: "https://a.com/2" }),
    ]);
    assertEqual(items.length, 2);
    assertEqual(dropped, 0);
    assertEqual(items[0]?.title, "一");
  });
});

describe("fetchFeed · 失败分类", () => {
  const okFetch = (body: string, status = 200) =>
    (async () =>
      new Response(body, {
        status,
        headers: { "content-type": "application/rss+xml" },
      })) as unknown as typeof fetch;

  it("成功返回条目", async () => {
    const r = await fetchFeed(src("s1"), { fetchImpl: okFetch(RSS) });
    assert(r.ok, "应成功");
    assertEqual(r.items.length, 2);
  });

  it("HTTP 500 → http_status（带状态码）", async () => {
    const r = await fetchFeed(src("s1"), { fetchImpl: okFetch("boom", 500) });
    assert(!r.ok);
    assertEqual(r.error, "http_status");
    assertEqual(r.status, 500);
  });

  it("HTTP 404 → 提示可能下线", async () => {
    const r = await fetchFeed(src("s1"), { fetchImpl: okFetch("nope", 404) });
    assert(!r.ok);
    assert(r.message.includes("404"));
  });

  it("网络异常 → network", async () => {
    const boom = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await fetchFeed(src("s1"), { fetchImpl: boom });
    assert(!r.ok);
    assertEqual(r.error, "network");
  });

  it("超时 → timeout，且不泄露内部异常", async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as unknown as typeof fetch;
    const r = await fetchFeed(src("s1"), { fetchImpl: hang, timeoutMs: 20 });
    assert(!r.ok);
    assertEqual(r.error, "timeout");
    assert(!r.message.includes("Abort"), "文案不应回显内部异常");
  });

  it("非 http(s) 地址 → invalid_source", async () => {
    const r = await fetchFeed(src("s1", "ftp://example.com/feed"), { fetchImpl: okFetch(RSS) });
    assert(!r.ok);
    assertEqual(r.error, "invalid_source");
  });

  it("返回 HTML 而非 feed → parse_error", async () => {
    const r = await fetchFeed(src("s1"), { fetchImpl: okFetch("<html>hi</html>") });
    assert(!r.ok);
    assertEqual(r.error, "parse_error");
  });
});

describe("fetchAllFeeds · 失败隔离（A6）", () => {
  it("坏源不影响好源，结果顺序与输入一致", async () => {
    const good = `<?xml version="1.0"?><rss version="2.0"><channel><title>g</title>
      <item><title>好条目</title><link>https://ok.com/1</link></item></channel></rss>`;

    const mock = (async (url: string) => {
      if (String(url).includes("bad")) return new Response("down", { status: 503 });
      return new Response(good, { status: 200 });
    }) as unknown as typeof fetch;

    const results = await fetchAllFeeds(
      [src("ok1", "https://ok.com/feed"), src("bad", "https://bad.com/feed"), src("ok2", "https://ok.com/feed2")],
      { fetchImpl: mock, concurrency: 2 },
    );

    assertEqual(results.length, 3);
    assertEqual(results[0]?.ok, true);
    assertEqual(results[1]?.ok, false);
    assertEqual(results[1]?.ok === false ? results[1].error : "", "http_status");
    assertEqual(results[2]?.ok, true, "坏源之后的源仍应被抓取");
  });
});

describe("healthOf · 三级健康（D10）", () => {
  const base = new Date().toISOString();

  it("抓取失败 → broken 并保留错误码", () => {
    const h = healthOf({ ok: false, source: src("s1"), error: "network", message: "x" });
    assertEqual(h.level, "broken");
    assertEqual(h.error, "network");
    assertEqual(h.itemCount, 0);
  });

  it("条目数骤降（<40% baseline）→ degraded", () => {
    const result = {
      ok: true as const,
      source: src("s1"),
      items: Array.from({ length: 2 }, (_, i) => ({
        id: String(i),
        sourceId: "s1",
        title: `t${i}`,
        link: `https://x.com/${i}`,
        publishedAt: null,
        summary: "",
      })),
    };
    const h = healthOf(result, 20);
    assertEqual(h.level, "degraded");
    assertEqual(h.itemCount, 2);
    assert(h.checkedAt >= base, "应有检查时间");
  });

  it("正常 → ok；无 baseline 时不误判", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      sourceId: "s1",
      title: `t${i}`,
      link: `https://x.com/${i}`,
      publishedAt: null,
      summary: "",
    }));
    assertEqual(healthOf({ ok: true, source: src("s1"), items }).level, "ok");
    assertEqual(healthOf({ ok: true, source: src("s1"), items }, 12).level, "ok");
  });

  // ── 2026-11-03 回归：截断 ≠ 坏源 ──────────────────────────────────
  //
  // 背景：旧实现把 `truncated`（被 maxItems 截断）直接判成 degraded，
  // 后果是 hf-blog（真实 895 条，只取 40 条）与 ithome（真实 60 条）天天报警，
  // 而它们其实完全健康。审查 A-11 当初的初衷是「察觉被截断」，
  // 但把「取样上限」当成「源故障」会让健康源被误报 —— 必须在回归测试里钉死。
  //
  // ⚠️ baseline 存的是**我们实际抓到的条数**（不是源的真实条数）——
  //    所以「上次抓到 40 条、这次也抓到 40 条」不是骤降，判 ok。
  it("被 maxItems 截断但条数与基线一致 → ok（截断是配置行为，不是源故障）", () => {
    const items = Array.from({ length: 40 }, (_, i) => ({
      id: String(i),
      sourceId: "s1",
      title: `t${i}`,
      link: `https://x.com/${i}`,
      publishedAt: null,
      summary: "",
    }));
    const h = healthOf({ ok: true, source: src("s1"), items, truncated: true }, 40);
    assertEqual(h.level, "ok", "被截断到与基线相同的条数时不应报异常");
    assertEqual(h.itemCount, 40);
  });

  it("条目数真的跌到基线 40% 以下 → 仍判 degraded（与截断无关）", () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      id: String(i),
      sourceId: "s1",
      title: `t${i}`,
      link: `https://x.com/${i}`,
      publishedAt: null,
      summary: "",
    }));
    const h = healthOf({ ok: true, source: src("s1"), items }, 40);
    assertEqual(h.level, "degraded", "源真从 40 条跌到 5 条时仍要报异常");
  });

  // ── 2026-11-03 回归：改 maxItems 后不得全源误报 degraded ──────────
  //
  // 背景：baseline 记的是「历史上抓到过多少条」（可能是 40），而 maxItems 后来从 40 降到 15。
  //   直接比较 → 「15 < 40×0.4」恒成立 → **所有源都被误报 degraded**
  //   （实测上线后 arxiv-cs-ai 与 ithome 立刻中招）。
  // 修法：比较前把 baseline 封顶到本次配置的取样上限。
  it("历史 baseline 高于当前取样上限时 → 封顶后判 ok（改 maxItems 不得误报）", () => {
    const items = Array.from({ length: 15 }, (_, i) => ({
      id: String(i),
      sourceId: "s1",
      title: `t${i}`,
      link: `https://x.com/${i}`,
      publishedAt: null,
      summary: "",
    }));
    // 历史 baseline=40（旧的 maxItems=40 时代），本次只取 15（新的 maxItems=15）
    const h = healthOf({ ok: true, source: src("s1"), items, truncated: true }, 40, { maxItems: 15 });
    assertEqual(h.level, "ok", "取样上限降到 15 后不应把正常源误报为 degraded");
  });

  it("封顶后仍远低于真实抓取量 → 仍判 degraded（封顶不掩盖真骤降）", () => {
    const items = Array.from({ length: 3 }, (_, i) => ({
      id: String(i),
      sourceId: "s1",
      title: `t${i}`,
      link: `https://x.com/${i}`,
      publishedAt: null,
      summary: "",
    }));
    // 上限 15、baseline 40（封顶后为 15）→ 3 < 15×0.4=6 → 真骤降
    const h = healthOf({ ok: true, source: src("s1"), items }, 40, { maxItems: 15 });
    assertEqual(h.level, "degraded", "只抓到 3 条时仍要报异常");
  });
});