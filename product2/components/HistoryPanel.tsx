"use client";

/**
 * 历史记录面板：列表（时间/来源/标题）→ 展开回看 → 删除 / 重新生成。
 * 数据来自 /api/jobs（列表不带全文，回看单条时再取）。
 */

import { useCallback, useEffect, useState } from "react";

import { CopyButton } from "./CopyButton.tsx";
import { renderNoteText } from "../lib/note.ts";
import type { GenerationJob } from "../lib/types.ts";

type SlimJob = Omit<GenerationJob, "sourceText" | "materialBrief">;

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function HistoryPanel({
  token,
  tokenReady = true,
  version,
  onReuse,
  onOpen,
  onAuthRequired,
}: {
  token: string;
  /** token 是否已从本地存储恢复；未恢复前不发请求（否则首帧会吃 401 并闪错误） */
  tokenReady?: boolean;
  /** 每次生成成功后自增，触发重新拉列表 */
  version: number;
  onReuse: (job: GenerationJob) => void;
  onOpen: (job: GenerationJob) => void;
  /** 鉴权失败时通知父级：把用户引到顶部令牌输入框，而不是让他在历史区里查错 */
  onAuthRequired?: () => void;
}) {
  const [jobs, setJobs] = useState<SlimJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<GenerationJob | null>(null);

  const authHeaders = useCallback(
    (): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {}),
    [token],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setAuthRequired(false);
    try {
      const resp = await fetch("/api/jobs", { headers: authHeaders() });
      if (resp.status === 401) {
        // 401 不代表「历史功能坏了」，而是「没填/填错令牌」。
        // 这里只标记状态，真正的提示交给父级在顶部输入框旁边显示——
        // 否则用户会在历史区里找问题（实测自己被误导过去查 Cloudflare secret）。
        setAuthRequired(true);
        setJobs([]);
        onAuthRequired?.();
        return;
      }
      if (!resp.ok) {
        const data = (await resp.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "加载历史失败。");
        setJobs([]);
        return;
      }
      const data = (await resp.json()) as { jobs?: SlimJob[] };
      setJobs(data.jobs ?? []);
    } catch {
      setError("网络异常，未能加载历史记录。");
    } finally {
      setLoading(false);
    }
  }, [authHeaders]);

  useEffect(() => {
    if (!tokenReady) return;
    void load();
  }, [load, version, tokenReady]);

  const openDetail = async (id: string) => {
    if (expanded === id) {
      setExpanded(null);
      setDetail(null);
      return;
    }
    setExpanded(id);
    setDetail(null);
    try {
      const resp = await fetch(`/api/jobs?id=${encodeURIComponent(id)}`, { headers: authHeaders() });
      if (!resp.ok) return;
      const data = (await resp.json()) as { job?: GenerationJob };
      setDetail(data.job ?? null);
    } catch {
      /* 忽略：列表仍可操作 */
    }
  };

  /** 重新生成需要原文素材（列表接口不带），先取单条详情再交给父级 */
  const reuse = async (job: SlimJob) => {
    if (detail?.id === job.id && detail.sourceText) {
      onReuse(detail);
      return;
    }
    try {
      const resp = await fetch(`/api/jobs?id=${encodeURIComponent(job.id)}`, { headers: authHeaders() });
      if (!resp.ok) {
        setError("读取原始素材失败，无法重新生成。");
        return;
      }
      const data = (await resp.json()) as { job?: GenerationJob };
      if (!data.job) return;
      setDetail(data.job);
      setExpanded(job.id);
      onReuse(data.job);
    } catch {
      setError("网络异常，未能读取原始素材。");
    }
  };

  const remove = async (id: string) => {
    try {
      const resp = await fetch(`/api/jobs?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (resp.ok) {
        setJobs((prev) => prev.filter((j) => j.id !== id));
        if (expanded === id) {
          setExpanded(null);
          setDetail(null);
        }
      }
    } catch {
      setError("删除失败，请稍后重试。");
    }
  };

  return (
    <section className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] shadow-[var(--shadow-sm)]">
      <header className="flex items-center justify-between border-b border-[var(--color-line)] px-4 py-2.5">
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">
          历史记录 <span className="ml-1 text-xs font-normal text-[var(--color-ink-3)]">{jobs.length}</span>
        </h2>
        <button
          type="button"
          onClick={() => void load()}
          className="text-xs text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
        >
          刷新
        </button>
      </header>

      {error && (
        <p className="border-b border-[var(--color-line)] bg-[var(--color-err-soft)] px-4 py-2 text-xs text-[var(--color-err)]">
          {error}
        </p>
      )}

      {loading && jobs.length === 0 ? (
        <div className="space-y-2 px-4 py-3">
          <div className="sk-line w-2/3" />
          <div className="sk-line w-1/2" />
        </div>
      ) : authRequired ? (
        <p className="px-4 py-6 text-center text-xs text-[var(--color-ink-3)]">
          需要访问令牌才能读取历史（见上方输入框）。
        </p>
      ) : jobs.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-[var(--color-ink-3)]">
          还没有记录。生成第一篇笔记后会自动保存在这里。
        </p>
      ) : (
        <ul className="divide-y divide-[var(--color-line)]">
          {jobs.map((job) => {
            const title = job.note?.titles?.[0] ?? job.sourceExcerpt;
            const isOpen = expanded === job.id;
            return (
              <li key={job.id} className="px-4 py-2.5">
                <div className="flex items-start gap-2">
                  <button
                    type="button"
                    onClick={() => void openDetail(job.id)}
                    className="flex-1 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] tabular-nums text-[var(--color-ink-3)]">
                        {fmtTime(job.createdAt)}
                      </span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] ${
                          job.sourceType === "url"
                            ? "bg-[var(--color-brand-soft)] text-[var(--color-brand)]"
                            : "bg-[var(--color-inset)] text-[var(--color-ink-2)]"
                        }`}
                      >
                        {job.sourceType === "url" ? "链接" : "文本"}
                      </span>
                      {job.status === "failed" && (
                        <span className="rounded bg-[var(--color-err-soft)] px-1.5 py-0.5 text-[10px] text-[var(--color-err)]">
                          失败
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 line-clamp-1 text-sm text-[var(--color-ink)]">{title}</p>
                  </button>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {job.note && (
                      <>
                        <CopyButton
                          text={renderNoteText(job.note)}
                          label="复制"
                        />
                        <button
                          type="button"
                          onClick={() => void reuse(job)}
                          className="rounded-md border border-[var(--color-line-strong)] px-2 py-1 text-xs text-[var(--color-ink-2)] hover:bg-[var(--color-hover)]"
                          title="用原素材重新生成一版"
                        >
                          重新生成
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => void remove(job.id)}
                      className="rounded-md px-1.5 py-1 text-xs text-[var(--color-ink-3)] hover:bg-[var(--color-err-soft)] hover:text-[var(--color-err)]"
                      aria-label="删除这条记录"
                    >
                      删除
                    </button>
                  </div>
                </div>

                {isOpen && (
                  <div className="mt-2 rounded-md bg-[var(--color-inset)] px-3 py-2">
                    {!detail ? (
                      <p className="text-xs text-[var(--color-ink-3)]">加载中…</p>
                    ) : (
                      <>
                        <p className="mb-1 text-[11px] text-[var(--color-ink-3)]">
                          素材：{detail.sourceText.slice(0, 120)}
                          {detail.sourceText.length > 120 ? "…" : ""}
                        </p>
                        {detail.note ? (
                          <>
                            <p className="title-candidate mt-2 text-[var(--color-ink)]">
                              {detail.note.titles[0]}
                            </p>
                            <p className="note-body mt-1 text-[13px]">{detail.note.body}</p>
                            <p className="mt-1 text-xs text-[var(--color-brand)]">
                              {detail.note.tags.map((t) => `#${t}`).join(" ")}
                            </p>
                            <div className="mt-2 flex gap-1.5">
                              <button
                                type="button"
                                onClick={() => onOpen(detail)}
                                className="rounded-md border border-[var(--color-line-strong)] px-2 py-1 text-xs text-[var(--color-ink-2)] hover:bg-[var(--color-hover)]"
                              >
                                载入到工作台
                              </button>
                            </div>
                          </>
                        ) : (
                          <p className="text-xs text-[var(--color-err)]">
                            生成失败：{detail.error ?? "未知原因"}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
