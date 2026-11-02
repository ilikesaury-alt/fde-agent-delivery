/** 存储层契约测试（内存实现即 D1 实现的语义标准） */
import { assert, assertEqual, describe, it } from "./harness.ts";
import { contentKeyOf, createMemoryStore } from "../lib/store.ts";
import type { RawItem } from "../lib/types.ts";

const item = (over: Partial<RawItem> = {}): RawItem => ({
  id: over.id ?? "id-1",
  sourceId: over.sourceId ?? "hn",
  title: over.title ?? "标题",
  link: over.link ?? "https://example.com/a",
  publishedAt: over.publishedAt === undefined ? "2026-11-02T05:00:00.000Z" : over.publishedAt,
  summary: over.summary ?? "",
});

describe("store · 入库与跨请求去重（A2）", () => {
  it("首次入库全部新增，第二次全部判重（跨请求去重靠 content_key）", async () => {
    const store = createMemoryStore();
    const items = [
      item({ id: "a", link: "https://a.com/1" }),
      item({ id: "b", link: "https://b.com/2" }),
      item({ id: "c", link: "https://c.com/3" }),
    ];

    const first = await store.saveItems(items);
    assertEqual(first, { inserted: 3, duplicates: 0 });

    const second = await store.saveItems(items);
    assertEqual(second, { inserted: 0, duplicates: 3 }, "重复抓取不应产生新行");
    assertEqual(store._size().items, 3);
  });

  it("同批内同链接（含追踪参数差异）只入一条", async () => {
    const store = createMemoryStore();
    const res = await store.saveItems([
      item({ title: "先到", link: "https://x.com/p?utm_source=rss" }),
      item({ title: "后到", link: "https://x.com/p" }),
    ]);
    assertEqual(res.inserted, 1);
    assertEqual(store._size().items, 1, "归一化 URL 后应判为同一条");
  });

  it("重复条目会更新 last_seen_at，但不改 first_seen_at", async () => {
    const store = createMemoryStore();
    await store.saveItems([item({ link: "https://t.com/1" })], 1000);
    await store.saveItems([item({ link: "https://t.com/1", title: "改过的标题" })], 5000);

    const [row] = await store.recentItems();
    assert(row);
    assertEqual(row.firstSeenAt, 1000, "第一次见到的时间是事实，不能被覆盖");
    assertEqual(row.lastSeenAt, 5000);
    assertEqual(row.title, "改过的标题", "标题以最新为准");
  });

  it("publishedAt 解析不出为 null（不猜当前时间）", async () => {
    const store = createMemoryStore();
    await store.saveItems([item({ publishedAt: null })]);
    const [row] = await store.recentItems();
    assertEqual(row?.publishedAt, null);
  });

  it("contentKeyOf 对同 URL 的不同写法一致", () => {
    assertEqual(
      contentKeyOf({ link: "https://Example.com/p/?utm_source=a#x" }),
      contentKeyOf({ link: "https://example.com/p" }),
    );
  });
});

describe("store · 读取顺序与筛选", () => {
  it("按 publishedAt 倒序，NULL 排最后", async () => {
    const store = createMemoryStore();
    await store.saveItems([
      item({ link: "https://n.com/old", publishedAt: "2026-10-01T00:00:00.000Z" }),
      item({ link: "https://n.com/new", publishedAt: "2026-11-02T00:00:00.000Z" }),
      item({ link: "https://n.com/none", publishedAt: null }),
    ]);
    const rows = await store.recentItems();
    assertEqual(
      rows.map((r) => r.link),
      ["https://n.com/new", "https://n.com/old", "https://n.com/none"],
    );
  });

  it("按源筛选 + limit", async () => {
    const store = createMemoryStore();
    await store.saveItems([
      item({ sourceId: "hn", link: "https://a.com/1" }),
      item({ sourceId: "hn", link: "https://a.com/2" }),
      item({ sourceId: "sspai", link: "https://b.com/1" }),
    ]);
    assertEqual((await store.recentItems({ sourceId: "hn" })).length, 2);
    assertEqual((await store.recentItems({ sourceId: "hn", limit: 1 })).length, 1);
  });
});

describe("store · 源健康与基线（D10）", () => {
  const source = (id: string) => ({
    id,
    name: id,
    url: `https://example.com/${id}`,
    lang: "en" as const,
    verified: true,
  });

  it("记录健康历史 + 快照；正常时抬升 baseline", async () => {
    const store = createMemoryStore();
    await store.recordRun(
      [{ source: source("hn"), health: { sourceId: "hn", level: "ok", itemCount: 20, checkedAt: "t" } }],
      1000,
    );
    await store.recordRun(
      [{ source: source("hn"), health: { sourceId: "hn", level: "ok", itemCount: 30, checkedAt: "t" } }],
      2000,
    );

    const [state] = await store.listSourceStates();
    assertEqual(state?.lastItemCount, 30);
    assertEqual(state?.baselineCount, 30, "正常且更多 → 抬升基线");
    assertEqual((await store.healthHistory("hn")).length, 2, "两次都要留历史");
  });

  it("坏源不把 baseline 拉低", async () => {
    const store = createMemoryStore();
    await store.recordRun(
      [{ source: source("hn"), health: { sourceId: "hn", level: "ok", itemCount: 40, checkedAt: "t" } }],
      1000,
    );
    await store.recordRun(
      [
        {
          source: source("hn"),
          health: { sourceId: "hn", level: "broken", error: "timeout", itemCount: 0, checkedAt: "t" },
        },
      ],
      2000,
    );

    const [state] = await store.listSourceStates();
    assertEqual(state?.baselineCount, 40, "坏源不能污染基线");
    assertEqual(state?.lastHealth, "broken");
    assertEqual(state?.lastError, "timeout");
  });

  it("healthHistory 倒序 + limit", async () => {
    const store = createMemoryStore();
    for (const [i, level] of ["broken", "degraded", "ok"].entries()) {
      await store.recordRun(
        [
          {
            source: source("s"),
            health: {
              sourceId: "s",
              level: level as "ok" | "degraded" | "broken",
              itemCount: i,
              checkedAt: "t",
            },
          },
        ],
        1000 + i,
      );
    }
    const rows = await store.healthHistory("s", 2);
    assertEqual(
      rows.map((r) => r.level),
      ["ok", "degraded"],
    );
  });
});
describe("store · 评分落库（增量 3）", () => {
  const row = (over: Partial<import("../lib/store.ts").ScoreRow> = {}) => ({
    contentKey: over.contentKey ?? "k1",
    relevance: over.relevance ?? 8,
    novelty: over.novelty ?? 7,
    usefulness: over.usefulness ?? 6,
    authority: over.authority ?? 9,
    total: over.total ?? 77,
    reason: over.reason ?? "官方发布",
    model: over.model ?? "m",
    promptVersion: over.promptVersion ?? "score-v1",
  });

  async function seed() {
    const store = createMemoryStore();
    await store.saveItems([
      item({ link: "https://a.com/1", title: "高分条目" }),
      item({ link: "https://a.com/2", title: "低分条目" }),
      item({ link: "https://a.com/3", title: "未评分条目" }),
    ]);
    const all = await store.recentItems();
    const key = (t: string) => all.find((i) => i.title === t)!.contentKey;
    return { store, key };
  }

  it("评分后从未评分列表中移除", async () => {
    const { store, key } = await seed();
    assertEqual((await store.listUnscored()).length, 3);
    await store.saveScores([row({ contentKey: key("高分条目"), total: 88 })]);
    const left = await store.listUnscored();
    assertEqual(left.length, 2);
    assert(!left.some((i) => i.title === "高分条目"));
  });

  it("重评分覆盖旧分（同一条只留最新，避免标定口径漂移）", async () => {
    const { store, key } = await seed();
    const k = key("高分条目");
    await store.saveScores([row({ contentKey: k, total: 88 })], 1000);
    await store.saveScores([row({ contentKey: k, total: 40, reason: "重评" })], 2000);

    const top = await store.listTopScored({ threshold: 0 });
    assertEqual(top.length, 1);
    assertEqual(top[0]?.total, 40);
    assertEqual(top[0]?.reason, "重评");
    assertEqual(top[0]?.scoredAt, 2000);
  });

  it("listTopScored 按阈值过滤并按总分倒序", async () => {
    const { store, key } = await seed();
    await store.saveScores([
      row({ contentKey: key("高分条目"), total: 88 }),
      row({ contentKey: key("低分条目"), total: 45 }),
    ]);

    const above = await store.listTopScored({ threshold: 60 });
    assertEqual(above.length, 1);
    assertEqual(above[0]?.title, "高分条目");
    assertEqual(above[0]?.total, 88);

    const all = await store.listTopScored({ threshold: 0 });
    assertEqual(all.map((i) => i.total), [88, 45]);
  });

  it("limit 生效", async () => {
    const { store, key } = await seed();
    await store.saveScores([
      row({ contentKey: key("高分条目"), total: 88 }),
      row({ contentKey: key("低分条目"), total: 70 }),
    ]);
    assertEqual((await store.listTopScored({ threshold: 0, limit: 1 })).length, 1);
  });
});

describe("store · 日报落库（增量 4）", () => {
  const record = (over: Partial<import("../lib/store.ts").DigestRecord> = {}) => ({
    date: over.date ?? "2026-11-02",
    markdown: over.markdown ?? "# 日报\n\n## 一、今日概览\n",
    threshold: over.threshold ?? 70,
    perSourceMax: over.perSourceMax ?? 4,
    topN: over.topN ?? 12,
    counts:
      over.counts ?? { fetched: 180, kept: 180, scored: 60, aboveThreshold: 17, selected: 5, skippedQuota: 2 },
    model: over.model ?? "m",
    promptVersion: over.promptVersion ?? "score-v1",
  });

  it("写入后可读回全文与口径字段", async () => {
    const store = createMemoryStore();
    await store.saveDigest(record());
    const back = await store.getDigest("2026-11-02");
    assert(back);
    assertEqual(back.threshold, 70);
    assertEqual(back.counts.selected, 5);
    assert(back.markdown.includes("今日概览"));
  });

  it("同一天重跑 = 覆盖（日报是当日最新结论，不是追加）", async () => {
    const store = createMemoryStore();
    await store.saveDigest(record({ markdown: "旧" }), 1000);
    await store.saveDigest(record({ markdown: "新" }), 2000);
    assertEqual((await store.getDigest("2026-11-02"))?.markdown, "新");
    assertEqual((await store.listDigests()).length, 1);
  });

  it("list 按日期/更新时间倒序且只给索引字段", async () => {
    const store = createMemoryStore();
    await store.saveDigest(record({ date: "2026-11-01" }), 1000);
    await store.saveDigest(record({ date: "2026-11-02" }), 2000);
    const list = await store.listDigests();
    assertEqual(list.map((d) => d.date), ["2026-11-02", "2026-11-01"]);
    assert(!("markdown" in (list[0] as object)), "索引不应带全文");
  });

  it("countItems / countScores 反映库内总量", async () => {
    const store = createMemoryStore();
    await store.saveItems([item({ link: "https://a.com/1" }), item({ link: "https://a.com/2" })]);
    const [k1] = await store.recentItems();
    await store.saveScores([
      {
        contentKey: k1!.contentKey,
        relevance: 8,
        novelty: 7,
        usefulness: 6,
        authority: 9,
        total: 76,
        reason: "r",
        model: "m",
        promptVersion: "v",
      },
    ]);
    assertEqual(await store.countItems(), 2);
    assertEqual(await store.countScores(), 1);
  });

  it("未写入时 getDigest 返回 null（不编造空日报）", async () => {
    const store = createMemoryStore();
    assertEqual(await store.getDigest("2026-11-02"), null);
  });
});
