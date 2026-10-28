/**
 * 首页 — 知识库问答工作台（二期：多轮会话 + 混合检索可观测 + 扫描件 OCR + 索引探针）
 *
 * 布局：左栏知识库管理（导入 / 文档列表 / 索引状态与探针），右栏会话（会话列表 + 消息流）。
 *
 * 设计原则（沿用产品①②）：
 *  - 空输入禁用提交（不是报错）
 *  - 长等待有可见反馈（步骤进度 + 流式增量）+ 可取消
 *  - 引用可核验：每条引用给出文档名 + 位置 + 原文片段 + 命中通道
 *  - **不猜状态**：索引是否生效由 `POST /api/probe` 真探，不用「等 60 秒应该好了」糊过去
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { consumeAskStream, type AskDonePayload, type AskResult, type StepState } from "../lib/client-stream.ts";
import { buildTitle } from "../lib/conversation.ts";
import { extractPdfText, PdfExtractError, renderPdfPages, PDF_MAX_OCR_PAGES } from "../lib/pdf.ts";

const TOKEN_KEY = "kb_token";
/** 与服务端 routes/api/ask.ts 的 INDEXING_HINT_WINDOW_MS 对齐（只用于前端倒计时展示） */
const INDEX_WINDOW_MS = 90_000;

type DocRow = {
  id: string;
  source: string;
  sourceRef: string | null;
  title: string;
  status: string;
  chunkCount: number;
  error: string | null;
  createdAt: number;
  indexedAt?: number;
};

type ConversationRow = {
  id: string;
  title: string;
  turnCount: number;
  createdAt: number;
  updatedAt: number;
};

type ChatMessage = {
  id: string;
  question: string;
  result: AskResult;
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

function timeLabel(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

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
   * 索引生效倒计时（毫秒时间戳）：Vectorize 的写入是异步的，线上实测导入后
   * 0–40 秒必拒答、第 50 秒才命中。不给倒计时，用户会判定成「上传失败」。
   */
  const [indexingUntil, setIndexingUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  /** 扫描件：抽不出文字时保留文件，供「OCR 识别」使用（不自动入库） */
  const [ocrFile, setOcrFile] = useState<File | null>(null);
  const [ocrRunning, setOcrRunning] = useState(false);
  const [ocrMsg, setOcrMsg] = useState<{ kind: "ok" | "warn" | "err"; text: string } | null>(null);

  /** 索引探针结果（本地状态：命中即「可检索已验证」，不污染数据库时间戳语义） */
  const [probe, setProbe] = useState<Record<string, { searchable: boolean; at: number }>>({});
  const [probing, setProbing] = useState<string | null>(null);

  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [loadingConv, setLoadingConv] = useState(false);

  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [steps, setSteps] = useState<StepState[]>([]);
  const [streamText, setStreamText] = useState("");
  const [askError, setAskError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** 取消时把问题还原回输入框（否则用户得重新打一遍，取消等于白丢一次输入） */
  const lastAskedRef = useRef<string>("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const convAbort = useRef<AbortController | null>(null);

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

  // ── 心跳：倒计时与索引窗口共用（500ms 足够，别用 rAF 烧主线程）────
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);

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

  // ── 会话列表 ────────────────────────────────────────────────────────
  const refreshConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/conversations", { headers: authHeaders() });
      if (!res.ok) return;
      const body = (await res.json()) as { conversations: ConversationRow[] };
      setConversations(body.conversations ?? []);
    } catch {
      // 会话列表失败不阻塞问答（会话仍可由 ask 自动创建）
    }
  }, [authHeaders]);

  useEffect(() => {
    void refreshList();
    void refreshConversations();
  }, [refreshList, refreshConversations]);

  const openConversation = useCallback(
    async (id: string) => {
      convAbort.current?.abort();
      const controller = new AbortController();
      convAbort.current = controller;
      setActiveConvId(id);
      setLoadingConv(true);
      setAskError(null);
      try {
        const res = await fetch(`/api/conversations?id=${encodeURIComponent(id)}`, {
          headers: authHeaders(),
          signal: controller.signal,
        });
        if (res.status === 404) {
          setActiveConvId(null);
          setChatMessages([]);
          await refreshConversations();
          return;
        }
        if (!res.ok) {
          setAskError("读取会话消息失败，请稍后重试。");
          return;
        }
        const body = (await res.json()) as { messages: Array<Omit<ChatMessage, "id"> & { id: string }> };
        setChatMessages((body.messages ?? []).map((m) => ({ ...m, result: m.result })));
      } catch {
        // 主动取消不算错误
      } finally {
        setLoadingConv(false);
      }
    },
    [authHeaders, refreshConversations],
  );

  const deleteConversation = async (id: string) => {
    try {
      const res = await fetch(`/api/conversations?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) {
        setAskError("删除会话失败，请稍后重试。");
        return;
      }
      // 删的是当前会话 → 合并清空消息区，避免留下无主消息
      if (activeConvId === id) {
        setActiveConvId(null);
        setChatMessages([]);
        setStreamText("");
        setSteps([]);
      }
      await refreshConversations();
    } catch {
      setAskError("网络异常，删除会话失败。");
    }
  };

  const newConversation = () => {
    convAbort.current?.abort();
    setActiveConvId(null);
    setChatMessages([]);
    setStreamText("");
    setSteps([]);
    setAskError(null);
    setQuestion("");
  };

  // ── 索引倒计时 ────────────────────────────────────────────────────
  const indexingLeft = indexingUntil ? Math.max(0, Math.ceil((indexingUntil - now) / 1000)) : 0;

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
          text: `已导入：切分为 ${chunks} 个片段。向量索引写入是异步的，约 1 分钟后才能检索到（可用「检测」按钮实测）。`,
        });
        setIndexingUntil(Date.now() + 60_000);
        setPasteText("");
        setUrl("");
        setFileText("");
        setFileName("");
        setOcrFile(null);
        setOcrMsg(null);
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
    setOcrMsg(null);
    setOcrFile(null);
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".pdf")) {
      try {
        setImporting(true);
        const { text, pages } = await extractPdfText(file);
        setFileText(text);
        setImportMsg({ kind: "ok", text: `已从 PDF 抽取 ${pages} 页文本（${text.length.toLocaleString("zh-CN")} 字），可直接导入。` });
      } catch (e) {
        setFileText("");
        if (e instanceof PdfExtractError && e.code === "no_text") {
          // 扫描件：抽出不文字不是错误，而是一条需要用户决策的分支（OCR / 粘贴）
          setOcrFile(file);
          setImportMsg({ kind: "warn", text: e.message });
        } else {
          setImportMsg({
            kind: "err",
            text: e instanceof PdfExtractError ? e.message : "PDF 解析失败，请改用粘贴文本方式。",
          });
        }
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

  /** 扫描件 OCR：前端渲染页图 → 逐页 POST /api/ocr → 文本回填到**可编辑**文本框 */
  const runOcr = async () => {
    if (!ocrFile || ocrRunning) return;
    setOcrRunning(true);
    setOcrMsg(null);
    try {
      const images = await renderPdfPages(ocrFile, { maxPages: PDF_MAX_OCR_PAGES });
      const texts: string[] = [];
      const failed: number[] = [];
      for (const img of images) {
        const res = await fetch("/api/ocr", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ image: img.dataUrl, page: img.page }),
        });
        const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
        if (res.ok && body.text) texts.push(body.text);
        else {
          failed.push(img.page);
          // 401 是环境问题（缺令牌），不是识别问题：单独提示，别混进「识别失败」
          if (res.status === 401) {
            setOcrRunning(false);
            setOcrMsg({ kind: "err", text: "OCR 需要访问令牌：请在右上角填入令牌后重试。" });
            return;
          }
        }
      }
      const merged = texts.join("\n\n").trim();
      if (merged) {
        setFileText(merged);
        setOcrMsg({
          kind: failed.length ? "warn" : "ok",
          text: failed.length
            ? `已识别 ${texts.length} 页，第 ${failed.join("、")} 页失败（可单独重试或手工补录）。识别结果**未经校对**，请修改后再导入。`
            : `已识别 ${texts.length} 页。识别结果**未经校对**，请检查文本后再导入。`,
        });
      } else {
        setOcrMsg({ kind: "err", text: "所有页面都没识别出文字，请改用文字粘贴方式录入。" });
      }
    } catch (e) {
      setOcrMsg({
        kind: "err",
        text: e instanceof PdfExtractError ? e.message : "OCR 渲染失败，请改用文字粘贴方式。",
      });
    } finally {
      setOcrRunning(false);
    }
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

  /** 索引探针：真检索一次，看这篇文档的片段能不能被自己命中 */
  const probeDoc = async (id: string) => {
    if (probing) return;
    setProbing(id);
    try {
      const res = await fetch("/api/probe", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ id }),
      });
      const body = (await res.json().catch(() => ({}))) as { searchable?: boolean; message?: string; error?: string };
      if (!res.ok) {
        setImportMsg({ kind: "err", text: body.error ?? "检测失败，请稍后重试。" });
        return;
      }
      const searchable = body.searchable === true;
      setProbe((prev) => ({ ...prev, [id]: { searchable, at: Date.now() } }));
      setImportMsg(
        searchable
          ? { kind: "ok", text: "检测结果：该文档的向量已可检索。" }
          : { kind: "warn", text: body.message ?? "暂时还检索不到（索引仍在写入），请稍后再试。" },
      );
    } catch {
      setImportMsg({ kind: "err", text: "网络异常，检测失败。" });
    } finally {
      setProbing(null);
    }
  };

  // ── 问答 ────────────────────────────────────────────────────────────
  const canAsk = !asking && question.trim().length > 0 && documents.some((d) => d.status === "ready");

  const doAsk = async () => {
    if (!canAsk) return;
    const asked = question.trim();
    lastAskedRef.current = asked;
    setAsking(true);
    setAskError(null);
    setStreamText("");
    setSteps([]);
    setQuestion("");
    const controller = new AbortController();
    abortRef.current = controller;

    await consumeAskStream(
      asked,
      token,
      {
        onStep: (s) => {
          setSteps((prev) => [...prev.filter((x) => x.step !== s.step), s]);
        },
        onToken: (t) => setStreamText((prev) => prev + t),
        onDone: (payload: AskDonePayload) => {
          // 服务端可能在首次提问时新建会话：认它返回的 id，别自己造一个
          const convId = payload.conversationId || activeConvId;
          if (convId) {
            setActiveConvId(convId);
            // 乐观更新侧栏：等服务端 refreshConversations 回来再显示会有一拍空档，
            // 用户会以为「问题没进会话」（浏览器冒烟也在这里踩过时序）。
            const nowTs = Date.now();
            setConversations((prev) => {
              const exists = prev.find((c) => c.id === convId);
              const next = exists
                ? prev.map((c) =>
                    c.id === convId ? { ...c, turnCount: c.turnCount + 1, updatedAt: nowTs } : c,
                  )
                : [{ id: convId, title: buildTitle(asked), turnCount: 1, createdAt: nowTs, updatedAt: nowTs }, ...prev];
              return [...next].sort((a, b) => b.updatedAt - a.updatedAt);
            });
          }
          setChatMessages((prev) => [
            ...prev,
            {
              id: payload.messageId || payload.qaId || `local_${Date.now()}`,
              question: asked,
              result: payload.result,
              createdAt: Date.now(),
            },
          ]);
          setStreamText("");
          setAsking(false);
          abortRef.current = null;
          void refreshConversations();
        },
        onError: (payload) => {
          setAskError(payload.message);
          setStreamText("");
          setAsking(false);
          abortRef.current = null;
          void refreshConversations();
        },
      },
      { signal: controller.signal, conversationId: activeConvId },
    );
  };

  const cancelAsk = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setAsking(false);
    // 取消后把问题放回输入框：让用户能改完再发，而不是从头再打
    setQuestion((cur) => (cur.trim() ? cur : lastAskedRef.current));
  };

  const copyAnswer = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 2000);
    } catch {
      setAskError("复制失败：浏览器不允许访问剪贴板，请手动选中复制。");
    }
  };

  const readyDocs = documents.filter((d) => d.status === "ready");

  /** 文档索引状态徽标（探针命中最可信 > 90 秒窗口 > 仅就绪） */
  const docBadge = (d: DocRow): { text: string; tone: string } => {
    const p = probe[d.id];
    if (p?.searchable) return { text: "可检索已验证", tone: "text-[var(--color-brand)]" };
    if (d.status === "failed") return { text: STATUS_LABEL.failed, tone: "text-[var(--color-err)]" };
    if (d.status !== "ready") return { text: STATUS_LABEL[d.status] ?? d.status, tone: "text-[var(--color-ink-3)]" };
    if (d.indexedAt) {
      const left = Math.ceil((d.indexedAt + INDEX_WINDOW_MS - now) / 1000);
      if (left > 0) return { text: `索引中 · 约 ${left} 秒`, tone: "text-[var(--color-warn)]" };
    }
    return { text: "已就绪（未验证）", tone: "text-[var(--color-ink-3)]" };
  };

  const renderResult = (m: ChatMessage) => {
    const r = m.result;
    if (r.refused) {
      return (
        <div className="flex flex-col gap-2">
          <p data-testid="refusal" className="text-sm font-medium text-[var(--color-warn)]">{r.answer}</p>
          {r.indexingRecently && (
            <p data-testid="indexing-hint" className="rounded border border-[var(--color-warn)] bg-[var(--color-warn-soft)] px-2.5 py-1.5 text-xs text-[var(--color-warn)]">
              库内有刚刚导入的文档，向量索引写入是异步的（实测需约 50 秒）。可以点左侧文档的「检测」确认是否已可检索。
            </p>
          )}
          {r.nearest && r.nearest.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-[11px] text-[var(--color-ink-3)]">最相近的内容（可能是问法不同，或该内容尚未导入）：</p>
              {r.nearest.map((n) => (
                <div key={n.chunkId} className="rounded border border-[var(--color-line)] bg-[var(--color-inset)] px-2.5 py-1.5">
                  <p className="text-[11px] text-[var(--color-ink-3)]">
                    {n.docTitle}
                    {n.headingPath ? ` · ${n.headingPath}` : ""} ·{" "}
                    {n.matchedBy === "keyword" ? "关键词命中" : `相似度 ${n.score.toFixed(2)}`}
                  </p>
                  <p className="mt-0.5 text-xs leading-relaxed text-[var(--color-ink-2)]">{n.snippet}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-2">
        <p data-testid="answer" className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--color-ink)]">
          {r.answer}
        </p>
        {r.citations && r.citations.length > 0 && (
          <div data-testid="citations" className="flex flex-col gap-1.5 border-t border-[var(--color-line)] pt-2">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-3)]">引用来源</h3>
            {r.citations.map((c) => (
              <div key={c.index} className="rounded border border-[var(--color-line)] bg-[var(--color-canvas-subtle)] px-2.5 py-1.5">
                <p className="text-[11px] text-[var(--color-ink-2)]">
                  <span className="mr-1 rounded bg-[var(--color-brand-soft)] px-1 text-[var(--color-brand)]">[{c.index}]</span>
                  {c.docTitle}
                  {c.headingPath ? ` · ${c.headingPath}` : ""}
                  <span className="ml-1 text-[var(--color-ink-3)]">
                    {c.matchedBy === "keyword" ? "· 关键词命中" : `· ${c.score.toFixed(2)}`}
                  </span>
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-[var(--color-ink-2)]">{c.snippet}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-4 px-4 py-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-[var(--color-ink)]">知识库问答</h1>
          <p className="mt-0.5 text-xs text-[var(--color-ink-2)]">
            导入私有文档，多轮追问；回答带可核验引用，依据不足时明确拒答，不编造。
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

      <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)]">
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
                {ocrFile && (
                  <div className="flex flex-col gap-1.5 rounded border border-[var(--color-line-strong)] bg-[var(--color-inset)] px-2.5 py-2">
                    <p className="text-[11px] text-[var(--color-ink-2)]">
                      这是扫描件（没有文字层）。可让视觉模型 OCR 识别前 {PDF_MAX_OCR_PAGES} 页，结果会填进下方文本框供你校对。
                    </p>
                    <button
                      type="button"
                      data-testid="ocr-btn"
                      onClick={() => void runOcr()}
                      disabled={ocrRunning}
                      className="self-start rounded border border-[var(--color-brand)] bg-[var(--color-brand-soft)] px-2.5 py-1 text-xs text-[var(--color-brand)] disabled:opacity-40"
                    >
                      {ocrRunning ? "识别中…" : `OCR 识别（最多 ${PDF_MAX_OCR_PAGES} 页）`}
                    </button>
                    {ocrMsg && (
                      <p
                        data-testid="ocr-msg"
                        className={
                          ocrMsg.kind === "err"
                            ? "text-[11px] text-[var(--color-err)]"
                            : ocrMsg.kind === "warn"
                              ? "text-[11px] text-[var(--color-warn)]"
                              : "text-[11px] text-[var(--color-ink-2)]"
                        }
                      >
                        {ocrMsg.text}
                      </p>
                    )}
                  </div>
                )}
                {fileText && (
                  <textarea
                    data-testid="file-text-textarea"
                    value={fileText}
                    onChange={(e) => setFileText(e.target.value)}
                    className="scroll-thin h-32 w-full resize-y rounded-md border border-[var(--color-line-strong)] bg-[var(--color-canvas-subtle)] px-3 py-2 font-mono text-[12px] leading-relaxed text-[var(--color-ink)]"
                  />
                )}
                <p className="text-[11px] text-[var(--color-ink-3)]">
                  .md / .txt 直接读取；.pdf 在浏览器内抽取文本；扫描件可走 OCR（前 {PDF_MAX_OCR_PAGES} 页）。
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
              <span className="text-[11px] text-[var(--color-ink-3)]">导入后自动切分并做向量索引</span>
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
                {documents.map((d) => {
                  const badge = docBadge(d);
                  return (
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
                          {SOURCE_LABEL[d.source] ?? d.source} ·{" "}
                          <span data-testid="doc-status" className={badge.tone}>
                            {badge.text}
                          </span>{" "}
                          · {d.chunkCount} 片段{d.error ? ` · ${d.error}` : ""}
                        </p>
                      </div>
                      <button
                        type="button"
                        data-testid="probe-btn"
                        onClick={() => void probeDoc(d.id)}
                        disabled={probing === d.id}
                        title="真实检索一次，确认这篇文档的向量是否已可检索"
                        className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-[var(--color-ink-3)] hover:bg-[var(--color-hover)] hover:text-[var(--color-brand)] disabled:opacity-40"
                      >
                        {probing === d.id ? "检测中…" : "检测"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeDoc(d.id)}
                        className="shrink-0 rounded px-2 py-0.5 text-[11px] text-[var(--color-ink-3)] hover:bg-[var(--color-hover)] hover:text-[var(--color-err)]"
                      >
                        删除
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </section>

        {/* ── 右：会话 ───────────────────────────────────────────── */}
        <section className="flex min-h-[480px] gap-3">
          {/* 会话列表：窄栏（移动端折成横向滚动） */}
          <aside className="flex w-36 shrink-0 flex-col gap-2 lg:w-40">
            <button
              type="button"
              data-testid="new-conversation-btn"
              onClick={newConversation}
              className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1.5 text-xs text-[var(--color-ink-2)] hover:bg-[var(--color-hover)]"
            >
              + 新会话
            </button>
            <ul
              data-testid="conversation-list"
              className="scroll-thin flex max-h-[460px] flex-col gap-1 overflow-y-auto"
            >
              {conversations.length === 0 && (
                <li className="rounded border border-dashed border-[var(--color-line-strong)] px-2 py-3 text-center text-[10px] text-[var(--color-ink-3)]">
                  还没有会话
                </li>
              )}
              {conversations.map((c) => (
                <li key={c.id} className="group relative">
                  <button
                    type="button"
                    data-testid="conversation-item"
                    data-active={activeConvId === c.id ? "1" : "0"}
                    onClick={() => void openConversation(c.id)}
                    className={`w-full rounded border px-2 py-1.5 text-left transition-colors ${
                      activeConvId === c.id
                        ? "border-[var(--color-brand)] bg-[var(--color-brand-soft)] text-[var(--color-brand)]"
                        : "border-[var(--color-line)] text-[var(--color-ink-2)] hover:bg-[var(--color-hover)]"
                    }`}
                  >
                    <span className="block truncate text-[11px]">{c.title || "未命名会话"}</span>
                    <span className="block truncate text-[10px] text-[var(--color-ink-3)]">
                      {c.turnCount} 轮 · {timeLabel(c.updatedAt)}
                    </span>
                  </button>
                  <button
                    type="button"
                    data-testid="conversation-delete"
                    onClick={() => void deleteConversation(c.id)}
                    title="删除会话（连带其全部消息）"
                    className="absolute right-0.5 top-0.5 rounded px-1 text-[10px] text-[var(--color-ink-3)] opacity-0 transition-opacity hover:text-[var(--color-err)] group-hover:opacity-100"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          {/* 消息区 */}
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="scroll-thin flex max-h-[420px] flex-col gap-2 overflow-y-auto rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-3 shadow-[var(--shadow-sm)]">
              {loadingConv && <p className="text-xs text-[var(--color-ink-3)]">读取会话中…</p>}
              {!loadingConv && chatMessages.length === 0 && !asking && (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-center">
                  <p className="text-sm text-[var(--color-ink-2)]">回答会显示在这里</p>
                  <p className="max-w-xs text-xs text-[var(--color-ink-3)]">
                    每条结论都会附上来源片段；知识库没有依据时会明确告知而不是编造。追问可直接用「它呢」这类省略说法。
                  </p>
                </div>
              )}

              {chatMessages.map((m) => (
                <div key={m.id} data-testid="message-item" className="flex flex-col gap-1.5">
                  <p className="text-[11px] text-[var(--color-ink-3)]">
                    <span className="mr-1 text-[var(--color-ink-2)]">问</span>
                    {m.question}
                    {m.result.rewritten && m.result.retrievalQuery && (
                      <span className="ml-1 text-[var(--color-ink-3)]">
                        ·（已按上下文改写为「{m.result.retrievalQuery}」检索）
                      </span>
                    )}
                  </p>
                  <article className="rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas-subtle)] p-2.5">
                    {renderResult(m)}
                    {!m.result.refused && (
                      <button
                        type="button"
                        data-testid="copy-answer-btn"
                        onClick={() => void copyAnswer(m.id, m.result.answer)}
                        className="mt-2 rounded border border-[var(--color-line-strong)] px-2 py-0.5 text-[11px] text-[var(--color-ink-3)] hover:bg-[var(--color-hover)]"
                      >
                        {copiedId === m.id ? "已复制 ✓" : "复制回答"}
                      </button>
                    )}
                  </article>
                </div>
              ))}

              {asking && (
                <div data-testid="message-item" className="flex flex-col gap-1.5">
                  <p className="text-[11px] text-[var(--color-ink-3)]">
                    <span className="mr-1 text-[var(--color-ink-2)]">问</span>
                    {question || "（正在提问）"}
                  </p>
                  <article className="rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas-subtle)] p-2.5">
                    <p data-testid="answer" className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--color-ink)]">
                      {streamText || "…"}
                      <span className="ml-0.5 inline-block animate-pulse text-[var(--color-brand)]">▍</span>
                    </p>
                  </article>
                </div>
              )}
            </div>

            {steps.length > 0 && (
              <ul data-testid="steps" className="flex flex-wrap items-center gap-1.5">
                {steps.map((s) => (
                  <li
                    key={s.step}
                    title={s.detail}
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

            {askError && (
              <div className="rounded-md border border-[var(--color-err)] bg-[var(--color-err-soft)] px-3 py-2 text-xs text-[var(--color-err)]">
                {askError}
              </div>
            )}

            <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-3 shadow-[var(--shadow-sm)]">
              <textarea
                data-testid="question-input"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="基于知识库提问，例如：部署和回滚分别用什么命令？追问可以直接说「那配额呢」"
                className="scroll-thin h-16 w-full resize-y rounded-md border border-[var(--color-line-strong)] bg-[var(--color-canvas-subtle)] px-3 py-2 text-sm leading-relaxed text-[var(--color-ink)] placeholder:text-[var(--color-ink-3)]"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="ask-btn"
                  onClick={() => void doAsk()}
                  disabled={!canAsk}
                  className="rounded-md bg-[var(--color-brand)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--color-brand-hover)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {asking ? "回答中…" : activeConvId ? "继续追问" : "提问"}
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
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}