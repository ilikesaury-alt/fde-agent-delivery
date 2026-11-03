/**
 * lib/rss.ts —— 订阅源抓取与解析（零第三方依赖）
 *
 * 为什么自己写解析：只支持 RSS 2.0 / Atom 的「取条目」子集，
 * 比引一个通用 XML 库更小、更可控，且解析器是纯函数 → 好测（先测后码）。
 *
 * 设计纪律：
 *  - **不猜**：日期解析不出就是 null，不塞 now；条目缺标题或链接就跳过，不造空壳。
 *  - **失败分类**：network / timeout / http_status / parse_error / empty —— 面向用户文案
 *    由上层映射（CONTEXT A6 / D10），这里不泄露上游响应体。
 *  - **不放大失败**：单源失败只影响自己，fetchAllFeeds 逐源收集结果。
 *  - **CDATA 也做实体解码**：不追求严格 XML 语义，追求展示可读（见 CONTEXT D5 备注）。
 */
import type {
  FeedErrorCode,
  FeedFetchResult,
  FeedSource,
  RawItem,
  SourceHealth,
  SourceHealthLevel,
} from "./types.ts";

/* ───────────────────────── 文本处理 ───────────────────────── */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** 解码 XML 实体（&amp; / &#39; / &#x27; …）；未知实体原样保留 */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, ent: string) => {
    if (ent.startsWith("#")) {
      const isHex = ent[1] === "x" || ent[1] === "X";
      const code = Number.parseInt(isHex ? ent.slice(2) : ent.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[ent] ?? whole;
  });
}

/** 去标签 + 压空白 + 截断（摘要用；不追求保留格式） */
export function toPlainText(input: string, maxLen = 400): string {
  // 顺序很重要（踩过的坑）：先解包 CDATA、再解码实体、最后剥标签。
  // 若先剥标签，`<![CDATA[...]]>` 会被 `<[^>]+>` 整段吃掉 → 标题变空、条目被跳过。
  let text = input.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  text = decodeEntities(text);
  text = text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  // 再解一次：RSS 普遍双重编码（&lt;p&gt;…&lt;/p&gt;），第一次解码后才露出标签
  text = decodeEntities(text);
  const plain = text.replace(/\s+/g, " ").trim();
  return plain.length > maxLen ? `${plain.slice(0, maxLen - 1).trimEnd()}…` : plain;
}

/**
 * 稳定 hash（双 FNV-1a 32bit 组合 → 64bit hex）。
 *
 * 为什么必须是 64bit（审查 A-8/B-8）：32bit 空间下约 7.7 万条即 50% 概率生日碰撞，
 * 按 180 条/日约一年就会撞。碰撞后果是 `INSERT OR IGNORE` 把后来者**静默判为重复**
 * （条目丢失、日志显示"判重"），且 `JOIN items ON content_key` 会把别人的分数挂上去。
 * 64bit 把 50% 碰撞点推到约 40 亿条，对本产品量级等于不会发生。
 */
export function hashId(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5 ^ 0x9e3779b9; // 用不同初值，降低两半相关
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0"));
}

/* ───────────────────────── XML 取字段 ───────────────────────── */

function attrValue(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(attrs);
  if (!m) return null;
  return decodeEntities(m[2] ?? m[3] ?? "");
}

/** 取某标签的 inner（配对标签）；返回首个命中 */
export function findTagInner(block: string, names: string[]): string | null {
  for (const name of names) {
    const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}\\s*>`, "i").exec(block);
    if (m && m[1] !== undefined) return m[1];
  }
  return null;
}

/**
 * 只允许 http/https 的绝对 URL。
 * 审查 B-3：第三方 feed 的 `<link href="javascript:...">` 会入库为 items.link，
 * 页面直接 href 出去 → 同源执行脚本、读走 localStorage 里的访问令牌（全站无 CSP 兜底）。
 * 实体编码（`&#106;avascript:`）会先被 decodeEntities 还原，所以必须在**解码后**校验。
 */
export function isSafeHttpUrl(raw: string): boolean {
  const text = raw.trim();
  if (!/^https?:\/\//i.test(text)) return false;
  try {
    const u = new URL(text);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** 解析条目里的链接：优先 Atom 的 href（rel 缺省或 alternate），回退 RSS 的文本链接 */
export function resolveItemLink(block: string): string | null {
  const tagRe = /<link\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(block))) {
    const attrs = m[1] ?? "";
    const href = attrValue(attrs, "href");
    if (!href) continue;
    const rel = attrValue(attrs, "rel");
    if (!rel || rel.toLowerCase() === "alternate" || rel.toLowerCase() === "home") {
      const trimmed = href.trim();
      // 协议白名单在**解码后**判定（防 &#106;avascript: 这类实体绕过）
      if (trimmed && isSafeHttpUrl(trimmed)) return trimmed;
    }
  }
  const inner = findTagInner(block, ["link"]);
  if (inner) {
    const text = decodeEntities(inner).trim();
    if (text && isSafeHttpUrl(text)) return text;
  }
  return null;
}

/** 解析日期：解析不出就是 null（不猜） */
export function parseDate(raw: string | null): string | null {
  if (!raw) return null;
  const text = decodeEntities(raw).trim();
  if (!text) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  // 过滤明显荒谬的时间（早于 1990 或超出当前 5 年）——坏 feed 常见
  const year = date.getUTCFullYear();
  if (year < 1990 || year > new Date().getUTCFullYear() + 5) return null;
  return date.toISOString();
}

/* ───────────────────────── 解析入口 ───────────────────────── */

export type ParseOutcome =
  | {
      ok: true;
      items: RawItem[];
      /**
       * 是否发生了截断（审查 A-11）。
       * 三种静默截断都会置位：maxItems 上限、响应体 2MB 上限、畸形 XML 提前闭合。
       * 置位后 health 应降为 `degraded` —— 否则「源其实有 100 条但只取到 40」永远察觉不到，
       * baseline 还会被抬到截断值，之后彻底看不见源在增长。
       */
      truncated: boolean;
    }
  | { ok: false; error: Extract<FeedErrorCode, "parse_error" | "empty">; message: string };

const ITEM_BLOCK_RE = /<(item|entry)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;

export type ParseOptions = {
  /** 单源最多解析多少条（默认 40） */
  maxItems?: number;
};

/**
 * 解析 RSS 2.0 / Atom 文本 → RawItem[]。
 * 纯函数：不触网、不读时钟（除日期合法性校验用的系统时间）。
 */
export function parseFeedXml(xml: string, sourceId: string, opts: ParseOptions = {}): ParseOutcome {
  const maxItems = opts.maxItems ?? 40;
  const raw = typeof xml === "string" ? xml : "";

  if (!raw.trim()) {
    return { ok: false, error: "parse_error", message: "订阅源返回空内容。" };
  }

  // 先剥注释与处理指令（CDATA 保留，交由 toPlainText/解码处理）
  const cleaned = raw.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[\s\S]*?\?>/g, "");

  const looksLikeFeed = /<rss\b|<feed\b|<rdf:RDF\b/i.test(cleaned);
  if (!looksLikeFeed) {
    return { ok: false, error: "parse_error", message: "该地址返回的不是订阅源（RSS/Atom）。" };
  }

  const items: RawItem[] = [];
  ITEM_BLOCK_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  let blockCount = 0;
  let hitLimit = false;
  while ((match = ITEM_BLOCK_RE.exec(cleaned)) !== null) {
    blockCount++;
    if (items.length >= maxItems) {
      hitLimit = true;
      break;
    }
    const block = match[3] ?? "";

    const rawTitle = findTagInner(block, ["title"]);
    const title = rawTitle ? toPlainText(rawTitle, 200) : "";
    if (!title) continue; // 没标题的条目不当资讯

    const link = resolveItemLink(block);
    if (!link) continue; // 没链接的条目无法回原文，跳过

    const guidRaw = findTagInner(block, ["guid", "id"]);
    const guid = guidRaw ? decodeEntities(guidRaw).trim() : "";
    // 去重键优先级：guid/id > 链接 > 内容 hash
    const id = guid || link || hashId(`${title}|${link}`);

    const summaryRaw = findTagInner(block, [
      "description",
      "summary",
      "content:encoded",
      "content",
    ]);
    const summary = summaryRaw ? toPlainText(summaryRaw, 400) : "";

    const publishedAt = parseDate(
      findTagInner(block, ["pubDate", "published", "updated", "dc:date"]),
    );

    items.push({ id, sourceId, title, link: link.trim(), publishedAt, summary });
  }

  if (items.length === 0) {
    return {
      ok: false,
      error: "empty",
      message: "订阅源里没有可用的条目（可能格式非标准或已停更）。",
    };
  }

  // 还有更多条目块没被解析 → 是 maxItems 截断
  const truncated = hitLimit || blockCount > items.length && blockCount >= maxItems;
  return { ok: true, items, truncated };
}

/* ───────────────────────── 去重 ───────────────────────── */

/** 归一化 URL：去主机大小写差异、尾斜杠、锚点与追踪参数 */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    const drop = new Set([
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "ref",
      "fbclid",
      "gclid",
      "spm",
    ]);
    for (const key of [...u.searchParams.keys()]) {
      if (drop.has(key.toLowerCase())) u.searchParams.delete(key);
    }
    u.hostname = u.hostname.toLowerCase();
    // 审查 A-7：不归一 protocol 与 www. 会让 `http://x.com/a` 与 `https://www.x.com/a`
    // 变成两个 content_key → 同一条资讯入库两条。统一按 https + 去 www 处理。
    if (u.hostname.startsWith("www.")) u.hostname = u.hostname.slice(4);
    if (u.protocol === "http:") u.protocol = "https:";
    u.pathname = u.pathname.replace(/\/+$/, "");
    let out = u.toString();
    if (out.endsWith("/")) out = out.slice(0, -1);
    return out;
  } catch {
    return raw.trim();
  }
}

export type DedupeResult = {
  items: RawItem[];
  /** 被去重丢掉的条数（用于日报/日志里报「跨源重复」） */
  dropped: number;
};

/**
 * 跨源去重（CONTEXT A2）：同归一化链接 或 同标题 hash 视为重复，保留先出现者。
 * 顺序保持输入顺序，便于「先到先得」的可解释性。
 */
export function dedupeItems(items: RawItem[]): DedupeResult {
  const seenLink = new Set<string>();
  const seenTitle = new Set<string>();
  const out: RawItem[] = [];
  let dropped = 0;

  for (const item of items) {
    const linkKey = normalizeUrl(item.link);
    // 审查 A-7：标题去重必须**限定同源**。跨源同标题（「AI 日报 2026-11-02」这类
    // 模板化标题）是不同文章，按标题跨源去重会把它们静默误杀。
    const titleKey = `${item.sourceId}::${hashId(item.title.trim().toLowerCase())}`;
    if (seenLink.has(linkKey) || seenTitle.has(titleKey)) {
      dropped++;
      continue;
    }
    seenLink.add(linkKey);
    seenTitle.add(titleKey);
    out.push(item);
  }

  return { items: out, dropped };
}

/* ───────────────────────── 抓取 ───────────────────────── */

export type FetchOptions = {
  /** 测试注入口 */
  fetchImpl?: typeof fetch;
  /** 单源超时（默认 8000ms） */
  timeoutMs?: number;
  /** 响应体上限（默认 2MB）—— 防超大 feed 吃内存 */
  maxBytes?: number;
  maxItems?: number;
};

const DEFAULT_UA =
  "ai-hot-radar/0.1 (+https://github.com/; personal demo; respects robots and feed etiquette)";

const ACCEPT =
  "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5";

function fail(
  source: FeedSource,
  error: FeedErrorCode,
  message: string,
  status?: number,
): FeedFetchResult {
  return { ok: false, source, error, status, message };
}

async function readCapped(resp: Response, maxBytes: number): Promise<string> {
  if (!resp.body) return "";
  const reader = resp.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let out = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    out += decoder.decode(value, { stream: true });
    if (bytes >= maxBytes) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  out += decoder.decode();
  return out;
}

/** 抓取 + 解析单个源。任何失败都分类返回，不抛异常（便于逐源收集） */
export async function fetchFeed(
  source: FeedSource,
  opts: FetchOptions = {},
): Promise<FeedFetchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  // 12s：M0 实测 hnrss.org 偶发 >8s 响应（首请求 timeout、重试即成功），默认提到 12s
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const maxBytes = opts.maxBytes ?? 2_000_000;

  let url: URL;
  try {
    url = new URL(source.url.trim());
  } catch {
    return fail(source, "invalid_source", "订阅源地址不合法。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fail(source, "invalid_source", "只支持 http/https 订阅源。");
  }
  if (url.username || url.password) {
    return fail(source, "invalid_source", "订阅源地址不应包含用户名或密码。");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let resp: Response;
    try {
      resp = await fetchImpl(url.toString(), {
        method: "GET",
        headers: { "user-agent": DEFAULT_UA, accept: ACCEPT },
        redirect: "follow",
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        return fail(source, "timeout", `订阅源响应超时（${timeoutMs}ms）。`);
      }
      void err;
      return fail(source, "network", "无法连接该订阅源，请检查地址或稍后重试。");
    }

    if (!resp.ok) {
      // 释放响应体（Workers 内存友好）
      await resp.body?.cancel().catch(() => undefined);
      return fail(
        source,
        "http_status",
        resp.status === 404
          ? "订阅源返回 404（可能已下线）。"
          : `订阅源返回 HTTP ${resp.status}。`,
        resp.status,
      );
    }

    let xml: string;
    try {
      xml = await readCapped(resp, maxBytes);
    } catch {
      return fail(source, "network", "订阅源读取中断，请稍后重试。");
    }

    const parsed = parseFeedXml(xml, source.id, { maxItems: opts.maxItems });
    if (!parsed.ok) return fail(source, parsed.error, parsed.message);

    return { ok: true, source, items: parsed.items, truncated: parsed.truncated };
  } finally {
    clearTimeout(timer);
  }
}

export type FetchAllOptions = FetchOptions & {
  /** 并发源数（默认 3；Workers 同时等待响应的连接上限是 6） */
  concurrency?: number;
};

/**
 * 逐源抓取，**失败隔离**（CONTEXT A6）：一个源失败不影响其它源。
 * 并发受控（默认 3），避免一次打满 Workers 的 6 连接限制。
 */
export async function fetchAllFeeds(
  sources: FeedSource[],
  opts: FetchAllOptions = {},
): Promise<FeedFetchResult[]> {
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, 6));
  const results: FeedFetchResult[] = new Array(sources.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= sources.length) return;
      results[index] = await fetchFeed(sources[index]!, opts);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, sources.length) }, () => worker()));
  return results;
}

/* ───────────────────────── 源健康（D10） ───────────────────────── */

/**
 * 三级健康：ok（正常）/ degraded（有错但拿到条目，或条数偏少）/ broken（彻底失败）。
 * 条数骤降由调用方传入 `baselineCount` 判定（首轮没有 baseline 时只按错误分级）。
 */
export function healthOf(
  result: FeedFetchResult,
  baselineCount?: number,
): SourceHealth {
  const checkedAt = new Date().toISOString();
  if (!result.ok) {
    return {
      sourceId: result.source.id,
      level: "broken",
      error: result.error,
      itemCount: 0,
      checkedAt,
    };
  }
  const count = result.items.length;
  // 审查 A-11：发生截断（条目上限 / 响应体上限 / 畸形 XML 提前闭合）时不能判 ok，
  // 否则「源其实有 100 条但只取到 40」永远察觉不到，baseline 还会被抬到截断值。
  if (result.truncated) {
    return { sourceId: result.source.id, level: "degraded", itemCount: count, checkedAt };
  }
  if (baselineCount && baselineCount >= 5 && count < baselineCount * 0.4) {
    return { sourceId: result.source.id, level: "degraded", itemCount: count, checkedAt };
  }
  return { sourceId: result.source.id, level: "ok", itemCount: count, checkedAt };
}

export function healthLevelLabel(level: SourceHealthLevel): string {
  if (level === "ok") return "正常";
  if (level === "degraded") return "异常（条目骤降）";
  return "不可用";
}