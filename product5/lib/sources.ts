/**
 * 默认订阅源列表（CONTEXT D4）
 *
 * ⚠️ 纪律：这里的每个 URL 都**未在本机实测**（沙箱 Node 出网受限）。
 *   `verified: false` 表示「待 M0 真环境验证」——不要在 UI/日报里当可靠源用。
 *   M0 逐个探针后把通过的改 true；失效的替换或删除（feed 会死是常态，D10）。
 *
 * 设计取舍：
 *   - 中英混合（用户未指定，按 D4 默认）
 *   - 只收「站点主动提供订阅」的源，不收需要登录/JS 渲染的页面（那是 X 的老路）
 *   - 单源条数由 FEED_MAX_ITEMS 限制，源数量受 Free 套餐 subrequest 50/次 约束
 *     → 一次 Cron 建议 ≤ 5 源（见 eval/README 与 CONTEXT A9）
 *
 * M0 实测（2026-11-02，真环境）：上列 6 源全部返回真实条目（hn 20 / hf 40 / arxiv 40 /
 * simonw 30 / ithome 40 / sspai 10）；verified 已回填。注意 hnrss.org 偶发 >8s 响应，
 * 默认超时已提到 12s（lib/rss.ts fetchFeed）。
 */
import type { FeedSource } from "./types.ts";

export const DEFAULT_SOURCES: FeedSource[] = [
  {
    id: "hn",
    name: "Hacker News 首页",
    url: "https://hnrss.org/frontpage",
    lang: "en",
    verified: true,
  },
  {
    id: "hf-blog",
    name: "Hugging Face Blog",
    url: "https://huggingface.co/blog/feed.xml",
    lang: "en",
    verified: true,
  },
  {
    id: "arxiv-cs-ai",
    name: "arXiv cs.AI",
    // ⚠️ 旧端点 export.arxiv.org/rss/<cat> 已迁移（实测返回无 item 的空壳 feed，2026-11-02）
    url: "https://rss.arxiv.org/rss/cs.AI",
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