/**
 * URL → 正文抽取
 *
 * 约束（Workers 运行时）：没有 headless 浏览器，只能 fetch + 静态解析。
 *  → 动态渲染页（SPA）、登录墙、强反爬站点抓不到正文。这不是 bug，是环境边界：
 *    抓不到时给明确错误 + 引导用户改用「粘贴文本」模式（验收标准 4）。
 *
 * 安全（SSRF）：用户可输入任意 URL，绝不能让它打到内网/云元数据服务。
 * 三道闸：
 *   ① 字面量校验（IPv4/IPv6 各种写法、userinfo、端口）
 *   ② DNS 解析后校验全部 A/AAAA（防 <x>.nip.io 这类「解析到内网」的域名）
 *   ③ 手动跟随重定向，逐跳校验（follow 会先打到内网再校验，等于没防）
 * 残余风险：②③ 之间仍有 DNS rebinding 的 TOCTOU 窗口；且本服务只用单令牌鉴权，
 * 非令牌持有者无法触发抓取。已在 CONTEXT.md「已知风险」中登记。
 */

import { parseHTML } from "linkedom";

export type FetchArticleResult = {
  text: string;
  title: string;
  /** 最终 URL（可能因重定向变化） */
  finalUrl: string;
};

export type FetchArticleErrorCode =
  | "invalid_url"
  | "blocked_host"
  | "network"
  | "http_status"
  | "empty";

export class FetchArticleError extends Error {
  code: FetchArticleErrorCode;
  constructor(code: FetchArticleErrorCode, message: string) {
    super(message);
    this.name = "FetchArticleError";
    this.code = code;
  }
}

/** 解析 IPv6 文本为 8 组 16 进制数；无法解析返回 null */
function parseIPv6(input: string): number[] | null {
  let s = input.trim().toLowerCase();
  if (!s.includes(":")) return null;

  // 尾部点分 IPv4（::ffff:127.0.0.1）先折算成两个 16 进制组
  if (s.includes(".")) {
    const lastColon = s.lastIndexOf(":");
    const v4 = s.slice(lastColon + 1);
    const parts = v4.split(".");
    if (parts.length !== 4) return null;
    const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
    if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    s = `${s.slice(0, lastColon + 1)}${(((nums[0] << 8) | nums[1]) >>> 0).toString(16)}:${(((nums[2] << 8) | nums[3]) >>> 0).toString(16)}`;
  }

  const dbl = s.indexOf("::");
  let head: string[];
  let tail: string[];
  if (dbl >= 0) {
    head = s.slice(0, dbl).split(":").filter((x) => x.length > 0);
    tail = s.slice(dbl + 2).split(":").filter((x) => x.length > 0);
  } else {
    head = s.split(":");
    tail = [];
  }

  const need = 8 - head.length - tail.length;
  if (dbl >= 0 ? need < 0 : need !== 0) return null;

  const groups = [...head, ...Array(dbl >= 0 ? need : 0).fill("0"), ...tail].map((g) =>
    /^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN,
  );
  if (groups.length !== 8 || groups.some((g) => !Number.isFinite(g))) return null;
  return groups;
}

/** IPv4 点分十进制是否属于禁止段 */
function ipv4Blocked(o: number[]): boolean {
  const [a, b, c] = o;
  if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 私有
  if (a === 127) return true; // 回环
  if (a === 169 && b === 254) return true; // link-local / 云元数据
  if (a === 172 && b >= 16 && b <= 31) return true; // 私有
  if (a === 192 && b === 168) return true; // 私有
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // 组播/保留
  return false;
}

/** 从 IPv6 组里取出嵌入的 IPv4（前 n 组为 0 或特定前缀时） */
function embeddedV4(groups: number[], pattern: number[], offset: number): number[] {
  for (let i = 0; i < pattern.length; i++) {
    if (groups[offset + i] !== pattern[i]) return [];
  }
  const hi = groups[offset + pattern.length];
  const lo = groups[offset + pattern.length + 1];
  if (hi === undefined || lo === undefined) return [];
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

function ipv6Blocked(groups: number[]): boolean {
  const allZeroHead = (n: number) => groups.slice(0, n).every((g) => g === 0);

  // :: 与 ::1
  if (allZeroHead(8)) return true;
  if (allZeroHead(7) && groups[7] === 1) return true;

  // IPv4-mapped ::ffff:0:0/96
  const mapped = embeddedV4(groups, [0, 0, 0, 0, 0, 0xffff], 0);
  if (mapped.length === 4 && ipv4Blocked(mapped)) return true;

  // IPv4-compatible ::/96（已废弃但仍是回环写法）
  const compat = embeddedV4(groups, [0, 0, 0, 0, 0, 0], 0);
  if (compat.length === 4 && ipv4Blocked(compat)) return true;

  // NAT64 64:ff9b::/96
  const nat64 = embeddedV4(groups, [0x64, 0xff9b, 0, 0, 0, 0], 0);
  if (nat64.length === 4 && ipv4Blocked(nat64)) return true;

  // 6to4 2002::/16，嵌入 IPv4 在 next 32 bits
  if (groups[0] === 0x2002) {
    const v4 = [(groups[1] >> 8) & 0xff, groups[1] & 0xff, (groups[2] >> 8) & 0xff, groups[2] & 0xff];
    if (ipv4Blocked(v4)) return true;
  }

  // fc00::/7 唯一本地，fe80::/10 链路本地
  if ((groups[0] & 0xfe00) === 0xfc00) return true;
  if ((groups[0] & 0xffc0) === 0xfe80) return true;

  return false;
}

/** 判定主机字面量是否为内网/本机（不解析 DNS；DNS 层由 assertHostResolvesPublic 负责） */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "metadata" || h === "metadata.google.internal") return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) return ipv4Blocked([Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])]);

  if (h.includes(":")) {
    const groups = parseIPv6(h);
    if (!groups) return true; // 解析不了就当危险
    return ipv6Blocked(groups);
  }

  if (!h.includes(".")) return true; // 无点短名视为内网
  return false;
}

export function validateUrl(raw: string): URL {
  let u: URL;
  const trimmed = raw.trim();
  try {
    u = new URL(trimmed);
  } catch {
    throw new FetchArticleError("invalid_url", "链接格式不正确，请检查后重试。");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new FetchArticleError("invalid_url", "只支持 http/https 链接。");
  }
  // 带凭据的 URL 会把用户名密码转发给目标站，且常被用来混淆主机
  if (u.username || u.password) {
    throw new FetchArticleError("invalid_url", "链接不能包含用户名或密码。");
  }
  if (u.port && !["80", "443", "8080", "8443"].includes(u.port)) {
    throw new FetchArticleError("invalid_url", "不支持该端口，请使用常见的 80/443 链接。");
  }
  if (trimmed.length > 2000) {
    throw new FetchArticleError("invalid_url", "链接过长，请使用正常文章链接。");
  }
  if (isBlockedHost(u.hostname)) {
    throw new FetchArticleError("blocked_host", "该地址不允许抓取，请改用「粘贴文本」模式。");
  }
  return u;
}

/** 用 Cloudflare DoH 解析域名，返回全部 A/AAAA 地址（失败返回 null） */
async function resolveHost(hostname: string, fetchImpl: typeof fetch): Promise<string[] | null> {
  const out: string[] = [];
  try {
    for (const type of ["A", "AAAA"]) {
      const resp = await fetchImpl(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
        { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5000) },
      );
      if (!resp.ok) continue;
      const data = (await resp.json()) as { Answer?: Array<{ data?: string; type?: number }> };
      for (const a of data.Answer ?? []) {
        if (typeof a.data === "string" && (a.type === 1 || a.type === 28)) out.push(a.data);
      }
    }
  } catch {
    return null;
  }
  return out.length ? out : null;
}

/** 域名解析结果必须全部是公网地址（防 nip.io / 自有域名指向内网） */
async function assertHostResolvesPublic(
  hostname: string,
  fetchImpl: typeof fetch,
  strict: boolean,
): Promise<void> {
  if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) return; // 字面量已校验
  const addresses = await resolveHost(hostname, fetchImpl);
  if (addresses === null) {
    // 解析失败通常是网络/DoH 不可用：strict 模式下拒绝，非 strict 交给字面量闸
    if (strict) {
      throw new FetchArticleError("blocked_host", "无法校验该链接指向的地址，请改用「粘贴文本」。");
    }
    return;
  }
  for (const addr of addresses) {
    if (isBlockedHost(addr)) {
      throw new FetchArticleError("blocked_host", "该地址不允许抓取，请改用「粘贴文本」模式。");
    }
  }
}

const DROP_SELECTORS = [
  "script",
  "style",
  "noscript",
  "iframe",
  "svg",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "button",
  "select",
  "template",
];

/** 从 HTML 抽正文（启发式：优先 <article>，否则取文本量最大的候选容器） */
export function extractFromHtml(html: string): { text: string; title: string } {
  const { document } = parseHTML(html);

  for (const sel of DROP_SELECTORS) {
    for (const el of document.querySelectorAll(sel)) el.remove();
  }

  const title =
    pick(document.querySelector('meta[property="og:title"]')?.getAttribute("content")) ||
    pick(document.querySelector("title")?.textContent) ||
    pick(document.querySelector("h1")?.textContent) ||
    "";

  const candidates = [
    document.querySelector("article"),
    document.querySelector('[role="main"]'),
    document.querySelector("main"),
    document.querySelector(".article-content"),
    document.querySelector("#content"),
    document.body,
  ].filter(Boolean) as Array<{ textContent?: string | null }>;

  let best = "";
  for (const el of candidates) {
    const t = normalizeText(el.textContent ?? "");
    if (t.length > best.length) best = t;
  }

  // body 里可能混入大量链接文字：若 <p> 聚合更长，用段落聚合
  const paragraphs = [...document.querySelectorAll("p")]
    .map((p) => normalizeText(p.textContent ?? ""))
    .filter((t) => t.length >= 20);
  if (paragraphs.length >= 2) {
    const joined = paragraphs.join("\n\n");
    if (joined.length > best.length * 0.6) best = joined;
  }

  return { text: best, title: normalizeText(title) };
}

function pick(v: string | null | undefined): string {
  return typeof v === "string" ? v.trim() : "";
}

function normalizeText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .trim();
}

export type FetchArticleOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  /** strict=true：DoH 解析失败也拒绝（默认 false，避免 DoH 抖动导致功能不可用） */
  strictDns?: boolean;
};

const MAX_REDIRECTS = 5;

/**
 * 抓取并抽取正文。失败抛 FetchArticleError（文案面向用户）。
 * 不做重试（奥卡姆：重试解决不了动态渲染/登录墙，只会拖长等待）。
 */
export async function fetchArticle(
  rawUrl: string,
  opts: FetchArticleOptions = {},
): Promise<FetchArticleResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let url = validateUrl(rawUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);

  try {
    await assertHostResolvesPublic(url.hostname, fetchImpl, opts.strictDns === true);

    let resp: Response | null = null;
    // 手动跟随重定向：每一跳都重新校验主机，避免「先打到内网再被事后拦下」
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let current: Response;
      try {
        current = await fetchImpl(url.href, {
          method: "GET",
          redirect: "manual",
          headers: {
            // 不带 UA 会被不少站点直接 403
            "user-agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            accept: "text/html,application/xhtml+xml",
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
          },
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new FetchArticleError("network", "抓取超时，请稍后重试或改用「粘贴文本」。");
        }
        throw new FetchArticleError("network", "无法访问该链接，请检查网络或改用「粘贴文本」。");
      }

      const status = current.status;
      if (status >= 300 && status < 400) {
        const location = current.headers.get("location");
        if (!location) {
          throw new FetchArticleError("http_status", "该链接跳转异常，请改用「粘贴文本」。");
        }
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new FetchArticleError("http_status", "该链接跳转异常，请改用「粘贴文本」。");
        }
        const validated = validateUrl(next.href); // 逐跳校验协议/主机/端口/凭据
        await assertHostResolvesPublic(validated.hostname, fetchImpl, opts.strictDns === true);
        url = validated;
        continue;
      }

      resp = current;
      break;
    }

    if (!resp) {
      throw new FetchArticleError("http_status", "该链接跳转次数过多，请改用「粘贴文本」。");
    }

    if (!resp.ok) {
      throw new FetchArticleError(
        "http_status",
        resp.status === 404
          ? "链接返回 404（页面不存在），请检查链接或改用「粘贴文本」。"
          : `抓取失败（HTTP ${resp.status}），请改用「粘贴文本」。`,
      );
    }

    const contentType = (resp.headers.get("content-type") ?? "").toLowerCase();
    if (contentType && !contentType.includes("text/html") && !contentType.includes("text/plain")) {
      throw new FetchArticleError("empty", "该链接不是网页正文，请改用「粘贴文本」。");
    }

    // 只读到上限，避免超大页面撑爆内存
    const maxBytes = opts.maxBytes ?? 2_000_000;
    let html: string;
    try {
      html = await readCapped(resp, maxBytes);
    } catch {
      // 读流阶段的 abort / 解码异常也要归一到用户可读文案（否则英文 DOMException 会上屏）
      throw new FetchArticleError("network", "抓取中断，请稍后重试或改用「粘贴文本」。");
    }

    let extracted: { text: string; title: string };
    try {
      extracted = extractFromHtml(html);
    } catch {
      throw new FetchArticleError("empty", "该页面无法解析正文，请改用「粘贴文本」。");
    }

    if (extracted.text.length < 50) {
      throw new FetchArticleError(
        "empty",
        "没有从该链接提取到正文（可能是需要登录或动态渲染的页面），请改用「粘贴文本」。",
      );
    }

    return { text: extracted.text, title: extracted.title, finalUrl: url.href };
  } finally {
    clearTimeout(timeout);
  }
}

async function readCapped(resp: Response, maxBytes: number): Promise<string> {
  if (!resp.body) return "";
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    out += decoder.decode(value, { stream: true });
    if (bytes >= maxBytes) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  out += decoder.decode();
  return out;
}
