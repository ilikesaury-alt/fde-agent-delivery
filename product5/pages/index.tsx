/**
 * 首页 — AI 资讯雷达
 *
 * 四个页签：日报 · 精选 · 历史 · 源健康
 *
 * 设计纪律（每条都对应一个真实后果）：
 *  - **不掩盖失败**：坏源显式列出（名称 + 错误分类 + 面向用户文案 + 连续失败次数），不静默吞掉
 *  - **不假装已验证**：源标注「待 M0 实测」的徽标，确认后才可信（CONTEXT D4）
 *  - **不猜**：日期缺失显示「—」，不填当前时间
 *  - **口径随内容走**：阈值/模型/prompt/配额都写在日报里，读者能核对「为什么是这几条」
 *  - **口径不一致就说**：日报与精选是两份数据，各自标明来源，不假装是同一份
 *
 * 视觉纪律（2026-11-03 重设计）：
 *  - **颜色只从令牌取**：全部用 var(--color-*) / var(--font-*) / var(--radius-*)，
 *    不再出现内联 slate/emerald/amber 硬编码色值 —— 亮暗两套由 styles.css 的
 *    令牌层统一覆盖（此前硬编码暗色系 + 白底，导致白底近白字、几乎不可见）
 *  - **单一强调色**：品牌色只给品牌元素（标题徽标、页签选中、链接、分数徽标），
 *    语义色只给语义（正常/降级/不可用、错误/警告），不做五彩斑斓
 *  - **DOM 契约不破**：浏览器 E2E 依赖「刷新按钮是第一个 button」「页签文字」
 *    「分数徽标为纯数字」「details/summary 折叠」等断言，改结构前先看 e2e/browser-e2e.mjs
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const TOKEN_KEY = "radar_token";

type Health = {
  sourceId: string;
  level: "ok" | "degraded" | "broken";
  error?: string;
  itemCount: number;
  checkedAt: string;
};

type FeedItem = {
  id: string;
  sourceId: string;
  title: string;
  link: string;
  publishedAt: string | null;
  summary: string;
};

type FeedResponse = {
  fetchedAt: string;
  elapsedMs: number;
  budget: { sources: number; maxItemsPerSource: number; timeoutMs: number };
  storage: string;
  persisted: { inserted: number; duplicates: number } | null;
  sources: Array<{
    id: string;
    name: string;
    lang: string;
    url: string;
    verified: boolean;
    health: Health;
  }>;
  failures: Array<{ sourceId: string; error: string; message: string; status?: number }>;
  counts: { fetched: number; kept: number; deduped: number };
  items: FeedItem[];
};

type RankedItem = {
  contentKey: string;
  sourceId: string;
  title: string;
  link: string;
  publishedAt: number | null;
  summary: string;
  total: number;
  reason: string;
};

type TopResponse = {
  storage: string;
  threshold: number;
  count: number;
  items: RankedItem[];
};

type DigestRecord = {
  date: string;
  markdown: string;
  threshold: number;
  perSourceMax: number;
  topN: number;
  counts: {
    fetched: number;
    kept: number;
    scored: number;
    aboveThreshold: number;
    selected: number;
    skippedQuota: number;
  };
  model: string;
  promptVersion: string;
};

type DigestResponse = {
  storage: string;
  digest: DigestRecord | null;
  list?: Array<{ date: string; selected: number; threshold: number; updatedAt: number }>;
  message?: string;
};

type SourceDetail = {
  id: string;
  name: string;
  url: string;
  lang: string;
  verified: boolean;
  lastCheckedAt: number | null;
  lastHealth: string | null;
  lastError: string | null;
  lastItemCount: number;
  baselineCount: number | null;
  consecutiveFailures: number;
  history: Array<{
    level: string;
    error: string | null;
    itemCount: number;
    elapsedMs: number | null;
    checkedAt: number;
  }>;
};

type SourcesResponse = { storage: string; sources: SourceDetail[]; message?: string };

type ItemsResponse = {
  storage: string;
  count: number;
  items: Array<{
    contentKey: string;
    sourceId: string;
    title: string;
    link: string;
    publishedAt: number | null;
    summary: string;
    firstSeenAt: number;
    lastSeenAt: number;
  }>;
};

type Tab = "digest" | "top" | "history" | "sources";

/**
 * POST /api/refresh 的响应（2026-11-03：取消全部定时任务后，
 * 刷新按钮改为**手动触发完整流程**：抓取 → 去重 → 评分 → 生成日报）。
 */
type RefreshResponse = {
  ok: boolean;
  elapsedMs: number;
  feed: {
    fetched: number;
    kept: number;
    deduped: number;
    inserted: number;
    duplicates: number;
    failures: number;
    elapsedMs: number;
  };
  score: {
    scored: number;
    dropped: number;
    duplicated: number;
    failed: number;
    dead: number;
    pending: boolean;
    /** 方案 D：本次批量粗筛覆盖的条数 */
    coarseScored: number;
    /** 方案 D：本次花在粗筛上的外部调用次数 */
    coarseCalls: number;
  } | null;
  digest: {
    date: string;
    counts: {
      fetched: number;
      kept: number;
      deduped: number;
      scored: number;
      aboveThreshold: number;
      selected: number;
      skippedQuota: number;
    };
    markdown: string;
  } | null;
  queue: Record<string, number>;
  warnings: string[];
};

/* ────────────────────── 工具 ────────────────────── */

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("zh-CN", { hour12: false });
}

function fmtEpoch(ms: number | null): string {
  if (!ms) return "—";
  return fmtTime(new Date(ms).toISOString());
}

/** 源健康三态 → 语义色（ok / degraded / broken） */
const LEVEL_STYLE: Record<string, string> = {
  ok: "border-[var(--color-ok-line)] bg-[var(--color-ok-soft)] text-[var(--color-ok)]",
  degraded: "border-[var(--color-warn-line)] bg-[var(--color-warn-soft)] text-[var(--color-warn)]",
  broken: "border-[var(--color-err-line)] bg-[var(--color-err-soft)] text-[var(--color-err)]",
};

const LEVEL_DOT: Record<string, string> = {
  ok: "bg-[var(--color-ok)]",
  degraded: "bg-[var(--color-warn)]",
  broken: "bg-[var(--color-err)]",
};

const LEVEL_TEXT: Record<string, string> = {
  ok: "正常",
  degraded: "异常（条目骤降）",
  broken: "不可用",
};

function levelText(level: string | null): string {
  if (!level) return "未抓取";
  return LEVEL_TEXT[level] ?? level;
}

/* ────────────────── 轻量 Markdown 渲染 ────────────────── */
/* 日报是我们自己生成的固定结构，语法可控 → 不引 markdown 库（省依赖、省体积、少一类 XSS 面）。
   注意：所有文本都经过 React 转义（不用 dangerouslySetInnerHTML），链接 href 走白名单校验。
   排版样式由 styles.css 的 .doc 承担（标题衬线、正文无衬线、链接/引用/列表统一）。 */

function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function renderLinks(text: string, keyPrefix: string): React.ReactNode[] {
  // 依次处理 [链接](url)；粗体由外层 renderInline 负责
  const nodes: React.ReactNode[] = [];
  const re = /\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const href = safeHref(m[2] ?? "");
    const inner = m[1] ?? "";
    nodes.push(
      href ? (
        <a key={`${keyPrefix}-a${i}`} href={href} target="_blank" rel="noreferrer noopener">
          {inner}
        </a>
      ) : (
        <span key={`${keyPrefix}-t${i}`} className="text-[var(--color-ink-3)]">
          {inner}
        </span>
      ),
    );
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  // 先按 **纯粗体** 分段（段内可能仍是 **[粗体链接](url)** 的形式），段内再解析链接。
  // 旧实现只认「粗体包裹的链接」，日报概览里的 **180** 这类纯粗体会带星号原样显示。
  const nodes: React.ReactNode[] = [];
  const boldRe = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = boldRe.exec(text)) !== null) {
    if (m.index > last) nodes.push(...renderLinks(text.slice(last, m.index), `${keyPrefix}-t${i}`));
    nodes.push(
      <strong key={`${keyPrefix}-b${i}`}>{renderLinks(m[1] ?? "", `${keyPrefix}-bi${i}`)}</strong>,
    );
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) nodes.push(...renderLinks(text.slice(last), `${keyPrefix}-t${i}`));
  return nodes;
}

function renderMarkdown(md: string): React.ReactNode {
  const lines = md.split("\n");
  const out: React.ReactNode[] = [];
  let list: Array<{ main: string; sub?: string }> = [];
  let inCode = false;

  const flushList = (key: string) => {
    if (list.length === 0) return;
    out.push(
      <ul key={key}>
        {list.map((li, idx) => (
          <li key={idx}>
            {renderInline(li.main, `${key}-${idx}`)}
            {li.sub ? <span className="doc-sub">{renderInline(li.sub, `${key}-${idx}-s`)}</span> : null}
          </li>
        ))}
      </ul>,
    );
    list = [];
  };

  lines.forEach((raw, idx) => {
    const line = raw.trimEnd();
    const key = `l${idx}`;

    if (line.startsWith("```")) {
      flushList(`${key}-pre`);
      inCode = !inCode;
      return;
    }
    if (inCode) {
      out.push(
        <pre key={key}>
          <code>{line}</code>
        </pre>,
      );
      return;
    }

    if (line.startsWith("# ")) {
      flushList(`${key}-h1`);
      out.push(<h1 key={key}>{renderInline(line.slice(2), key)}</h1>);
      return;
    }
    if (line.startsWith("## ")) {
      flushList(`${key}-h2`);
      out.push(<h2 key={key}>{renderInline(line.slice(3), key)}</h2>);
      return;
    }
    if (line.startsWith("### ")) {
      flushList(`${key}-h3`);
      out.push(<h3 key={key}>{renderInline(line.slice(4), key)}</h3>);
      return;
    }
    if (line.startsWith("> ")) {
      flushList(`${key}-q`);
      out.push(<blockquote key={key}>{renderInline(line.slice(2), key)}</blockquote>);
      return;
    }
    if (line.startsWith("- ")) {
      list.push({ main: line.slice(2) });
      return;
    }
    // 列表续行（缩进两格的「来源 · 时间」）：并入上一条列表项作为次行，不另起段落
    if (/^\s{2,}\S/.test(line) && list.length > 0) {
      const prev = list[list.length - 1];
      if (!prev.sub) prev.sub = line.trim();
      return;
    }
    if (line.trim() === "") {
      flushList(`${key}-blank`);
      return;
    }
    // 其它（正文行）
    flushList(`${key}-p`);
    out.push(<p key={key}>{renderInline(line, key)}</p>);
  });
  flushList("l-end");
  return out;
}

/* ────────────────────── 页面 ────────────────────── */

export default function IndexPage() {
  const [token, setToken] = useState("");
  const [tab, setTab] = useState<Tab>("digest");
  /** 最近一次刷新的完整结果（2026-11-03：刷新 = 手动跑完整流程） */
  const [lastRefresh, setLastRefresh] = useState<RefreshResponse | null>(null);
  /** 最近一次刷新的完成时刻（毫秒） */
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const [top, setTop] = useState<TopResponse | null>(null);
  const [digest, setDigest] = useState<DigestResponse | null>(null);
  const [digestList, setDigestList] = useState<NonNullable<DigestResponse["list"]>>([]);
  const [digestDate, setDigestDate] = useState<string | null>(null);
  const [items, setItems] = useState<ItemsResponse | null>(null);
  const [sources, setSources] = useState<SourcesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 上次刷新的结果摘要（成功时显示在控制条下方） */
  const [notice, setNotice] = useState<string | null>(null);
  /** 任一读接口返回 401 → 提示输入令牌（而不是把错误体当数据渲染到崩溃） */
  const [needToken, setNeedToken] = useState(false);
  const needTokenRef = useRef(false);
  const [authEnforced, setAuthEnforced] = useState(false);

  const authHeaders = useCallback(
    (tk: string): Record<string, string> => (tk ? { authorization: `Bearer ${tk}` } : {}),
    [],
  );

  /**
   * 唯一的取数入口：只有 **HTTP 200** 的 body 才会被返回（才可能进 state）。
   *
   * 背景（2026-11-03 白屏回归的教训）：配了 ACCESS_TOKEN 后所有读接口返回 401 +
   * `{error:"…"}`，旧的 `r.json().catch(()=>null)` 只防网络错、不防 4xx JSON 体，
   * 错误对象被塞进 state → `sources.sources.length` 抛 TypeError → React 水合崩溃 → 白屏。
   */
  const fetchJson = useCallback(
    async <T,>(tk: string, url: string): Promise<T | null> => {
      try {
        const res = await fetch(url, { headers: authHeaders(tk) });
        if (res.status === 401) {
          needTokenRef.current = true;
          setNeedToken(true);
          return null;
        }
        if (!res.ok) return null;
        needTokenRef.current = false;
        setNeedToken(false);
        return (await res.json()) as T;
      } catch {
        return null;
      }
    },
    [authHeaders],
  );

  /**
   * ⚠️ 2026-11-03：页面**初始加载不再自动抓取**，刷新按钮改为手动跑完整流程。
   *
   * 原来初始加载会调 `GET /api/feed`，而那个接口本身就去抓源站 ——
   * 等于「每次打开页面都自动抓 14 个源」。在取消全部定时任务的新设计下，
   * 这是违背意图的（用户明确要求：手动点击才触发完整流程）。
   * `GET /api/feed` 本身保留：它仍是「源站可达性探针」，
   * 部署脚本与 E2E 靠它验证出网与源健康。
   */

  const loadReadonly = useCallback(
    async (tk: string) => {
      const [topRes, digestRes, itemsRes, sourcesRes] = await Promise.all([
        fetchJson<TopResponse>(tk, "/api/top?limit=30"),
        fetchJson<DigestResponse>(tk, "/api/digest"),
        fetchJson<ItemsResponse>(tk, "/api/items?limit=60"),
        fetchJson<SourcesResponse>(tk, "/api/sources?history=20"),
      ]);
      if (topRes) setTop(topRes);
      if (digestRes) setDigest(digestRes);
      if (itemsRes) setItems(itemsRes);
      if (sourcesRes) setSources(sourcesRes);
    },
    [fetchJson],
  );

  const loadDigestList = useCallback(
    async (tk: string) => {
      const res = await fetchJson<DigestResponse>(tk, "/api/digest?list=1");
      if (res) setDigestList(res.list ?? []);
    },
    [fetchJson],
  );

  /** 只跑一次：先取出保存的令牌再用它发请求（避免先用空令牌打一轮 401） */
  const loadedRef = useRef(false);
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    const saved = typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null;
    const tk = saved ?? "";
    if (saved) setToken(saved);
    // 探测鉴权模式（/api/health 公开）：enforced 且没存令牌 → 立刻提示，不等 401
    void (async () => {
      try {
        const res = await fetch("/api/health");
        if (res.ok) {
          const body = (await res.json()) as { authMode?: string };
          if (body.authMode === "enforced") setAuthEnforced(true);
        }
      } catch {
        /* 健康探测失败不影响页面 */
      }
    })();
    // ⚠️ 2026-11-03：**不再在初始加载时抓取**。
    // 原来这里会调 `GET /api/feed`，而那个接口本身就去抓源站 ——
    // 等于「每次打开页面都自动抓 14 个源」。取消定时任务后，改为
    // 「用户点刷新才抓取+评分+生成日报」，页面加载只读库。
    void loadReadonly(tk);
    void loadDigestList(tk);
  }, [loadReadonly, loadDigestList]);

  /**
   * 刷新：跑**完整流程**（2026-11-03 起产品⑤ 取消了全部定时任务）。
   *
   * 流程：抓取 14 源 → L1/L2 去重 → 评分（预算 30 条）→ 生成日报。
   * 一次请求约 20–40 秒（抓取 ~10s + 评分 ~20s），所以按钮全程 loading。
   *
   * 失败分三档处理（与后端 /api/refresh 的降级策略对应）：
   *   401          → 提示输令牌
   *   网络/5xx     → 提示稍后重试（已抓到的数据仍在库里，不会丢）
   *   200 + warnings → 正常刷新，但把警告显示出来（如“评分失败 N 条”）
   */
  const refreshAll = useCallback(async () => {
    if (!token) {
      setNeedToken(true);
      needTokenRef.current = true;
      setError("请先输入访问令牌再刷新。");
      return;
    }
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/refresh", {
        method: "POST",
        headers: authHeaders(token),
      });
      if (res.status === 401) {
        needTokenRef.current = true;
        setNeedToken(true);
        setError("访问令牌无效或缺失，请重新输入。");
        return;
      }
      if (!res.ok) {
        setError(`刷新失败（HTTP ${res.status}），请稍后重试。已抓到的数据仍在库里，不会丢。`);
        return;
      }
      const body = (await res.json()) as RefreshResponse;
      setLastRefresh(body);
      setRefreshedAt(Date.now());

      // 把后端返回的新日报直接挂上，省掉一次请求
      if (body.digest) {
        setDigest({ storage: "ok", digest: body.digest as unknown as DigestRecord });
        setDigestDate(body.digest.date);
      }

      const s = body.score;
      const bits = [
        `抓取 ${body.feed.fetched} 条`,
        `新增 ${body.feed.inserted} 条`,
      ];
      if (s) {
        bits.push(`评分 ${s.scored} 条`);
        // 粗筛信息（方案 D）：只在真的粗筛过时显示，稳态下不显示
        if (s.coarseCalls > 0) {
          bits.push(`粗筛 ${s.coarseScored} 条 / ${s.coarseCalls} 次调用`);
        }
        if (s.duplicated > 0) bits.push(`去重跳过 ${s.duplicated} 条`);
        if (s.dropped > 0) bits.push(`预筛丢弃 ${s.dropped} 条`);
        if (s.failed > 0) bits.push(`失败 ${s.failed} 条`);
      }
      if (body.digest) {
        bits.push(`日报入选 ${body.digest.counts.selected} 条`);
      }
      bits.push(`耗时 ${(body.elapsedMs / 1000).toFixed(1)}s`);
      if (body.warnings.length > 0) {
        setError(body.warnings.join(" "));
      }
      if (s?.pending) {
        bits.push("队列仍有待评条目，可再点一次刷新继续消化");
      }
      setNotice(bits.join(" · "));
    } catch {
      setError("刷新失败（网络异常或服务暂不可用），请稍后重试。");
    } finally {
      setLoading(false);
    }

    // 刷新各页签的只读数据（日报已在上面直接更新）
    void loadReadonly(token);
    void loadDigestList(token);
  }, [authHeaders, loadReadonly, loadDigestList, token]);

  const openDigest = async (date: string) => {
    const res = await fetchJson<DigestResponse>(token, `/api/digest?date=${date}`);
    if (res?.digest) {
      setDigest(res);
      setDigestDate(date);
    }
  };

  const tabs = useMemo(
    () =>
      [
        { id: "digest" as const, label: "日报", badge: digest?.digest?.date },
        { id: "top" as const, label: "精选", badge: top?.count !== undefined ? `${top.count}` : undefined },
        { id: "history" as const, label: "历史", badge: items?.count !== undefined ? `${items.count}` : undefined },
        {
          id: "sources" as const,
          label: "源健康",
          badge: sources?.sources?.length ? `${sources.sources.length}` : undefined,
        },
      ] as Array<{ id: Tab; label: string; badge?: string }>,
    [digest, top, items, sources],
  );

  return (
    <main className="mx-auto max-w-6xl px-5 py-7 sm:px-6">
      {/* ── 页头 ── */}
      <header className="mb-6 flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
        <div>
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--color-brand-soft)] text-[var(--color-brand)]"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <circle cx="12" cy="12" r="9" />
                <circle cx="12" cy="12" r="4.5" />
                <path d="M12 12 L18.2 5.8" />
              </svg>
            </span>
            <h1 className="text-[19px] font-semibold tracking-tight text-[var(--color-ink)]">
              AI 资讯雷达
            </h1>
            <span className="rounded-full border border-[var(--color-brand-line)] bg-[var(--color-brand-soft)] px-2 py-[1px] text-[11px] font-medium text-[var(--color-brand)]">
              自动运行
            </span>
          </div>
          <p className="mt-1.5 text-[13px] text-[var(--color-ink-2)]">
            定时聚合多源 AI 资讯 → 评分精选 → 每日日报。阈值由评测集标定，源健康全程可见。
          </p>
        </div>
        <div className="text-[12px] leading-5 text-[var(--color-ink-3)]">
          {lastRefresh && refreshedAt ? (
            <>
              <div>上次刷新 {new Date(refreshedAt).toLocaleString("zh-CN", { hour12: false })}</div>
              <div>
                抓取 {lastRefresh.feed.fetched} 条 · 新增 {lastRefresh.feed.inserted} ·{" "}
                {lastRefresh.score ? `评分 ${lastRefresh.score.scored}` : "未评分"}
              </div>
            </>
          ) : (
            <div>尚未刷新（点「刷新」跑完整流程）</div>
          )}
        </div>
      </header>

      {/* ── 控制条 ── */}
      <section className="mb-5 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-2.5 shadow-[var(--shadow-sm)]">
        <input
          type="password"
          value={token}
          onChange={(e) => {
            const v = e.target.value;
            setToken(v);
            // 输入即保存（产品④ 同款）：粘贴一次，之后访问免填
            if (typeof localStorage !== "undefined") localStorage.setItem(TOKEN_KEY, v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") refreshAll();
          }}
          placeholder={authEnforced ? "访问令牌（本站已启用鉴权，必填）" : "访问令牌（未启用鉴权可留空）"}
          aria-label="访问令牌"
          className="min-w-[16rem] flex-1 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-inset)] px-3 py-1.5 text-[13px] text-[var(--color-ink)] placeholder:text-[var(--color-ink-3)]"
        />
        <button
          type="button"
          onClick={() => void refreshAll()}
          disabled={loading}
          title="抓取 14 个源 → 去重 → 评分 → 生成日报（约 20–40 秒）"
          className="rounded-md bg-[var(--color-brand)] px-3.5 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-[var(--color-brand-hover)] disabled:opacity-50"
        >
          {loading ? "刷新中（抓取+评分+日报）…" : "刷新"}
        </button>
      </section>

      {notice && (
        <p className="mb-4 rounded-md border border-[var(--color-brand-line)] bg-[var(--color-brand-soft)] px-3 py-2 text-[13px] text-[var(--color-brand)]">
          {notice}
        </p>
      )}

      {error && (
        <p className="mb-4 rounded-md border border-[var(--color-err-line)] bg-[var(--color-err-soft)] px-3 py-2 text-[13px] text-[var(--color-err)]">
          {error}
        </p>
      )}

      {needToken && (
        <p className="mb-4 rounded-md border border-[var(--color-warn-line)] bg-[var(--color-warn-soft)] px-3 py-2 text-[13px] text-[var(--color-warn)]">
          本站已启用访问令牌：请在上方输入令牌后点「刷新」（或按回车）。令牌只保存在你的浏览器本地。
        </p>
      )}

      {/* ── 页签 ── */}
      <nav className="mb-5 flex gap-1 border-b border-[var(--color-line)]">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-[13px] transition-colors ${
              tab === t.id
                ? "border-[var(--color-brand)] font-medium text-[var(--color-brand)]"
                : "border-transparent text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
            }`}
          >
            {t.label}
            {t.badge ? (
              <span className="ml-1.5 text-[11px] tabular-nums text-[var(--color-ink-3)]">
                {t.badge}
              </span>
            ) : null}
          </button>
        ))}
      </nav>

      {/* ── 日报 ── */}
      {tab === "digest" && (
        <section>
          {digestList.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-1.5">
              {digestList.map((d) => (
                <button
                  key={d.date}
                  type="button"
                  onClick={() => void openDigest(d.date)}
                  className={`rounded-full border px-2.5 py-[3px] text-[12px] transition-colors ${
                    digestDate === d.date
                      ? "border-[var(--color-brand-line)] bg-[var(--color-brand-soft)] font-medium text-[var(--color-brand)]"
                      : "border-[var(--color-line)] text-[var(--color-ink-2)] hover:bg-[var(--color-hover)]"
                  }`}
                >
                  {d.date}（{d.selected} 条）
                </button>
              ))}
            </div>
          )}
          {digest?.digest ? (
            <article className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-sm)]">
              <div className="doc">{renderMarkdown(digest.digest.markdown)}</div>
            </article>
          ) : (
            <div className="rounded-lg border border-dashed border-[var(--color-line-strong)] bg-[var(--color-surface)] px-4 py-12 text-center text-[13px] text-[var(--color-ink-3)]">
              {digest?.message ?? "还没有生成过日报（每天 00:30 UTC 自动生成）。"}
            </div>
          )}
        </section>
      )}

      {/* ── 精选 ── */}
      {tab === "top" && (
        <section>
          {top && (
            <div className="mb-4 rounded-lg border border-[var(--color-line)] bg-[var(--color-inset)] px-3.5 py-2.5 text-[12px] leading-5 text-[var(--color-ink-2)]">
              <span className="font-medium text-[var(--color-ink)]">入选阈值 </span>
              <span className="score-badge text-[var(--color-warn)]">{top.threshold}</span>
              <span className="text-[var(--color-ink-3)]">
                {" "}
                · 评测集标定：Precision 100% / Recall 77.3%
              </span>
              <div className="mt-0.5 text-[var(--color-ink-3)]">
                四维加权：相关性 0.4 / 新颖性 0.2 / 实用度 0.2 / 权威度 0.2 · 理由可核验，不黑盒
              </div>
            </div>
          )}
          {top && top.items.length > 0 ? (
            <ul className="space-y-2">
              {top.items.map((item) => (
                <li
                  key={item.contentKey}
                  className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-3 transition-colors hover:border-[var(--color-line-strong)]"
                >
                  <div className="flex items-start gap-3">
                    <span className="score-badge mt-[1px] shrink-0 rounded-md border border-[var(--color-brand-line)] bg-[var(--color-brand-soft)] px-2 py-[3px] text-[13px] text-[var(--color-brand)]">
                      {item.total}
                    </span>
                    <div className="min-w-0 flex-1">
                      {safeHref(item.link) ? (
                        <a
                          href={safeHref(item.link)!}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-[14px] font-medium text-[var(--color-ink)] underline-offset-2 transition-colors hover:text-[var(--color-brand)] hover:underline"
                        >
                          {item.title}
                        </a>
                      ) : (
                        <span className="text-[14px] text-[var(--color-ink-3)]">
                          {item.title}（链接不安全，已禁用）
                        </span>
                      )}
                      <p className="mt-1 text-[12px] leading-5 text-[var(--color-ink-3)]">
                        <span className="font-medium text-[var(--color-ink-2)]">{item.sourceId}</span>
                        {item.publishedAt ? ` · ${fmtEpoch(item.publishedAt)}` : ""}
                        {item.reason ? ` · ${item.reason}` : ""}
                      </p>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="rounded-lg border border-dashed border-[var(--color-line-strong)] bg-[var(--color-surface)] px-4 py-12 text-center text-[13px] text-[var(--color-ink-3)]">
              还没有达到阈值的条目（评分队列可能仍在跑）。
            </div>
          )}
        </section>
      )}

      {/* ── 历史 ── */}
      {tab === "history" && (
        <section>
          <p className="mb-3 text-[12px] text-[var(--color-ink-3)]">
            已入库条目（跨请求去重后）· 按发布时间倒序 · 只读库、不触网
          </p>
          {items && items.items.length > 0 ? (
            <div className="overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] shadow-[var(--shadow-sm)]">
              <ul className="divide-y divide-[var(--color-line)]">
                {items.items.map((item) => (
                  <li key={item.contentKey} className="px-3.5 py-2.5 transition-colors hover:bg-[var(--color-hover)]">
                    {safeHref(item.link) ? (
                      <a
                        href={safeHref(item.link)!}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-[13.5px] font-medium text-[var(--color-ink)] underline-offset-2 transition-colors hover:text-[var(--color-brand)] hover:underline"
                      >
                        {item.title}
                      </a>
                    ) : (
                      <span className="text-[13.5px] text-[var(--color-ink-3)]">
                        {item.title}（链接不安全，已禁用）
                      </span>
                    )}
                    <p className="mt-0.5 text-[12px] text-[var(--color-ink-3)]">
                      <span className="font-medium text-[var(--color-ink-2)]">{item.sourceId}</span>
                      {" · "}
                      发布 {fmtEpoch(item.publishedAt)} · 首见 {fmtEpoch(item.firstSeenAt)} · 最近见{" "}
                      {fmtEpoch(item.lastSeenAt)}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-[var(--color-line-strong)] bg-[var(--color-surface)] px-4 py-12 text-center text-[13px] text-[var(--color-ink-3)]">
              库里还没有条目。
            </div>
          )}
        </section>
      )}

      {/* ── 源健康 ── */}
      {tab === "sources" && (
        <section>
          <p className="mb-3 text-[12px] text-[var(--color-ink-3)]">
            订阅源状态与历史（feed 失效是常态，因此保留历史以便判断「该重试还是该换源」）
          </p>
          {sources && sources.sources.length > 0 ? (
            <div className="overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] shadow-[var(--shadow-sm)]">
              <ul className="divide-y divide-[var(--color-line)]">
                {sources.sources.map((s) => (
                  <li key={s.id} className="px-3.5 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`status-dot mt-[3px] ${LEVEL_DOT[s.lastHealth ?? ""] ?? LEVEL_DOT.ok}`}
                          />
                          <span className="text-[14px] font-medium text-[var(--color-ink)]">{s.name}</span>
                          <span className="rounded border border-[var(--color-line)] px-1 text-[10px] uppercase text-[var(--color-ink-3)]">
                            {s.lang}
                          </span>
                          {!s.verified && (
                            <span className="rounded border border-[var(--color-warn-line)] bg-[var(--color-warn-soft)] px-1.5 py-[1px] text-[10px] text-[var(--color-warn)]">
                              待 M0 实测
                            </span>
                          )}
                          {s.consecutiveFailures > 1 && (
                            <span className="rounded border border-[var(--color-err-line)] bg-[var(--color-err-soft)] px-1.5 py-[1px] text-[10px] text-[var(--color-err)]">
                              连续失败 {s.consecutiveFailures} 次
                            </span>
                          )}
                        </div>
                        {safeHref(s.url) ? (
                          <a
                            href={safeHref(s.url)!}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="mt-1 block truncate text-[12px] text-[var(--color-ink-3)] underline-offset-2 transition-colors hover:text-[var(--color-ink-2)] hover:underline"
                          >
                            {s.url}
                          </a>
                        ) : (
                          <span className="mt-1 block truncate text-[12px] text-[var(--color-ink-3)]">
                            {s.url}
                          </span>
                        )}
                        <p className="mt-0.5 text-[12px] text-[var(--color-ink-3)]">
                          最近检查 {fmtEpoch(s.lastCheckedAt)} · 条目 {s.lastItemCount}
                          {s.baselineCount ? ` / 基线 ${s.baselineCount}` : ""}
                          {s.lastError ? ` · 错误 ${s.lastError}` : ""}
                        </p>
                      </div>
                      <span
                        className={`shrink-0 rounded-full border px-2 py-[2px] text-[11px] ${
                          LEVEL_STYLE[s.lastHealth ?? ""] ?? LEVEL_STYLE.ok
                        }`}
                      >
                        {levelText(s.lastHealth)}
                      </span>
                    </div>

                    {s.history.length > 0 && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-[12px] text-[var(--color-ink-3)] transition-colors hover:text-[var(--color-ink-2)]">
                          抓取历史（最近 {s.history.length} 次）
                        </summary>
                        <ul className="mt-1.5 space-y-1">
                          {s.history.map((h, i) => (
                            <li
                              key={i}
                              className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-[var(--color-ink-3)]"
                            >
                              <span
                                className={`status-dot ${
                                  h.level === "ok"
                                    ? LEVEL_DOT.ok
                                    : h.level === "degraded"
                                      ? LEVEL_DOT.degraded
                                      : LEVEL_DOT.broken
                                }`}
                              />
                              <span className="w-[7.5rem] shrink-0 tabular-nums">
                                {fmtEpoch(h.checkedAt)}
                              </span>
                              <span className="w-[7rem] shrink-0">{levelText(h.level)}</span>
                              <span className="w-[4.5rem] shrink-0">条目 {h.itemCount}</span>
                              {h.elapsedMs != null && (
                                <span className="w-[4.5rem] shrink-0 tabular-nums">{h.elapsedMs}ms</span>
                              )}
                              {h.error && (
                                <span className="font-mono text-[var(--color-err)]">{h.error}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-[var(--color-line-strong)] bg-[var(--color-surface)] px-4 py-12 text-center text-[13px] text-[var(--color-ink-3)]">
              {sources?.message ?? "还没有源状态（先点刷新抓一次）。"}
            </div>
          )}
        </section>
      )}
    </main>
  );
}
