/**
 * 首页 — AI 资讯雷达（增量 3：抓取 + 去重 + 源健康 + **精选**）
 *
 * 评分/日报在增量 3/4 接；本页已展示「精选」与每条评分理由（可核验，不黑盒）。
 * 设计纪律：
 *  - **不掩盖失败**：坏源显式列出（名称 + 错误分类 + 面向用户文案），不静默吞掉
 *  - **不假装已验证**：源标注「待 M0 实测」的徽标，确认后才可信（CONTEXT D4）
 *  - **不猜**：日期缺失显示「—」，不填当前时间
 */

import { useCallback, useEffect, useState } from "react";

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

type TopResponse = { storage: string; threshold: number; count: number; items: RankedItem[] };

type FeedResponse = {
  fetchedAt: string;
  elapsedMs: number;
  budget: { sources: number; maxItemsPerSource: number; timeoutMs: number };
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

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("zh-CN", { hour12: false });
}

const LEVEL_STYLE: Record<Health["level"], string> = {
  ok: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  degraded: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  broken: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

const LEVEL_TEXT: Record<Health["level"], string> = {
  ok: "正常",
  degraded: "异常（条目骤降）",
  broken: "不可用",
};

export default function IndexPage() {
  const [token, setToken] = useState("");
  const [data, setData] = useState<FeedResponse | null>(null);
  const [top, setTop] = useState<TopResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const saved = typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null;
    if (saved) setToken(saved);
  }, []);

  const load = useCallback(async (tk: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/feed", {
        headers: tk ? { authorization: `Bearer ${tk}` } : {},
      });
      const body = (await res.json()) as FeedResponse & { error?: string };
      if (!res.ok) {
        setError(body.error ?? `请求失败（HTTP ${res.status}）`);
        setData(null);
        return;
      }
      setData(body);
      // 精选只读库、不触网：与抓取并行拉，互不阻塞
      void fetch("/api/top?limit=12", { headers: tk ? { authorization: `Bearer ${tk}` } : {} })
        .then((r) => r.json() as Promise<TopResponse>)
        .then((t) => setTop(t))
        .catch(() => setTop(null));
    } catch {
      setError("网络异常，请稍后重试。");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(token);
    // 首次进入自动抓一次；token 变化由按钮触发，避免每次输入都打源站
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveToken = () => {
    if (typeof localStorage !== "undefined") {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    }
    void load(token);
  };

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 text-slate-100">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">AI 资讯雷达</h1>
        <p className="mt-1 text-sm text-slate-400">
          定时聚合多源 AI 资讯 → 评分精选 → 每日日报。
          <span className="ml-2 rounded border border-slate-600 px-1.5 py-0.5 text-xs text-slate-400">
            增量 1：抓取 / 去重 / 源健康（评分与日报未接）
          </span>
        </p>
      </header>

      <section className="mb-5 flex flex-wrap items-center gap-2">
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="访问令牌（未配置 ACCESS_TOKEN 可留空）"
          className="min-w-[16rem] flex-1 rounded border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm"
        />
        <button
          type="button"
          onClick={saveToken}
          className="rounded bg-slate-700 px-3 py-1.5 text-sm hover:bg-slate-600"
        >
          保存并刷新
        </button>
        <button
          type="button"
          onClick={() => void load(token)}
          disabled={loading}
          className="rounded bg-indigo-600 px-3 py-1.5 text-sm hover:bg-indigo-500 disabled:opacity-50"
        >
          {loading ? "抓取中…" : "重新抓取"}
        </button>
      </section>

      {error && (
        <p className="mb-4 rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          {error}
        </p>
      )}

      {data && (
        <>
          <section className="mb-4 rounded border border-slate-700 bg-slate-900/60 px-3 py-2 text-xs text-slate-400">
            抓取于 {fmtTime(data.fetchedAt)} · 耗时 {data.elapsedMs}ms ·
            源 {data.budget.sources} 个（单源上限 {data.budget.maxItemsPerSource} 条 / 超时{" "}
            {data.budget.timeoutMs}ms）· 抓到 {data.counts.fetched} 条 · 去重后{" "}
            {data.counts.kept} 条（重复 {data.counts.deduped}）
          </section>

          <section className="mb-6">
            <h2 className="mb-2 text-sm font-medium text-slate-300">订阅源健康</h2>
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {data.sources.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between gap-2 rounded border border-slate-700/70 bg-slate-900/40 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm">{s.name}</span>
                      <span className="rounded border border-slate-600 px-1 text-[10px] uppercase text-slate-400">
                        {s.lang}
                      </span>
                      {!s.verified && (
                        <span className="rounded border border-amber-600/40 bg-amber-500/10 px-1 text-[10px] text-amber-300">
                          待 M0 实测
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
                  </div>
                  <span
                    className={`shrink-0 rounded border px-2 py-0.5 text-xs ${LEVEL_STYLE[s.health.level]}`}
                  >
                    {LEVEL_TEXT[s.health.level]} · {s.health.itemCount}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          {data.failures.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-2 text-sm font-medium text-rose-300">
                失败明细（{data.failures.length}）
              </h2>
              <ul className="space-y-1 text-xs text-slate-400">
                {data.failures.map((f) => (
                  <li key={f.sourceId} className="rounded bg-slate-900/40 px-3 py-1.5">
                    <span className="text-slate-300">{f.sourceId}</span>
                    <span className="mx-1 text-slate-500">·</span>
                    <span className="font-mono text-rose-300">{f.error}</span>
                    {f.status ? <span className="ml-1 text-slate-500">HTTP {f.status}</span> : null}
                    <span className="ml-2">{f.message}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {top && top.items.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-1 text-sm font-medium text-amber-300">
                精选（阈值 {top.threshold} · {top.count} 条）
              </h2>
              <p className="mb-2 text-xs text-slate-500">
                分数由 AI 按「相关性 / 新颖性 / 实用度 / 权威度」四维加权，阈值经评测集标定
                （Precision 100% / Recall 77.3%，见 eval/report.md）。理由可核验，不黑盒。
              </p>
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
                        <a
                          href={item.link}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-sm text-sky-300 hover:underline"
                        >
                          {item.title}
                        </a>
                        <p className="mt-0.5 text-xs text-slate-400">
                          {item.sourceId}
                          {item.publishedAt ? ` · ${fmtTime(new Date(item.publishedAt).toISOString())}` : ""}
                          {item.reason ? ` · ${item.reason}` : ""}
                        </p>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h2 className="mb-2 text-sm font-medium text-slate-300">
              最新条目（{data.items.length}）
            </h2>
            {data.items.length === 0 ? (
              <p className="text-sm text-slate-500">没有抓到条目。</p>
            ) : (
              <ul className="space-y-2">
                {data.items.map((item) => (
                  <li
                    key={`${item.sourceId}:${item.id}`}
                    className="rounded border border-slate-700/70 bg-slate-900/40 px-3 py-2"
                  >
                    <a
                      href={item.link}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-sm text-sky-300 hover:underline"
                    >
                      {item.title}
                    </a>
                    <p className="mt-1 text-xs text-slate-500">
                      {item.sourceId} · {fmtTime(item.publishedAt)}
                    </p>
                    {item.summary && (
                      <p className="mt-1 line-clamp-2 text-xs text-slate-400">{item.summary}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}