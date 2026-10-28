/**
 * 首页 — 知识库问答工作台
 *
 * 左侧：知识库管理（粘贴 / 上传 .md·.txt·.pdf / URL 导入 + 文档列表）
 * 右侧：问答（问题 → 流式回答 + 引用块；依据不足时明确拒答）
 *
 * 设计原则（沿用产品①②）：
 *  - 空输入禁用提交（不是报错）
 *  - 长等待有可见反馈（步骤进度）+ 可取消
 *  - 引用可核验：每条引用给出文档名 + 位置 + 原文片段
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { consumeAskStream, type AskResult, type StepState } from "../lib/client-stream.ts";
import { extractPdfText, PdfExtractError } from "../lib/pdf.ts";

const TOKEN_KEY = "kb_token";

type DocRow = {
  id: string;
  source: string;
  sourceRef: string | null;
  title: string;
  status: string;
  chunkCount: number;
  error: string | null;
  createdAt: number;
};

const SOURCE_LABEL: Record<string, string> = {
  paste: "粘贴",
  file: "文件",
  url: "网页",
  pdf: "PDF",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "待处理",
  indexing: "索引中",
  ready: "已就绪",
  failed: "失败",
};

const STEP_LABEL: Record<string, string> = {
  embed: "问题向量化",
  retrieve: "检索知识库",
  generate: "生成回答",
};

type Tab = "paste" | "file" | "url";

export default function HomePage() {
  const [token, setToken] = useState("");
  const [documents, setDocuments] = useState<DocRow[]>([]);
  const [totalChunks, setTotalChunks] = useState(0);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(false);

  const [tab, setTab] = useState<Tab>("paste");
  const [pasteText, setPasteText] = useState("");
  const [url, setUrl] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileText, setFileText] = useState("");
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<{ kind: "ok" | "warn" | "err"; text: string } | null>(null);
  /**
   * 索引生效倒计时（毫秒时间戳）。
   * Vectorize 的写入是异步的：线上实测导入后 0–40 秒必拒答，第 50 秒才命中。
   * 不给倒计时的话，用户会在“导入成功”后立即提问拿到「未找到依据」，判定成上传失败。
   */
  const [indexingUntil, setIndexingUntil] = useState(0);
  const [indexingLeft, setIndexingLeft] = useState(0);

  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [steps, setSteps] = useState<StepState[]>([]);
  const [streamText, setStreamText] = useState("");
  const [result, setResult] = useState<AskResult | null>(null);
  const [askError, setAskError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // ── 令牌 ────────────────────────────────────────────────────────────
  useEffect(() => {
    const saved = typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null;
    if (saved) setToken(saved);
  }, []);

  const persistToken = (v: string) => {
    setToken(v);
    try {
      if (v) localStorage.setItem(TOKEN_KEY, v);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      // localStorage 不可用（隐私模式）不阻塞使用
    }
  };

  const authHeaders = useCallback((): Record<string, string> => {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (token) h.authorization = `Bearer ${token}`;
    return h;
  }, [token]);

  // ── 文档列表 ────────────────────────────────────────────────────────
  const refreshList = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await fetch("/api/documents", { headers: authHeaders() });
      if (res.status === 401) {
        setListError("需要访问令牌：请在右上角填入令牌后再试。");
        setDocuments([]);
        return;
      }
      if (!res.ok) {
        setListError("读取文档列表失败，请稍后重试。");
        return;
      }
      const body = (await res.json()) as { documents: DocRow[]; totalChunks: number };
      setDocuments(body.documents ?? []);
      setTotalChunks(body.totalChunks ?? 0);
      setListError(null);
    } catch {
      setListError("网络异常，无法读取文档列表。");
    } finally {
      setLoadingList(false);
    }
  }, [authHeaders]);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  // ── 索引倒计时 ────────────────────────────────────────────────────
  useEffect(() => {
    if (!indexingUntil) return;
    const tick = () => setIndexingLeft(Math.max(0, Math.ceil((indexingUntil - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [indexingUntil]);

  // ── 导入 ────────────────────────────────────────────────────────────
  const canImport =
    !importing &&
    ((tab === "paste" && pasteText.trim().length > 0) ||
      (tab === "file" && fileText.trim().length > 0) ||
      (tab === "url" && url.trim().length > 0));

  const doImport = async () => {
    if (!canImport) return;
    setImporting(true);
    setImportMsg(null);
    try {
      const payload =
        tab === "url"
          ? { source: "url", url: url.trim() }
          : tab === "file"
            ? {
                source: fileName.toLowerCase().endsWith(".pdf") ? "pdf" : "file",
                sourceRef: fileName || null,
                title: fileName || undefined,
                text: fileText,
              }
            : { source: "paste", text: pasteText, title: "粘贴的文本" };

      const res = await fetch("/api/documents", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => ({}))) as {
        document?: DocRow;
        skipped?: boolean;
        message?: string;
        error?: string;
      };

      if (res.status === 401) {
        setImportMsg({ kind: "err", text: "访问令牌缺失或错误，请检查右上角令牌。" });
        return;
      }
      if (!res.ok) {
        setImportMsg({ kind: "err", text: body.error ?? "导入失败，请稍后重试。" });
        return;
      }
      if (body.skipped) {
        setImportMsg({ kind: "warn", text: body.message ?? "该文档内容已在库中，已跳过。" });
      } else {
        const chunks = body.document?.chunkCount ?? 0;
        setImportMsg({
          kind: "ok",
          text: `已导入：切分为 ${chunks} 个片段。向量索引写入是异步的，约 1 分钟后才能检索到。`,
        });
        setIndexingUntil(Date.now() + 60_000);
        setPasteText("");
        setUrl("");
        setFileText("");
        setFileName("");
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
      await refreshList();
    } catch {
      setImportMsg({ kind: "err", text: "网络异常，导入失败。" });
    } finally {
      setImporting(false);
    }
  };

  const onPickFile = async (file: File | null) => {
    if (!file) return;
    setFileName(file.name);
    setImportMsg(null);
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".pdf")) {
      try {
        setImporting(true);
        const { text, pages } = await extractPdfText(file);
        setFileText(text);
        setImportMsg({ kind: "ok", text: `已从 PDF 抽取 ${pages} 页文本（${text.length.toLocaleString("zh-CN")} 字），可直接导入。` });
      } catch (e) {
        setFileText("");
        setImportMsg({
          kind: "err",
          text: e instanceof PdfExtractError ? e.message : "PDF 解析失败，请改用粘贴文本方式。",
        });
      } finally {
        setImporting(false);
      }
      return;
    }
    if (!lower.endsWith(".md") && !lower.endsWith(".txt")) {
      setFileText("");
      setImportMsg({ kind: "err", text: "仅支持 .md / .txt / .pdf 文件。" });
      return;
    }
    const text = await file.text();
    if (text.includes("\u0000")) {
      setFileText("");
      setImportMsg({ kind: "err", text: "该文件看起来是二进制文件，请改用文本文件。" });
      return;
    }
    setFileText(text);
  };

  const removeDoc = async (id: string) => {
    try {
      const res = await fetch(`/api/documents?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setImportMsg({ kind: "err", text: body.error ?? "删除失败，请稍后重试。" });
        return;
      }
      setImportMsg({ kind: "ok", text: "已删除文档及其索引向量。" });
      await refreshList();
    } catch {
      setImportMsg({ kind: "err", text: "网络异常，删除失败。" });
    }
  };

  // ── 问答 ────────────────────────────────────────────────────────────
  const canAsk = !asking && question.trim().length > 0 && documents.some((d) => d.status === "ready");

  const doAsk = async () => {
    if (!canAsk) return;
    setAsking(true);
    setAskError(null);
    setResult(null);
    setStreamText("");
    setSteps([]);
    const controller = new AbortController();
    abortRef.current = controller;

    await consumeAskStream(
      question.trim(),
      token,
      {
        onStep: (s) => {
          setSteps((prev) => {
            const next = prev.filter((x) => x.step !== s.step);
            return [...next, s];
          });
        },
        onToken: (t) => setStreamText((prev) => prev + t),
        onDone: (payload) => {
          setResult(payload.result);
          setStreamText(payload.result.answer);
          setAsking(false);
          abortRef.current = null;
        },
        onError: (payload) => {
          setAskError(payload.message);
          setAsking(false);
          abortRef.current = null;
        },
      },
      { signal: controller.signal },
    );
  };

  const cancelAsk = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setAsking(false);
  };

  const readyDocs = documents.filter((d) => d.status === "ready");

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-4 px-4 py-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-[var(--color-ink)]">知识库问答</h1>
          <p className="mt-0.5 text-xs text-[var(--color-ink-2)]">
            导入私有文档，提问后给出带引用的回答；依据不足时明确拒答，不编造。
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <label className="text-[11px] text-[var(--color-ink-3)]" htmlFor="token">
            访问令牌（可选）
          </label>
          <input
            id="token"
            data-testid="token-input"
            type="password"
            value={token}
            onChange={(e) => persistToken(e.target.value)}
            placeholder="未配置则留空"
            className="w-48 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-canvas-subtle)] px-2 py-1 text-xs text-[var(--color-ink)]"
          />
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        {/* ── 左：知识库 ─────────────────────────────────────────── */}
        <section className="flex flex-col rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] shadow-[var(--shadow-sm)]">
          <div className="flex items-center gap-1 border-b border-[var(--color-line)] px-3 py-2">
            {(["paste", "file", "url"] as Tab[]).map((t) => (
              <button
                key={t}
                type="button"
                data-testid={`tab-${t}`}
                onClick={() => {
                  setTab(t);
                  setImportMsg(null);
                }}
                className={`rounded px-2.5 py-1 text-xs transition-colors ${
                  tab === t
                    ? "bg-[var(--color-brand-soft)] font-medium text-[var(--color-brand)]"
                    : "text-[var(--color-ink-2)] hover:bg-[var(--color-hover)]"
                }`}
              >
                {t === "paste" ? "粘贴文本" : t === "file" ? "上传文件" : "网页链接"}
              </button>
            ))}
            <span className="ml-auto text-[11px] text-[var(--color-ink-3)]">
              {readyDocs.length} 篇就绪 · {totalChunks} 片段
            </span>
          </div>

          <div className="flex flex-1 flex-col gap-3 p-3">
            {tab === "paste" && (
              <textarea
                data-testid="paste-textarea"
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder="把文档内容粘贴到这里（支持 Markdown，标题会被识别为引用位置）"
                className="scroll-thin h-40 w-full resize-y rounded-md border border-[var(--color-line-strong)] bg-[var(--color-canvas-subtle)] px-3 py-2 font-mono text-[13px] leading-relaxed text-[var(--color-ink)] placeholder:text-[var(--color-ink-3)]"
              />
            )}

            {tab === "file" && (
              <div className="flex flex-col gap-2">
                <input
                  ref={fileInputRef}
                  data-testid="file-input"
                  type="file"
                  accept=".md,.txt,.pdf"
                  onChange={(e) => void onPickFile(e.target.files?.[0] ?? null)}
                  className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-canvas-subtle)] px-3 py-2 text-xs text-[var(--color-ink-2)] file:mr-3 file:rounded file:border-0 file:bg-[var(--color-brand-soft)] file:px-2 file:py-1 file:text-xs file:text-[var(--color-brand)]"
                />
                {fileName && (
                  <p className="text-[11px] text-[var(--color-ink-3)]">
                    {fileName}
                    {fileText ? ` · 已读取 ${fileText.length.toLocaleString("zh-CN")} 字` : ""}
                  </p>
                )}
                <p className="text-[11px] text-[var(--color-ink-3)]">
                  .md / .txt 直接读取；.pdf 在浏览器内抽取文本（扫描件抽不出文字，需先 OCR）。
                </p>
              </div>
            )}

            {tab === "url" && (
              <div className="flex flex-col gap-2">
                <input
                  data-testid="url-input"
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/article"
                  className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-canvas-subtle)] px-3 py-2 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-3)]"
                />
                <p className="text-[11px] text-[var(--color-ink-3)]">
                  只支持公网 http/https 地址；需要登录或强反爬的页面抓不到正文，请改用粘贴。
                </p>
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="import-btn"
                onClick={() => void doImport()}
                disabled={!canImport}
                className="rounded-md bg-[var(--color-brand)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--color-brand-hover)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {importing ? "处理中…" : "导入并索引"}
              </button>
              <span className="text-[11px] text-[var(--color-ink-3)]">
                导入后自动切分并做向量索引
              </span>
            </div>

            {importMsg && (
              <div
                data-testid="import-msg"
                className={`rounded-md border px-3 py-2 text-xs ${
                  importMsg.kind === "err"
                    ? "border-[var(--color-err)] bg-[var(--color-err-soft)] text-[var(--color-err)]"
                    : importMsg.kind === "warn"
                      ? "border-[var(--color-warn)] bg-[var(--color-warn-soft)] text-[var(--color-warn)]"
                      : "border-[var(--color-line-strong)] bg-[var(--color-inset)] text-[var(--color-ink-2)]"
                }`}
              >
                {importMsg.text}
                {indexingLeft > 0 && (
                  <span data-testid="indexing-countdown" className="mt-1 block text-[var(--color-ink-3)]">
                    索引生效中，还需约 {indexingLeft} 秒；在此之前提问可能暂时无结果。
                  </span>
                )}
              </div>
            )}

            {/* 文档列表 */}
            <div className="mt-1 flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <h2 className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-3)]">
                  知识库文档
                </h2>
                <button
                  type="button"
                  onClick={() => void refreshList()}
                  className="text-[11px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
                >
                  {loadingList ? "刷新中…" : "刷新"}
                </button>
              </div>
              {listError && <p className="text-[11px] text-[var(--color-err)]">{listError}</p>}
              {!listError && documents.length === 0 && (
                <p className="rounded border border-dashed border-[var(--color-line-strong)] px-3 py-6 text-center text-xs text-[var(--color-ink-3)]">
                  还没有文档。先导入一份，问答才有依据。
                </p>
              )}
              <ul data-testid="doc-list" className="flex flex-col gap-1">
                {documents.map((d) => (
                  <li
                    key={d.id}
                    data-testid="doc-item"
                    className="flex items-center gap-2 rounded border border-[var(--color-line)] bg-[var(--color-canvas-subtle)] px-2.5 py-1.5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-[var(--color-ink)]" title={d.title || d.sourceRef || d.id}>
                        {d.title || d.sourceRef || "未命名文档"}
                      </p>
                      <p className="truncate text-[10px] text-[var(--color-ink-3)]">
                        {SOURCE_LABEL[d.source] ?? d.source} · {STATUS_LABEL[d.status] ?? d.status} · {d.chunkCount} 片段
                        {d.error ? ` · ${d.error}` : ""}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void removeDoc(d.id)}
                      className="shrink-0 rounded px-2 py-0.5 text-[11px] text-[var(--color-ink-3)] hover:bg-[var(--color-hover)] hover:text-[var(--color-err)]"
                    >
                      删除
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* ── 右：问答 ───────────────────────────────────────────── */}
        <section className="flex min-h-[420px] flex-col gap-3">
          <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-3 shadow-[var(--shadow-sm)]">
            <textarea
              data-testid="question-input"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="基于知识库提问，例如：部署和回滚分别用什么命令？"
              className="scroll-thin h-20 w-full resize-y rounded-md border border-[var(--color-line-strong)] bg-[var(--color-canvas-subtle)] px-3 py-2 text-sm leading-relaxed text-[var(--color-ink)] placeholder:text-[var(--color-ink-3)]"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="ask-btn"
                onClick={() => void doAsk()}
                disabled={!canAsk}
                className="rounded-md bg-[var(--color-brand)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--color-brand-hover)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {asking ? "回答中…" : "提问"}
              </button>
              {asking && (
                <button
                  type="button"
                  data-testid="cancel-btn"
                  onClick={cancelAsk}
                  className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-sm text-[var(--color-ink-2)] hover:bg-[var(--color-hover)]"
                >
                  取消
                </button>
              )}
              {!canAsk && !asking && (
                <span className="text-[11px] text-[var(--color-ink-3)]">
                  {readyDocs.length === 0 ? "先导入文档后才能提问" : "请输入问题"}
                </span>
              )}
            </div>

            {/* 步骤进度：让长等待有可见反馈 */}
            {steps.length > 0 && (
              <ul data-testid="steps" className="flex flex-wrap items-center gap-1.5">
                {steps.map((s) => (
                  <li
                    key={s.step}
                    className={`rounded px-2 py-0.5 text-[11px] ${
                      s.status === "done"
                        ? "bg-[var(--color-brand-soft)] text-[var(--color-brand)]"
                        : "bg-[var(--color-inset)] text-[var(--color-ink-2)]"
                    }`}
                  >
                    {STEP_LABEL[s.step] ?? s.step}
                    {s.status === "done" ? " ✓" : "…"}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {askError && (
            <div className="rounded-md border border-[var(--color-err)] bg-[var(--color-err-soft)] px-3 py-2 text-xs text-[var(--color-err)]">
              {askError}
            </div>
          )}

          {/* 回答区 */}
          <div className="flex flex-1 flex-col gap-3">
            {!result && !asking && !streamText && (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--color-line-strong)] bg-[var(--color-canvas-subtle)] px-6 text-center">
                <p className="text-sm text-[var(--color-ink-2)]">回答会显示在这里</p>
                <p className="max-w-xs text-xs text-[var(--color-ink-3)]">
                  每条结论都会附上来源片段；如果知识库没有依据，会明确告知而不是编造。
                </p>
              </div>
            )}

            {(result || streamText || asking) && (
              <article className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-3 shadow-[var(--shadow-sm)]">
                {result?.refused ? (
                  <div className="flex flex-col gap-2">
                    <p data-testid="refusal" className="text-sm font-medium text-[var(--color-warn)]">{result.answer}</p>
                    {result.indexingRecently && (
                      <p data-testid="indexing-hint" className="rounded border border-[var(--color-warn)] bg-[var(--color-warn-soft)] px-2.5 py-1.5 text-xs text-[var(--color-warn)]">
                        库内有刚刚导入的文档，向量索引写入是异步的（实测需约 50 秒）。请等一会儿再问一次。
                      </p>
                    )}
                    {result.nearest && result.nearest.length > 0 && (
                      <div className="flex flex-col gap-1.5">
                        <p className="text-[11px] text-[var(--color-ink-3)]">最相近的内容（可能是问法不同，或该内容尚未导入）：</p>
                        {result.nearest.map((n) => (
                          <div key={n.chunkId} className="rounded border border-[var(--color-line)] bg-[var(--color-inset)] px-2.5 py-1.5">
                            <p className="text-[11px] text-[var(--color-ink-3)]">
                              {n.docTitle}
                              {n.headingPath ? ` · ${n.headingPath}` : ""} · 相似度 {n.score.toFixed(2)}
                            </p>
                            <p className="mt-0.5 text-xs leading-relaxed text-[var(--color-ink-2)]">{n.snippet}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <p data-testid="answer" className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--color-ink)]">
                    {streamText || result?.answer || ""}
                    {asking && <span className="ml-0.5 inline-block animate-pulse text-[var(--color-brand)]">▍</span>}
                  </p>
                )}

                {/* 引用块 */}
                {result?.citations && result.citations.length > 0 && (
                  <div data-testid="citations" className="mt-3 flex flex-col gap-1.5 border-t border-[var(--color-line)] pt-2">
                    <h3 className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-3)]">引用来源</h3>
                    {result.citations.map((c) => (
                      <div key={c.index} className="rounded border border-[var(--color-line)] bg-[var(--color-canvas-subtle)] px-2.5 py-1.5">
                        <p className="text-[11px] text-[var(--color-ink-2)]">
                          <span className="mr-1 rounded bg-[var(--color-brand-soft)] px-1 text-[var(--color-brand)]">[{c.index}]</span>
                          {c.docTitle}
                          {c.headingPath ? ` · ${c.headingPath}` : ""}
                        </p>
                        <p className="mt-0.5 text-xs leading-relaxed text-[var(--color-ink-2)]">{c.snippet}</p>
                      </div>
                    ))}
                  </div>
                )}
              </article>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
