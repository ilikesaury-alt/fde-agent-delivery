/**
 * 产品⑤ · 领域类型（无运行时依赖，前端/服务端/测试共用）
 */

/** 一个订阅源（RSS/Atom） */
export type FeedSource = {
  /** 稳定短 id（入库与外键用） */
  id: string;
  /** 展示名 */
  name: string;
  /** feed URL（必须 http/https） */
  url: string;
  /** 语言：zh / en / other —— 仅用于日报分组，不做过滤 */
  lang: "zh" | "en" | "other";
  /**
   * 是否已 M0 实测可用。
   * 纪律（CONTEXT D4）：未实测的源不得视为「可靠源」，UI/日报需能区分。
   */
  verified: boolean;
};

/** 从 feed 解析出的单条资讯（未入库、未评分） */
export type RawItem = {
  /** 去重键：guid > atom id > link > 内容 hash，见 lib/rss.ts */
  id: string;
  sourceId: string;
  title: string;
  link: string;
  /** ISO8601；解析不出为 null（不猜时间） */
  publishedAt: string | null;
  /** 纯文本摘要，已去标签、截断 */
  summary: string;
};

/** 抓取失败分类（面向用户文案由此映射，不泄露上游响应体） */
export type FeedErrorCode =
  | "invalid_source"
  | "network"
  | "timeout"
  | "http_status"
  | "parse_error"
  | "empty";

export type FeedFetchResult =
  | { ok: true; source: FeedSource; items: RawItem[] }
  | { ok: false; source: FeedSource; error: FeedErrorCode; status?: number; message: string };

/** 源健康三级（CONTEXT D10） */
export type SourceHealthLevel = "ok" | "degraded" | "broken";

export type SourceHealth = {
  sourceId: string;
  level: SourceHealthLevel;
  error?: FeedErrorCode;
  itemCount: number;
  checkedAt: string;
};