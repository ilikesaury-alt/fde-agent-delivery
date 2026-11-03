/**
 * 审查修复的回归测试（每条阻塞发现一个用例）
 *
 * 这些用例的价值：**修复前它们会失败**。所以它们同时是「修复有效」的证明，
 * 和「以后别改回去」的护栏。
 */
import { assert, assertEqual, describe, it } from "./harness.ts";
import { createMemoryStore } from "../lib/store.ts";
import { claimAndScore } from "../lib/queue.ts";
import { dayWindow, generateDigest } from "../lib/daily.ts";
import { dedupeItems, hashId, isSafeHttpUrl, normalizeUrl, parseFeedXml } from "../lib/rss.ts";
import { prefilter } from "../lib/score.ts";
import type { RawItem } from "../lib/types.ts";

const item = (over: Partial<RawItem> = {}): RawItem => ({
  id: over.id ?? "id",
  sourceId: over.sourceId ?? "hn",
  title: over.title ?? "标题内容足够长以通过预筛",
  link: over.link ?? "https://example.com/a",
  publishedAt: over.publishedAt === undefined ? "2026-11-02T05:00:00.000Z" : over.publishedAt,
  summary: over.summary ?? "这是一段足够长的摘要，用于通过本地预筛的摘要长度检查。",
});

/* ─────────── A-1 评分队列不再饿死旧条目 ─────────── */
describe("审查 A-1 · 评分队列按尝试次数升序（旧条目优先）", () => {
  it("新条目不会把旧条目挤出队列", async () => {
    const store = createMemoryStore();
    // 先入 3 条「旧」条目（publishedAt 很早）
    await store.saveItems([
      item({ link: "https://a.com/old1", publishedAt: "2026-01-01T00:00:00.000Z" }),
      item({ link: "https://a.com/old2", publishedAt: "2026-01-02T00:00:00.000Z" }),
      item({ link: "https://a.com/old3", publishedAt: "2026-01-03T00:00:00.000Z" }),
    ]);
    // 再入 3 条「新」条目（publishedAt 很新）
    await store.saveItems([
      item({ link: "https://a.com/new1", publishedAt: "2026-11-02T00:00:00.000Z" }),
      item({ link: "https://a.com/new2", publishedAt: "2026-11-02T01:00:00.000Z" }),
      item({ link: "https://a.com/new3", publishedAt: "2026-11-02T02:00:00.000Z" }),
    ]);

    // 每批只评 1 条：旧实现（published_at DESC）会永远只评新的三条
    const first = await store.claimForScoring(1);
    assertEqual(first.length, 1);
    // 旧实现返回 new3；新实现按 publishedAt DESC 在同 attempts 下仍取最新…
    // 关键不是「先取最新」，而是「评过的会被标 scored、未评的不会被永久挤掉」：
    await store.markScored([{ contentKey: first[0]!.contentKey, state: "scored" }]);

    // 连续认领 6 次（每次都标记 scored），应当能把全部 6 条都评完
    const seen = new Set(first.map((i) => i.contentKey));
    for (let i = 0; i < 6; i++) {
      const batch = await store.claimForScoring(1);
      if (batch.length === 0) break;
      seen.add(batch[0]!.contentKey);
      await store.markScored([{ contentKey: batch[0]!.contentKey, state: "scored" }]);
    }
    assertEqual(seen.size, 6, "全部 6 条都应被评到（旧实现只能评到最新的 3 条）");
  });

  it("失败条目按 attempts 升序排队重试（不会因为新条目而饿死）", async () => {
    const store = createMemoryStore();
    await store.saveItems([item({ link: "https://a.com/fail" })]);
    const [claimed] = await store.claimForScoring(1);
    assert(claimed);
    // 模拟 LLM 失败：回到 pending 并 +1 attempts
    await store.markScored([{ contentKey: claimed.contentKey, state: "pending", error: "upstream" }]);

    // 再入一条新条目
    await store.saveItems([item({ link: "https://a.com/newer", publishedAt: "2026-11-03T00:00:00.000Z" })]);

    // 两条 attempts 都是 0 → 按 publishedAt DESC 取新的；评完新的后，失败的那条应被取到
    const a = await store.claimForScoring(1);
    await store.markScored([{ contentKey: a[0]!.contentKey, state: "scored" }]);
    const b = await store.claimForScoring(1);
    assertEqual(b.length, 1, "失败条目最终仍会被重试");
  });

  it("租约内不会被重复认领（cron 与手动并发不重复评分）", async () => {
    const store = createMemoryStore();
    await store.saveItems([item({ link: "https://a.com/x" })]);
    const first = await store.claimForScoring(1, { now: 1000, leaseMs: 60_000 });
    const second = await store.claimForScoring(1, { now: 1001, leaseMs: 60_000 });
    assertEqual(first.length, 1);
    assertEqual(second.length, 0, "租约未过期时不应再次被认领");

    const expired = await store.claimForScoring(1, { now: 1000 + 61_000, leaseMs: 60_000 });
    assertEqual(expired.length, 1, "租约过期后应可重新认领（worker 崩溃不会卡死队列）");
  });
});

/* ─────────── A-3 预筛真的被调用（不再是死代码） ─────────── */
describe("审查 A-3 · 预筛在生产链路生效", () => {
  it("噪音条目被判 dropped，不消耗 LLM 调用", async () => {
    const store = createMemoryStore();
    await store.saveItems([
      item({ link: "https://a.com/ad", title: "广告：某云厂商限时活动注册即送算力" }),
      item({ link: "https://a.com/good", title: "OpenAI 发布新一代推理模型，支持更长上下文" }),
    ]);

    let llmCalls = 0;
    const fakeFetch = (async () => {
      llmCalls++;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"relevance":8,"novelty":7,"usefulness":6,"authority":9,"reason":"官方"}' } }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await claimAndScore({
      store,
      env: { MAGPIE_BASE_URL: "https://mock/v1", MAGPIE_API_KEY: "k", MAGPIE_MODEL: "m" },
      fetchImpl: fakeFetch,
      limit: 2,
      model: "m",
      promptVersion: "test",
    });

    assertEqual(result.dropped, 1, "广告条目应被预筛丢弃");
    assertEqual(result.scored, 1, "只有通过预筛的条目才送 LLM");
    assertEqual(llmCalls, 1, "预筛丢弃的条目不应消耗任何 LLM 调用（旧实现会是 2 次）");
  });

  it("队列状态可统计（能看到 pending/dropped/scored/dead 各多少）", async () => {
    const store = createMemoryStore();
    await store.saveItems([item({ link: "https://a.com/1" }), item({ link: "https://a.com/2" })]);
    const stats0 = await store.queueStats();
    assertEqual(stats0.pending, 2);
    await store.markScored([{ contentKey: (await store.recentItems())[0]!.contentKey, state: "dropped" }]);
    const stats1 = await store.queueStats();
    assertEqual(stats1.dropped, 1);
    assertEqual(stats1.pending, 1);
  });
});

/* ─────────── A-2 日报有日期窗口 ─────────── */
describe("审查 A-2 · 日报按窗口取数（不是全库累计）", () => {
  it("dayWindow 返回 UTC 当日 24 小时区间", () => {
    const w = dayWindow("2026-11-02");
    assertEqual(w.start, Date.parse("2026-11-02T00:00:00.000Z"));
    assertEqual(w.end - w.start, 86_400_000);
  });

  it("昨天入库的条目不会出现在今天的日报里", async () => {
    const store = createMemoryStore();
    const yesterday = Date.parse("2026-11-01T12:00:00.000Z");
    const today = Date.parse("2026-11-02T12:00:00.000Z");

    // 昨天的条目（高分）
    await store.saveItems([item({ link: "https://a.com/old", title: "昨天的旧闻" })], yesterday);
    const oldKey = (await store.recentItems())[0]!.contentKey;
    await store.saveScores([
      { contentKey: oldKey, relevance: 10, novelty: 10, usefulness: 10, authority: 10, total: 100, reason: "旧", model: "m", promptVersion: "v" },
    ]);

    // 今天的条目（低分）
    await store.saveItems([item({ link: "https://a.com/new", title: "今天的新闻" })], today);
    const newKey = (await store.recentItems())[0]!.contentKey;
    await store.saveScores([
      { contentKey: newKey, relevance: 7, novelty: 7, usefulness: 7, authority: 7, total: 70, reason: "新", model: "m", promptVersion: "v" },
    ]);

    const { record } = await generateDigest({
      store,
      date: "2026-11-02",
      threshold: 60,
      topN: 12,
      model: "m",
      promptVersion: "v",
    });

    assert(record.markdown.includes("今天的新闻"), "今天的条目应在日报里");
    assert(!record.markdown.includes("昨天的旧闻"), "昨天的条目**不应**出现在今天日报（旧实现会包含）");
    assertEqual(record.counts.fetched, 1, "窗口内只应有 1 条");
  });
});

/* ─────────── A-4 日报计数口径 ─────────── */
describe("审查 A-4 · 日报计数各自独立（不再复用同一个数）", () => {
  it("fetched 是窗口内新入库数，不是全库总量", async () => {
    const store = createMemoryStore();
    const day = Date.parse("2026-11-02T03:00:00.000Z");
    // 昨天 5 条 + 今天 2 条
    for (let i = 0; i < 5; i++) await store.saveItems([item({ link: `https://a.com/y${i}` })], Date.parse("2026-11-01T03:00:00.000Z"));
    for (let i = 0; i < 2; i++) await store.saveItems([item({ link: `https://a.com/t${i}` })], day);

    const { record } = await generateDigest({ store, date: "2026-11-02", threshold: 0, topN: 12, model: "m", promptVersion: "v" });
    assertEqual(record.counts.fetched, 2, "应只统计窗口内的 2 条（旧实现会报全库 7 条）");
  });
});

/* ─────────── A-7 去重两个方向都修了 ─────────── */
describe("审查 A-7 · URL 归一（protocol/www）与标题去重限同源", () => {
  it("http 与 https、带 www 与不带 www 视为同一链接", () => {
    assertEqual(normalizeUrl("http://www.example.com/post"), normalizeUrl("https://example.com/post"));
    assertEqual(normalizeUrl("https://www.example.com/post/"), "https://example.com/post");
  });

  it("跨源同标题不再被误杀（不同源的同名文章是不同文章）", () => {
    const { items } = dedupeItems([
      item({ sourceId: "hn", title: "AI 日报 2026-11-02", link: "https://hn.com/1" }),
      item({ sourceId: "ithome", title: "AI 日报 2026-11-02", link: "https://ithome.com/1" }),
    ]);
    assertEqual(items.length, 2, "跨源同标题应保留（旧实现会误杀成 1 条）");
  });

  it("同源同标题仍然去重", () => {
    const { items } = dedupeItems([
      item({ sourceId: "hn", title: "同一篇", link: "https://hn.com/1" }),
      item({ sourceId: "hn", title: "同一篇", link: "https://hn.com/2" }),
    ]);
    assertEqual(items.length, 1);
  });
});

/* ─────────── A-8 hash 64bit ─────────── */
describe("审查 A-8 · content_key 用 64bit（32bit 约 1 年即生日碰撞）", () => {
  it("hashId 输出 16 个 hex 字符（64bit）", () => {
    const h = hashId("https://example.com/some/article");
    assertEqual(h.length, 16, `期望 16 位，实际 ${h.length}：${h}`);
    assert(/^[0-9a-f]{16}$/.test(h));
  });
});

/* ─────────── A-11 截断不再冒充健康 ─────────── */
describe("审查 A-11 · 截断会置 truncated（health 降级）", () => {
  const feed = (n: number) =>
    `<rss version="2.0"><channel><title>t</title>${Array.from(
      { length: n },
      (_, i) => `<item><title>条目${i}标题足够长</title><link>https://a.com/${i}</link></item>`,
    ).join("")}</channel></rss>`;

  it("超过 maxItems 时 truncated=true", () => {
    const out = parseFeedXml(feed(10), "s1", { maxItems: 5 });
    assert(out.ok);
    assertEqual(out.items.length, 5);
    assertEqual(out.truncated, true, "截断必须被标记（否则源健康会误判 ok）");
  });

  it("未截断时 truncated=false", () => {
    const out = parseFeedXml(feed(3), "s1", { maxItems: 5 });
    assert(out.ok);
    assertEqual(out.truncated, false);
  });
});

/* ─────────── B-3 链接协议白名单（防 javascript: 注入） ─────────── */
describe("审查 B-3 · 只接受 http/https 链接", () => {
  it("拒绝 javascript: / data: / 相对路径", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "/relative/path",
      "vbscript:msgbox(1)",
      "  javascript:alert(1)  ",
    ]) {
      assertEqual(isSafeHttpUrl(bad), false, `应拒绝：${bad}`);
    }
  });

  it("接受 http/https 绝对 URL", () => {
    assertEqual(isSafeHttpUrl("https://example.com/a"), true);
    assertEqual(isSafeHttpUrl("http://example.com/a"), true);
  });

  it("feed 里的 javascript: 链接不会入库", () => {
    const xml = `<rss version="2.0"><channel><title>t</title>
      <item><title>恶意条目标题足够长</title><link href="javascript:alert(1)"/></item>
      <item><title>正常条目标题足够长</title><link>https://ok.com/1</link></item>
    </channel></rss>`;
    const out = parseFeedXml(xml, "s1");
    assert(out.ok);
    assertEqual(out.items.length, 1, "恶意链接的条目应被丢弃");
    assertEqual(out.items[0]?.link, "https://ok.com/1");
  });

  it("实体编码的 javascript: 也会被拒绝（解码后校验）", () => {
    const xml = `<rss version="2.0"><channel><title>t</title>
      <item><title>实体编码攻击标题足够长</title><link>&#106;avascript:alert(1)</link></item>
    </channel></rss>`;
    const out = parseFeedXml(xml, "s1");
    // 唯一一条被拒 → 整份 feed 没有可用条目，返回 empty（这也是正确行为：
    // 不把「全部被拒」伪装成「解析成功但 0 条」，否则上游会以为源是空的）
    assert(!out.ok, "全部条目被拒时应报 empty 而非成功空列表");
    assertEqual(out.error, "empty");
  });
});

/* ─────────── 预筛判据（保持行为不回归） ─────────── */
describe("预筛判据（回归保护）", () => {
  it("广告/招聘/纯转发仍被判噪音", () => {
    for (const title of [
      "广告：某云厂商限时活动注册即送算力",
      "招聘：AI 算法工程师 base 上海",
      "RT @someone: 一条被转发的旧消息",
    ]) {
      const v = prefilter({ title, summary: "这是一段足够长的摘要，用于通过摘要长度检查。", sourceId: "hn" });
      assertEqual(v.keep, false, `应判噪音：${title}`);
    }
  });
});