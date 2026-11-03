/**
 * 默认订阅源列表（CONTEXT D4）
 *
 * ⚠️ 纪律：这里的每个 URL 都必须**在本机实测可用**才进列表（feed 会死是常态，D10）。
 *   `verified: false` 表示「待 M0 真环境验证」——不要在 UI/日报里当可靠源用。
 *   失效的替换或删除（不要留着假装还能用）。
 *
 * 设计取舍：
 *   - 中英混合（用户未指定，按 D4 默认）
 *   - 只收「站点主动提供订阅」的源，不收需要登录/JS 渲染的页面（那是 X 的老路）
 *   - **官方源优先**（2026-11-03 决策）：一手来源权威度高、噪声低，契合四维评分里的「权威度」；
 *     媒体类源（techcrunch / importai 等）作为补充，量更大但靠评分与预筛压住。
 *
 * ⚠️ **硬约束：Cron 的 CPU 预算只有 10ms**（Cloudflare Workers Free 官方 limits），
 *   而外部 subrequest 也是 **50/次**。因此：
 *   - 源数量必须受控（当前 14 个源 → 14 次 fetch，逼近 50 上限但未越界）；
 *   - 单源 `maxItems` 由调用方压到 15（实测：解析耗时随条目数线性增长，
 *     与文档大小几乎无关 —— 14 源在 maxItems=15 时合计 ≈19ms，maxItems=40 时 ≈35ms）；
 *   - **D1 写入必须走 `db.batch()`**（batch 计 1 个内部 subrequest，而 D1 内部
 *     subrequest 上限是 1000/次；逐条发会瞬间打满）。
 *
 * 实测记录（2026-11-03，真实解析器 lib/rss.ts，非 grep 计数）：
 *   源              体积     n=15 耗时  条数/摘要达标  备注
 *   openai-news     819KB    1.7ms   40/40          官方一手 · 文档大但解析快
 *   deepmind         70KB    0.9ms   40/19          官方一手 · 一半条目无摘要
 *   google-ai        31KB    0.9ms   20/20          官方一手
 *   aws-ml          577KB    1.9ms   20/20          官方一手（云厂商）
 *   arxiv-api       108KB    1.5ms   40/40          论文 · **RSS 端点已失效，改用 Atom API**
 *   techcrunch-ai    18KB    0.9ms   20/20          媒体
 *   importai        437KB    1.4ms   20/19          媒体 · substack
 *   nvidia           281KB    2.0ms   18/18          官方一手
 *   marktechpost    326KB    2.2ms   10/10          媒体
 *   mit-tech-review 138KB    1.0ms   10/10          媒体
 *   hn               25KB    0.7ms   20/20          社区
 *   simonw          113KB    3.7ms   30/30          个人博客 · 解析偏慢
 *   ithome          150KB    1.7ms   40/40          中文
 *   sspai             4KB    0.5ms   10/8           中文
 *
 *   ⚠️ hf-blog（HuggingFace）已从列表移除：该 feed **不提供任何摘要**（实测 0/40 条有
 *     description）→ 预筛必然判「信息量不足」丢弃，占库存却零贡献。
 *     若未来它补上 description 再加回（它是好的一手源）。
 */
import type { FeedSource } from "./types.ts";

export const DEFAULT_SOURCES: FeedSource[] = [
  /* ── 英文 · 官方一手来源 ── */
  {
    id: "openai-news",
    name: "OpenAI News",
    url: "https://openai.com/news/rss.xml",
    lang: "en",
    verified: true,
  },
  {
    id: "deepmind",
    name: "Google DeepMind",
    // ⚠️ 该站返回 gzip 压缩响应；Worker fetch 自动解压（curl 需 --compressed）
    url: "https://deepmind.google/blog/rss.xml",
    lang: "en",
    verified: true,
  },
  {
    id: "google-ai",
    name: "Google AI Blog",
    url: "https://blog.google/innovation-and-ai/technology/ai/rss/",
    lang: "en",
    verified: true,
  },
  {
    id: "aws-ml",
    name: "AWS Machine Learning",
    url: "https://aws.amazon.com/blogs/machine-learning/feed/",
    lang: "en",
    verified: true,
  },
  {
    id: "nvidia",
    name: "NVIDIA Blog",
    url: "https://blogs.nvidia.com/feed/",
    lang: "en",
    verified: true,
  },
  {
    id: "arxiv-cs-ai",
    name: "arXiv cs.AI",
    // ⚠️ RSS 端点已于 2026-11 上游失效（rss.arxiv.org/rss/cs.AI 返回 892B 空壳、0 个 <item>，
    //    cs.CL / cs.LG 同样为 0）；改用官方 Atom API。
    //    Atom 的 <entry> 与 RSS 的 <item> 同构，解析器已兼容（实测 40 条 / 日期齐 / 摘要 40/40）。
    url: "https://export.arxiv.org/api/query?search_query=cat:cs.AI&start=0&max_results=40&sortBy=submittedDate&sortOrder=descending",
    lang: "en",
    verified: true,
  },

  /* ── 英文 · 社区与媒体 ── */
  {
    id: "hn",
    name: "Hacker News 首页",
    url: "https://hnrss.org/frontpage",
    lang: "en",
    verified: true,
  },
  {
    id: "simonw",
    name: "Simon Willison",
    url: "https://simonwillison.net/atom/everything/",
    lang: "en",
    verified: true,
  },
  {
    id: "techcrunch-ai",
    name: "TechCrunch AI",
    url: "https://techcrunch.com/category/artificial-intelligence/feed/",
    lang: "en",
    verified: true,
  },
  {
    id: "importai",
    name: "Import AI",
    url: "https://importai.substack.com/feed",
    lang: "en",
    verified: true,
  },
  {
    id: "marktechpost",
    name: "MarkTechPost",
    url: "https://www.marktechpost.com/feed/",
    lang: "en",
    verified: true,
  },
  {
    id: "mit-tech-review",
    name: "MIT Technology Review",
    url: "https://www.technologyreview.com/feed/",
    lang: "en",
    verified: true,
  },

  /* ── 中文源 ── */
  {
    id: "ithome",
    name: "IT之家",
    url: "https://www.ithome.com/rss/",
    lang: "zh",
    verified: true,
  },
  {
    id: "sspai",
    name: "少数派",
    url: "https://sspai.com/feed",
    lang: "zh",
    verified: true,
  },
];

export function findSource(id: string): FeedSource | undefined {
  return DEFAULT_SOURCES.find((s) => s.id === id);
}
