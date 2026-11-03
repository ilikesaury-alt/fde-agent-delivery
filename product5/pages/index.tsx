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
 */

import { useCallback, useEffect, useMemo, useState } from "react";

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

const LEVEL_STYLE: Record<string, string> = {
  ok: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  degraded: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  broken: "bg-rose-500/15 text-rose-300 border-rose-500/30",
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
   注意：所有文本都经过 React 转义（不用 dangerouslySetInnerHTML），链接 href 走白名单校验。 */

function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  // 依次处理 **[粗体链接](url)** 与 [链接](url)
  const nodes: React.ReactNode[] = [];
  const re = /(\*\*)?\[([^\]]+)\]\(([^)]+)\)(\*\*)?/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const href = safeHref(m[3] ?? "");
    const bold = Boolean(m[1] && m[4]);
    const inner = m[2] ?? "";
    nodes.push(
      href ? (
        <a
          key={`${keyPrefix}-a${i}`}
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className={bold ? "font-semibold text-sky-300 hover:underline" : "text-sky-300 hover:underline"}
        >
          {inner}
        </a>
      ) : (
        <span key={`${keyPrefix}-t${i}`} className="text-slate-400">
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

function renderMarkdown(md: string): React.ReactNode {
  const lines = md.split("\n");
  const out: React.ReactNode[] = [];
  let list: string[] = [];
  let inCode = false;

  const flushList = (key: string) => {
    if (list.length === 0) return;
    out.push(
      <ul key={key} className="my-1 list-disc space-y-1 pl-5">
        {list.map((li, idx) => (
          <li key={idx} className="text-sm leading-relaxed text-slate-300">
            {renderInline(li, `${key}-${idx}`)}
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
        <pre key={key} className="my-1 overflow-auto rounded bg-slate-900/80 px-2 py-1 text-xs text-slate-400">
          {line}
        </pre>,
      );
      return;
    }

    if (line.startsWith("# ")) {
      flushList(`${key}-h1`);
      out.push(
        <h1 key={key} className="mb-2 text-lg font-semibold text-slate-100">
          {renderInline(line.slice(2), key)}
        </h1>,
      );
      return;
    }
    if (line.startsWith("## ")) {
      flushList(`${key}-h2`);
      out.push(
        <h2 key={key} className="mt-4 mb-1 border-b border-slate-800 pb-1 text-sm font-semibold text-emerald-300">
          {renderInline(line.slice(3), key)}
        </h2>,
      );
      return;
    }
    if (line.startsWith("> ")) {
      flushList(`${key}-q`);
      out.push(
        <p key={key} className="my-1 rounded border-l-2 border-amber-500/50 bg-amber-500/5 px-2 py-1 text-xs text-amber-200">
          {renderInline(line.slice(2), key)}
        </p>,
      );
      return;
    }
    if (line.startsWith("- ")) {
      list.push(line.slice(2));
      return;
    }
    if (line.trim() === "") {
      flushList(`${key}-blank`);
      return;
    }
    // 其它（正文行）
    flushList(`${key}-p`);
    out.push(
      <p key={key} className="my-0.5 text-sm leading-relaxed text-slate-300">
        {renderInline(line, key)}
      </p>,
    );
  });
  flushList("l-end");
  return out;
}

/* ────────────────────── 页面 ────────────────────── */

export default function IndexPage() {
  const [token, setToken] = useState("");
  const [tab, setTab] = useState<Tab>("digest");
  const [feed, setFeed] = useState<FeedResponse | null>(null);
  const [top, setTop] = useState<TopResponse | null>(null);
  const [digest, setDigest] = useState<DigestResponse | null>(null);
  const [digestList, setDigestList] = useState<NonNullable<DigestResponse["list"]>>([]);
  const [digestDate, setDigestDate] = useState<string | null>(null);
  const [items, setItems] = useState<ItemsResponse | null>(null);
  const [sources, setSources] = useState<SourcesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const saved = typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null;
    if (saved) setToken(saved);
  }, []);

  const authHeaders = useCallback(
    (tk: string): Record<string, string> => (tk ? { authorization: `Bearer ${tk}` } : {}),
    [],
  );

  const loadFeed = useCallback(
    async (tk: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/feed", { headers: authHeaders(tk) });
        const body = (await res.json()) as FeedResponse & { error?: string };
        if (!res.ok) {
          setError(body.error ?? `请求失败（HTTP ${res.status}）`);
          setFeed(null);
          return;
        }
        setFeed(body);
      } catch {
        setError("网络异常，请稍后重试。");
        setFeed(null);
      } finally {
        setLoading(false);
      }
    },
    [authHeaders],
  );

  const loadReadonly = useCallback(
    async (tk: string) => {
      const h = authHeaders(tk);
      const [topRes, digestRes, itemsRes, sourcesRes] = await Promise.all([
        fetch("/api/top?limit=30", { headers: h })
          .then((r) => r.json() as Promise<TopResponse>)
          .catch(() => null),
        fetch("/api/digest", { headers: h })
          .then((r) => r.json() as Promise<DigestResponse>)
          .catch(() => null),
        fetch("/api/items?limit=60", { headers: h })
          .then((r) => r.json() as Promise<ItemsResponse>)
          .catch(() => null),
        fetch("/api/sources?history=20", { headers: h })
          .then((r) => r.json() as Promise<SourcesResponse>)
          .catch(() => null),
      ]);
      if (topRes) setTop(topRes);
      if (digestRes) setDigest(digestRes);
      if (itemsRes) setItems(itemsRes);
      if (sourcesRes) setSources(sourcesRes);
    },
    [authHeaders],
  );

  const loadDigestList = useCallback(
    async (tk: string) => {
      const res = await fetch("/api/digest?list=1", { headers: authHeaders(tk) })
        .then((r) => r.json() as Promise<DigestResponse>)
        .catch(() => null);
      if (res) setDigestList(res.list ?? []);
    },
    [authHeaders],
  );

  useEffect(() => {
    void loadFeed(token);
    void loadReadonly(token);
    void loadDigestList(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshAll = () => {
    void loadFeed(token);
    void loadReadonly(token);
    void loadDigestList(token);
  };

  const openDigest = async (date: string) => {
    const res = await fetch(`/api/digest?date=${date}`, { headers: authHeaders(token) })
      .then((r) => r.json() as Promise<DigestResponse>)
      .catch(() => null);
    if (res?.digest) {
      setDigest(res);
      setDigestDate(date);
    }
  };

  const tabs = useMemo(
    () =>
      [
        { id: "digest" as const, label: "日报", badge: digest?.digest?.date },
        { id: "top" as const, label: "精选", badge: top ? `${top.count}` : undefined },
        { id: "history" as const, label: "历史", badge: items ? `${items.count}` : undefined },
        { id: "sources" as const, label: "源健康", badge: sources ? `${sources.sources.length}` : undefined },
      ] as Array<{ id: Tab; label: string; badge?: string }>,
    [digest, top, items, sources],
  );

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 text-slate-100">
      <header className="mb-5">
        <h1 className="text-2xl font-semibold tracking-tight">AI 资讯雷达</h1>
        <p className="mt-1 text-sm text-slate-400">
          定时聚合多源 AI 资讯 → 评分精选 → 每日日报。阈值由评测集标定，源健康全程可见。
        </p>
      </header>

      {/* 控制条 */}
      <section className="mb-5 flex flex-wrap items-center gap-2">
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="访问令牌（未配置 ACCESS_TOKEN 可留空）"
          className="min-w-[15rem] flex-1 rounded border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm"
        />
        <button
          type="button"
          onClick={refreshAll}
          disabled={loading}
          className="rounded bg-indigo-600 px-3 py-1.5 text-sm hover:bg-indigo-500 disabled:opacity-50"
        >
          {loading ? "抓取中…" : "刷新"}
        </button>
        <span className="text-xs text-slate-500">
          {feed
            ? `上次抓取 ${fmtTime(feed.fetchedAt)} · ${feed.counts.fetched} 条 / 去重后 ${feed.counts.kept} · ${feed.elapsedMs}ms`
            : "尚未抓取"}
        </span>
      </section>

      {error && (
        <p className="mb-4 rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          {error}
        </p>
      )}

      {/* 页签 */}
      <nav className="mb-5 flex gap-1 border-b border-slate-800">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded-t px-3 py-1.5 text-sm transition ${
              tab === t.id
                ? "border-b-2 border-emerald-400 text-emerald-300"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {t.label}
            {t.badge ? <span className="ml-1 text-xs text-slate-500">{t.badge}</span> : null}
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
                  className={`rounded border px-2 py-0.5 text-xs ${
                    digestDate === d.date
                      ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-200"
                      : "border-slate-700 text-slate-400 hover:border-slate-500"
                  }`}
                >
                  {d.date}（{d.selected} 条）
                </button>
              ))}
            </div>
          )}
          {digest?.digest ? (
            <article className="rounded border border-slate-800 bg-slate-900/30 px-4 py-3">
              {renderMarkdown(digest.digest.markdown)}
            </article>
          ) : (
            <p className="text-sm text-slate-500">
              {digest?.message ?? "还没有生成过日报（每天 00:30 UTC 自动生成）。"}
            </p>
          )}
        </section>
      )}

      {/* ── 精选 ── */}
      {tab === "top" && (
        <section>
          {top && (
            <p className="mb-3 text-xs text-slate-500">
              阈值 <span className="text-amber-300">{top.threshold}</span>（评测集标定：Precision 100% / Recall
              77.3%）· 四维加权：相关性 0.4 / 新颖性 0.2 / 实用度 0.2 / 权威度 0.2 · 理由可核验，不黑盒
            </p>
          )}
          {top && top.items.length > 0 ? (
            <ul className="space-y-2">
              {top.items.map((item) => (
                <li
                  key={item.contentKey}
                  className="rounded border border-amber-500/30 bg-amber-500/5 px-3 py-2"
                >
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 shrink-0 rounded bg-amber-500/20 px-1.5 py-0.5 text-xs font-mono text-amber-200">
                      {item.total}
                    </span>
                    <div className="min-w-0">
                      {safeHref(item.link) ? (
                        <a
                          href={safeHref(item.link)!}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-sm text-sky-300 hover:underline"
                        >
                          {item.title}
                        </a>
                      ) : (
                        <span className="text-sm text-slate-400">{item.title}（链接不安全，已禁用）</span>
                      )}
                      <p className="mt-0.5 text-xs text-slate-400">
                        {item.sourceId}
                        {item.publishedAt ? ` · ${fmtEpoch(item.publishedAt)}` : ""}
                        {item.reason ? ` · ${item.reason}` : ""}
                      </p>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">还没有达到阈值的条目（评分队列可能仍在跑）。</p>
          )}
        </section>
      )}

      {/* ── 历史 ── */}
      {tab === "history" && (
        <section>
          <p className="mb-3 text-xs text-slate-500">
            已入库条目（跨请求去重后）· 按发布时间倒序 · 只读库、不触网
          </p>
          {items && items.items.length > 0 ? (
            <ul className="space-y-1.5">
              {items.items.map((item) => (
                <li key={item.contentKey} className="rounded border border-slate-800 bg-slate-900/30 px-3 py-2">
                  {safeHref(item.link) ? (
                    <a
                      href={safeHref(item.link)!}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-sm text-sky-300 hover:underline"
                    >
                      {item.title}
                    </a>
                  ) : (
                    <span className="text-sm text-slate-400">{item.title}（链接不安全，已禁用）</span>
                  )}
                  <p className="mt-0.5 text-xs text-slate-500">
                    {item.sourceId} · 发布 {fmtEpoch(item.publishedAt)} · 首见{" "}
                    {fmtEpoch(item.firstSeenAt)} · 最近见 {fmtEpoch(item.lastSeenAt)}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">库里还没有条目。</p>
          )}
        </section>
      )}

      {/* ── 源健康 ── */}
      {tab === "sources" && (
        <section>
          <p className="mb-3 text-xs text-slate-500">
            订阅源状态与历史（feed 失效是常态，因此保留历史以便判断「该重试还是该换源」）
          </p>
          {sources && sources.sources.length > 0 ? (
            <ul className="space-y-2">
              {sources.sources.map((s) => (
                <li key={s.id} className="rounded border border-slate-800 bg-slate-900/30 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm">{s.name}</span>
                        <span className="rounded border border-slate-600 px-1 text-[10px] uppercase text-slate-400">
                          {s.lang}
                        </span>
                        {!s.verified && (
                          <span className="rounded border border-amber-600/40 bg-amber-500/10 px-1 text-[10px] text-amber-300">
                            待 M0 实测
                          </span>
                        )}
                        {s.consecutiveFailures > 1 && (
                          <span className="rounded border border-rose-600/40 bg-rose-500/10 px-1 text-[10px] text-rose-300">
                            连续失败 {s.consecutiveFailures} 次
                          </span>
                        )}
                      </div>
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="block truncate text-xs text-slate-500 hover:text-slate-300"
                      >
                        {s.url}
                      </a>
                      <p className="mt-0.5 text-xs text-slate-500">
                        最近检查 {fmtEpoch(s.lastCheckedAt)} · 条目 {s.lastItemCount}
                        {s.baselineCount ? ` / 基线 ${s.baselineCount}` : ""}
                        {s.lastError ? ` · 错误 ${s.lastError}` : ""}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 rounded border px-2 py-0.5 text-xs ${
                        LEVEL_STYLE[s.lastHealth ?? ""] ?? LEVEL_STYLE.ok
                      }`}
                    >
                      {levelText(s.lastHealth)}
                    </span>
                  </div>

                  {s.history.length > 0 && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-slate-500">
                        抓取历史（最近 {s.history.length} 次）
                      </summary>
                      <ul className="mt-1 space-y-0.5">
                        {s.history.map((h, i) => (
                          <li key={i} className="flex items-center gap-2 text-xs text-slate-500">
                            <span
                              className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                                h.level === "ok"
                                  ? "bg-emerald-400"
                                  : h.level === "degraded"
                                    ? "bg-amber-400"
                                    : "bg-rose-400"
                              }`}
                            />
                            <span className="w-40 shrink-0">{fmtEpoch(h.checkedAt)}</span>
                            <span className="w-16 shrink-0">{levelText(h.level)}</span>
                            <span className="w-20 shrink-0">条目 {h.itemCount}</span>
                            {h.elapsedMs != null && <span className="w-20 shrink-0">{h.elapsedMs}ms</span>}
                            {h.error && <span className="font-mono text-rose-300">{h.error}</span>}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">
              {sources?.message ?? "还没有源状态（先点刷新抓一次）。"}
            </p>
          )}
        </section>
      )}
    </main>
  );
}