/** 日报纯函数测试：D11 单源配额 / 固定板块 / 边界 */
import { assert, assertEqual, describe, it } from "./harness.ts";
import { buildDigest, HEADLINE_MARGIN, selectWithQuota, type DigestItem } from "../lib/digest.ts";

const item = (over: Partial<DigestItem> = {}): DigestItem => ({
  title: over.title ?? "标题",
  link: over.link ?? "https://example.com/a",
  sourceId: over.sourceId ?? "hn",
  total: over.total ?? 80,
  reason: over.reason ?? "理由",
  publishedAt: over.publishedAt === undefined ? 1762000000000 : over.publishedAt,
});

describe("selectWithQuota · D11 单源配额", () => {
  it("单源垄断时给其它源让位（本轮核心修复）", () => {
    // 5 条 arxiv（90-86 分）+ 2 条 hn（80/78）：不设配额时 top5 全 arxiv
    const items = [
      item({ sourceId: "arxiv", total: 90 }),
      item({ sourceId: "arxiv", total: 89 }),
      item({ sourceId: "arxiv", total: 88 }),
      item({ sourceId: "arxiv", total: 87 }),
      item({ sourceId: "arxiv", total: 86 }),
      item({ sourceId: "hn", total: 80 }),
      item({ sourceId: "hn", total: 78 }),
    ];

    const unquoted = selectWithQuota(items, { threshold: 70, topN: 5, perSourceMax: 99 });
    assertEqual(
      unquoted.kept.map((i) => i.sourceId),
      ["arxiv", "arxiv", "arxiv", "arxiv", "arxiv"],
      "不设配额时应被单源占满（复现线上问题）",
    );

    const quoted = selectWithQuota(items, { threshold: 70, topN: 5, perSourceMax: 2 });
    assertEqual(quoted.kept.map((i) => i.sourceId), ["arxiv", "arxiv", "hn", "hn"]);
    assertEqual(quoted.skippedByQuota, 3, "被配额挡下的 3 条 arxiv 应计数（日报里明示）");
  });

  it("阈值过滤先于配额；等于阈值算入选", () => {
    const items = [item({ total: 70 }), item({ total: 69 }), item({ total: 85, sourceId: "x" })];
    const r = selectWithQuota(items, { threshold: 70, topN: 10, perSourceMax: 5 });
    assertEqual(r.kept.length, 2);
    assertEqual(r.kept.map((i) => i.total), [85, 70]);
  });

  it("perSourceMax 至少为 1（防止配置成 0 导致日报空白）", () => {
    const r = selectWithQuota([item({ total: 90 })], { threshold: 0, topN: 5, perSourceMax: 0 });
    assertEqual(r.kept.length, 1);
  });

  it("同分时按发布时间倒序（新内容优先）", () => {
    const r = selectWithQuota(
      [
        item({ title: "旧", total: 80, publishedAt: 1000 }),
        item({ title: "新", total: 80, publishedAt: 2000 }),
      ],
      { threshold: 0, topN: 5, perSourceMax: 5 },
    );
    assertEqual(r.kept[0]?.title, "新");
  });

  it("topN 截断计数与配额让位分开统计（不重复计）", () => {
    const items = Array.from({ length: 10 }, (_, i) => item({ sourceId: `s${i}`, total: 90 - i }));
    const r = selectWithQuota(items, { threshold: 0, topN: 4, perSourceMax: 2 });
    assertEqual(r.kept.length, 4);
    assertEqual(r.skippedByQuota, 0);
    assertEqual(r.skippedByLimit, 6);
  });
});

describe("buildDigest · 固定板块", () => {
  const base = {
    date: "2026-11-02",
    threshold: 70,
    topN: 12,
    perSourceMax: 4,
    counts: { fetched: 180, kept: 180, scored: 60, aboveThreshold: 17, selected: 5 },
    sources: [
      { id: "hn", name: "Hacker News", level: "ok", itemCount: 20 },
      { id: "arxiv", name: "arXiv", level: "ok", itemCount: 40 },
      { id: "sspai", name: "少数派", level: "broken", itemCount: 0, error: "timeout" },
    ],
    model: "auto/minimax-m3.1-flash",
    promptVersion: "score-v1",
  };

  it("包含全部 6 个板块标题", () => {
    const { markdown } = buildDigest({
      ...base,
      items: [item({ total: 92 }), item({ sourceId: "arxiv", total: 78 })],
    });
    for (const h of ["一、今日概览", "二、头条", "三、值得一看", "四、分源视角", "五、源健康", "六、口径说明"]) {
      assert(markdown.includes(h), `缺少板块：${h}`);
    }
    assert(markdown.startsWith("# AI 资讯雷达日报 · 2026-11-02"));
  });

  it("头条门槛随阈值联动（阈值+15），没有头条时明确说明而非留空", () => {
    const { headlineThreshold, markdown } = buildDigest({ ...base, items: [] });
    assertEqual(headlineThreshold, 70 + HEADLINE_MARGIN);
    assert(markdown.includes("今日无头条级资讯"), "空头条要有明确文案");

    const onlyMid = buildDigest({ ...base, items: [item({ total: 75 })] });
    assert(onlyMid.markdown.includes("今日无头条级资讯"));
    assert(!onlyMid.markdown.includes("_今日无其它入选资讯。_"), "75 分应进「值得一看」");
  });

  it("配额让位在概览里明示（读者不会以为漏抓）", () => {
    const items = [
      item({ sourceId: "arxiv", total: 95 }),
      item({ sourceId: "arxiv", total: 94 }),
      item({ sourceId: "arxiv", total: 93 }),
      item({ sourceId: "arxiv", total: 92 }),
      item({ sourceId: "arxiv", total: 91 }),
      item({ sourceId: "hn", total: 80 }),
    ];
    const { markdown, quota } = buildDigest({ ...base, items });
    assert(quota.skippedByQuota > 0);
    assert(markdown.includes("单源配额让位"), "应明示让位条数");
  });

  it("坏源在「源健康」里标注并给出完整性提示", () => {
    const { markdown } = buildDigest({ ...base, items: [item({ total: 90 })] });
    assert(markdown.includes("不可用"), "broken 源应显示不可用");
    assert(markdown.includes("`timeout`"), "应展示错误码");
    assert(markdown.includes("日报内容可能因此不完整"), "坏源要有完整性提示");
  });

  it("口径段写入阈值/模型/prompt（可追溯）", () => {
    const { markdown } = buildDigest({ ...base, items: [] });
    assert(markdown.includes("**70**"));
    assert(markdown.includes("auto/minimax-m3.1-flash"));
    assert(markdown.includes("score-v1"));
    assert(markdown.includes("Precision 100%"), "阈值依据要写在日报里");
  });

  it("分源视角每个源最多一条（最高分那条）", () => {
    const { markdown } = buildDigest({
      ...base,
      items: [
        item({ sourceId: "hn", title: "HN 高分", total: 95 }),
        item({ sourceId: "hn", title: "HN 次高", total: 90 }),
        item({ sourceId: "arxiv", title: "arXiv 高分", total: 88 }),
      ],
    });
    // 只看「四、分源视角」这一板块内部（其它板块本就会列出这些条目）
    const section = markdown.split("## 四、分源视角")[1]?.split("## 五、源健康")[0] ?? "";
    assert(section.includes("HN 高分"), "该板块应有 HN 最高分那条");
    assert(!section.includes("HN 次高"), "分源视角只取每源最高分");
  });
});