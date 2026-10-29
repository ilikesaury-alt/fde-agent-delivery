/**
 * 首页 — 体检报告工作台
 *
 * 布局：左栏导入（PDF / 扫描件 OCR / 手工录入 / 粘贴）→ **预览确认闸**；右栏四个页签
 * （时间线 / 趋势 / 解读 / 手工补录）。
 *
 * 设计纪律（每条都对应一个真实后果）：
 *  - **抽取结果不自动入库**：预览表格逐行勾选，人确认才算数（CONTEXT 方案 A 人工确认闸）
 *  - **原文可对照**：每行指标展示 source_quote，值对不对一眼可比（不让人盲信模型）
 *  - **不猜状态**：参考范围解析不出就显示「无法判断」，绝不假装正常
 *  - **不装医生**：解读区固定免责声明 + 拒答时明确说「不做诊断、不提供用药」
 *  - 长等待有可见进度（OCR 逐页 / 抽取中）+ 可取消（AbortController）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { extractPdfText, PdfExtractError, renderPdfPages, PDF_MAX_OCR_PAGES } from "../lib/pdf.ts";

const TOKEN_KEY = "health_token";

/* ────────────────────────── 类型 ────────────────────────── */

type MetricView = {
  standardName: string;
  rawName: string;
  valueNum: number | null;
  valueText: string;
  unit: string | null;
  refLow: number | null;
  refHigh: number | null;
  refText: string | null;
  status: "normal" | "high" | "low" | "unknown";
  sourceQuote: string | null;
  id?: string;
  reportId?: string;
};

type ReportSlim = {
  id: string;
  sourceType: "pdf" | "ocr" | "manual";
  fileName: string | null;
  checkDate: string;
  hospital: string | null;
  metricCount: number;
  createdAt: number;
};

type Preview = {
  checkDate: string;
  hospital: string | null;
  metrics: MetricView[];
  rawText: string;
  sourceType: "pdf" | "ocr" | "manual";
  fileName: string | null;
  chars: number;
};

type TrendPointView = {
  reportId: string;
  checkDate: string;
  valueNum: number;
  unit: string | null;
  refLow: number | null;
  refHigh: number | null;
  status: MetricView["status"];
};

type TrendSeries = {
  standardName: string;
  rawNames: string[];
  unit: string | null;
  points: TrendPointView[];
  refChanged: boolean;
  unitChanged: boolean;
};

type InterpretResult = {
  refused: boolean;
  refusalReason?: string;
  text: string;
  citations: Array<{
    reportId: string;
    checkDate: string;
    valueText: string;
    unit: string | null;
    refText: string | null;
    status: string;
  }>;
  mode: "explain" | "trend";
  disclaimer: string;
};

/* ────────────────────────── 常量 ────────────────────────── */

const SOURCE_LABEL: Record<string, string> = { pdf: "电子版 PDF", ocr: "扫描件识别", manual: "手工录入" };
const STATUS_LABEL: Record<string, string> = {
  normal: "正常",
  high: "偏高",
  low: "偏低",
  unknown: "无法判断",
};
const STATUS_CLASS: Record<string, string> = {
  normal: "text-[var(--color-ok)] bg-[var(--color-ok-soft)]",
  high: "text-[var(--color-err)] bg-[var(--color-err-soft)]",
  low: "text-[var(--color-warn)] bg-[var(--color-warn-soft)]",
  unknown: "text-[var(--color-ink-3)] bg-[var(--color-inset)]",
};

const TABS = [
  { id: "timeline", label: "时间线" },
  { id: "trend", label: "趋势" },
  { id: "interpret", label: "指标解读" },
  { id: "manual", label: "手工补录" },
] as const;
type TabId = (typeof TABS)[number]["id"];

/* ────────────────────────── 工具 ────────────────────────── */

async function api<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const data = (await resp.json().catch(() => ({}))) as T & { error?: string };
  if (!resp.ok) {
    const err = new Error(data?.error ?? `请求失败（${resp.status}）`);
    (err as Error & { status?: number }).status = resp.status;
    throw err;
  }
  return data;
}

/** 请求被用户主动取消（各浏览器/Node 抛的形态不同） */
function isAbortError(e: unknown): boolean {
  if (e == null || typeof e !== "object") return false;
  const err = e as { name?: unknown; message?: unknown };
  return err.name === "AbortError" || /abort/i.test(String(err.message ?? ""));
}

function formatValue(m: { valueText: string; unit: string | null }): string {
  return `${m.valueText}${m.unit ? ` ${m.unit}` : ""}`;
}

/* ────────────────────────── 趋势图（自绘 SVG） ────────────────────────── */

/**
 * 折线 + 参考范围带。
 * 为什么自绘：需求只有折线+范围带，引入图表库（recharts/echarts）在体积与 SSR 兼容上
 * 都不划算（方案「落选候选清单」已记录复活条件）。
 */
function TrendChart({ series }: { series: TrendSeries }) {
  const W = 720;
  const H = 260;
  const PAD = { top: 18, right: 18, bottom: 34, left: 52 };
  const points = series.points;

  const values = points.map((p) => p.valueNum);
  const lows = points.map((p) => p.refLow).filter((v): v is number => v != null);
  const highs = points.map((p) => p.refHigh).filter((v): v is number => v != null);
  const all = [...values, ...lows, ...highs];
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const padY = (max - min) * 0.12;
  min -= padY;
  max += padY;

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (i: number) => (points.length === 1 ? PAD.left + innerW / 2 : PAD.left + (innerW * i) / (points.length - 1));
  const y = (v: number) => PAD.top + innerH - ((v - min) / (max - min)) * innerH;

  // 参考范围带取「最新一次」的范围（跨次范围变化由 refChanged 提示，不把多条带叠在一起）
  const latest = points[points.length - 1];
  const bandTop = latest.refHigh != null ? y(latest.refHigh) : null;
  const bandBottom = latest.refLow != null ? y(latest.refLow) : null;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => min + (max - min) * f);

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.valueNum).toFixed(1)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${series.standardName} 趋势图`} data-testid="trend-chart">
      {ticks.map((t, i) => (
        <g key={`tick-${i}`}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeWidth="1" />
          <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--color-ink-3)">
            {Number(t.toFixed(3))}
          </text>
        </g>
      ))}

      {bandTop != null && bandBottom != null && (
        <rect
          x={PAD.left}
          y={bandTop}
          width={innerW}
          height={Math.max(1, bandBottom - bandTop)}
          fill="var(--color-ok-soft)"
          opacity="0.75"
          data-testid="trend-ref-band"
        />
      )}

      <path d={line} fill="none" stroke="var(--color-brand)" strokeWidth="2" />

      {points.map((p, i) => (
        <circle
          key={p.reportId}
          cx={x(i)}
          cy={y(p.valueNum)}
          r="4"
          fill={p.status === "high" ? "var(--color-err)" : p.status === "low" ? "var(--color-warn)" : "var(--color-brand)"}
        >
          <title>{`${p.checkDate}：${p.valueNum}${p.unit ? ` ${p.unit}` : ""}（${STATUS_LABEL[p.status]}）`}</title>
        </circle>
      ))}

      {points.map((p, i) => (
        <text
          key={`x-${p.reportId}`}
          x={x(i)}
          y={H - 12}
          textAnchor="middle"
          fontSize="11"
          fill="var(--color-ink-3)"
        >
          {p.checkDate.slice(5)}
        </text>
      ))}
    </svg>
  );
}

/* ────────────────────────── 页面 ────────────────────────── */

export default function Home() {
  const [token, setToken] = useState("");
  const [tab, setTab] = useState<TabId>("timeline");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // 导入
  const [rawText, setRawText] = useState("");
  const [sourceType, setSourceType] = useState<"pdf" | "ocr" | "manual">("pdf");
  const [fileName, setFileName] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [ocrBusy, setOcrBusy] = useState<{ page: number; total: number } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);

  // 数据
  const [reports, setReports] = useState<ReportSlim[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ report: ReportSlim & { rawText: string }; metrics: MetricView[] } | null>(null);
  const [series, setSeries] = useState<TrendSeries[]>([]);
  const [activeSeries, setActiveSeries] = useState<string | null>(null);
  const [trendLoading, setTrendLoading] = useState(false);

  // 解读
  const [interpretSeries, setInterpretSeries] = useState<string | null>(null);
  const [interpreting, setInterpreting] = useState(false);
  const [interpretation, setInterpretation] = useState<InterpretResult | null>(null);

  // 手工补录
  // 默认今天：空日期输入框是「点了保存才知道没填」的经典坑（用户看不出哪里没填）
  const [manualDate, setManualDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [manualRows, setManualRows] = useState<Array<{ rawName: string; valueText: string; unit: string; refText: string }>>([
    { rawName: "", valueText: "", unit: "", refText: "" },
  ]);
  const [manualSaving, setManualSaving] = useState(false);
  /**
   * 日期输入框的 DOM 引用。
   * 为什么要读 ref 而不是只信 state：`<input type="date">` 被程序化赋值
   * （浏览器自动填充、自动测试脚本、部分输入法）时**不触发 onChange**，
   * state 与界面上看到的值会不一致 —— 用户填了日期却报「请填写检测日期」（实测踩到）。
   * 提交时以 DOM 的真值为准，state 只负责受控渲染。
   */
  const manualDateRef = useRef<HTMLInputElement | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const saved = typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null;
    if (saved) setToken(saved);
  }, []);

  const persistToken = useCallback((v: string) => {
    setToken(v);
    if (typeof localStorage !== "undefined") localStorage.setItem(TOKEN_KEY, v);
  }, []);

  const loadReports = useCallback(async () => {
    try {
      const data = await api<{ reports: ReportSlim[] }>("/api/reports", token);
      setReports(data.reports ?? []);
      setError("");
    } catch (e) {
      handleErr(e);
    }
  }, [token]);

  const loadTrends = useCallback(async () => {
    setTrendLoading(true);
    try {
      const data = await api<{ series: TrendSeries[] }>("/api/trends", token);
      const list = data.series ?? [];
      setSeries(list);
      // 默认选中第一个序列：否则「解读该指标」按钮一直是 disabled，
      // 用户会以为功能坏了（真实 UI 走查发现 —— 按钮禁用但没有选中项，无路可走）
      const first = list[0]?.standardName ?? null;
      setActiveSeries((prev) => (prev && list.some((s) => s.standardName === prev) ? prev : first));
      setInterpretSeries((prev) => (prev && list.some((s) => s.standardName === prev) ? prev : first));
      setError("");
    } catch (e) {
      handleErr(e);
    } finally {
      setTrendLoading(false);
    }
  }, [token]);

  const handleErr = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    const status = (e as { status?: number })?.status;
    if (status === 401) setError("访问令牌缺失或错误：请在右上角填入访问令牌。");
    else setError(msg);
  };

  useEffect(() => {
    if (token !== undefined) void loadReports();
  }, [loadReports, token]);

  useEffect(() => {
    if (tab === "trend" || tab === "interpret") void loadTrends();
  }, [tab, loadTrends]);

  /* ── 导入：PDF / 扫描件 ── */

  const onPickFile = async (file: File) => {
    setError("");
    setNotice("");
    setPreview(null);
    setFileName(file.name);
    const isPdf = file.name.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      setError("目前支持 .pdf 报告；图片请用「扫描件识别」路径（先导出为 PDF 或截图后手工录入）。");
      return;
    }
    try {
      const res = await extractPdfText(file);
      setRawText(res.text);
      setSourceType("pdf");
      setNotice(`已抽取 ${res.pages} 页文本（${res.text.length} 字符）。请检查下方文本后点「解析指标」。`);
    } catch (e) {
      if (e instanceof PdfExtractError && e.code === "no_text") {
        setNotice("该 PDF 没有文字层（扫描件/图片型）。请点「识别扫描件」走 OCR 路径。");
        setRawText("");
        setSourceType("ocr");
      } else {
        setError(e instanceof Error ? e.message : "PDF 读取失败。");
      }
    }
  };

  const runOcr = async (file: File) => {
    setError("");
    setNotice("");
    setPreview(null);
    setFileName(file.name);
    setSourceType("ocr");
    try {
      const pages = await renderPdfPages(file, { maxPages: PDF_MAX_OCR_PAGES });
      const parts: string[] = [];
      for (const p of pages) {
        setOcrBusy({ page: p.page, total: pages.length });
        try {
          const res = await api<{ text: string }>("/api/ocr", token, {
            method: "POST",
            body: JSON.stringify({ image: p.dataUrl, page: p.page }),
          });
          parts.push(res.text);
        } catch (e) {
          // 单页失败只跳过该页（不整批失败）——失败页留可见标记，人可手工补
          parts.push(`【第 ${p.page} 页识别失败：${e instanceof Error ? e.message : "未知错误"}】`);
        }
      }
      setRawText(parts.join("\n\n"));
      setNotice(`扫描件识别完成（${pages.length} 页）。识别文本未经校对，请逐行核对后再解析指标。`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "扫描件渲染失败。");
    } finally {
      setOcrBusy(null);
    }
  };

  /* ── 抽取（预览，不入库） ── */

  const doExtract = async () => {
    if (!rawText.trim()) {
      setError("请先提供报告文本（抽取 PDF / 识别扫描件 / 粘贴）。");
      return;
    }
    setError("");
    setNotice("");
    setExtracting(true);
    setPreview(null);
    abortRef.current = new AbortController();
    try {
      const data = await api<Preview>("/api/extract", token, {
        method: "POST",
        body: JSON.stringify({ text: rawText, sourceType, fileName }),
        signal: abortRef.current.signal,
      });
      setPreview({ ...data, rawText, sourceType, fileName });
      // 默认全选（人只需要取消「模型抄错的行」，而不是逐条勾）
      setChecked(new Set(data.metrics.map((_, i) => i)));
      setNotice(`解析出 ${data.metrics.length} 项指标，请核对原文片段后确认入库。`);
    } catch (e) {
      // 用户主动取消不是错误：不弹红色报错，给中性提示并让按钮回正
      // （ui-smoke-test 第 ④ 项「取消后状态是否回正」—— 初版这里会把 AbortError
      // 当成请求失败上屏，用户点「取消」却收到一条红色错误）
      if (isAbortError(e)) {
        setNotice("已取消解析。");
      } else {
        handleErr(e);
      }
    } finally {
      setExtracting(false);
      abortRef.current = null;
    }
  };

  const confirmSave = async () => {
    if (!preview) return;
    const rows = preview.metrics.filter((_, i) => checked.has(i));
    if (rows.length === 0) {
      setError("请至少勾选一条指标后再入库。");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await api("/api/reports", token, {
        method: "POST",
        body: JSON.stringify({
          checkDate: preview.checkDate,
          hospital: preview.hospital,
          rawText: preview.rawText,
          sourceType: preview.sourceType,
          fileName: preview.fileName,
          metrics: rows.map((m) => ({
            rawName: m.rawName,
            valueText: m.valueText,
            unit: m.unit,
            refText: m.refText,
            sourceQuote: m.sourceQuote,
          })),
        }),
      });
      setNotice(`已入库 ${rows.length} 项指标（检测日期 ${preview.checkDate}）。`);
      setPreview(null);
      setRawText("");
      setFileName(null);
      await loadReports();
      setTab("timeline");
    } catch (e) {
      handleErr(e);
    } finally {
      setSaving(false);
    }
  };

  /* ── 明细 / 删除 ── */

  const openReport = async (id: string) => {
    setSelectedId(id);
    setError("");
    try {
      const data = await api<{ report: ReportSlim & { rawText: string }; metrics: MetricView[] }>(
        `/api/reports?id=${encodeURIComponent(id)}`,
        token,
      );
      setDetail(data);
    } catch (e) {
      handleErr(e);
    }
  };

  const deleteReport = async (id: string) => {
    if (!confirm("删除该报告及其全部指标？趋势数据会同时变化。")) return;
    try {
      await api(`/api/reports?id=${encodeURIComponent(id)}`, token, { method: "DELETE" });
      if (selectedId === id) {
        setSelectedId(null);
        setDetail(null);
      }
      await loadReports();
      setNotice("已删除。");
    } catch (e) {
      handleErr(e);
    }
  };

  /* ── 解读 ── */

  const runInterpret = async (standardName: string) => {
    setInterpreting(true);
    setInterpretation(null);
    setError("");
    try {
      const data = await api<InterpretResult>("/api/interpret", token, {
        method: "POST",
        body: JSON.stringify({ standardName }),
      });
      setInterpretation(data);
    } catch (e) {
      handleErr(e);
    } finally {
      setInterpreting(false);
    }
  };

  /* ── 手工补录 ── */

  const saveManual = async () => {
    const rows = manualRows.filter((r) => r.rawName.trim() && r.valueText.trim());
    const checkDate = (manualDateRef.current?.value || manualDate || "").trim();
    if (checkDate) setManualDate(checkDate);
    if (!checkDate) {
      setError("请填写检测日期。");
      return;
    }
    if (rows.length === 0) {
      setError("请至少填写一项指标（名称 + 结果）。");
      return;
    }
    setManualSaving(true);
    setError("");
    try {
      await api("/api/metrics", token, {
        method: "POST",
        body: JSON.stringify({ checkDate, metrics: rows }),
      });
      setNotice(`已补录 ${rows.length} 项指标（${checkDate}）。`);
      setManualRows([{ rawName: "", valueText: "", unit: "", refText: "" }]);
      await loadReports();
      setTab("timeline");
    } catch (e) {
      handleErr(e);
    } finally {
      setManualSaving(false);
    }
  };

  const checkedRows = preview ? preview.metrics.filter((_, i) => checked.has(i)) : [];
  const abnormalCount = useMemo(
    () => checkedRows.filter((m) => m.status === "high" || m.status === "low").length,
    [checkedRows],
  );
  const active = series.find((s) => s.standardName === activeSeries) ?? null;

  return (
    <div className="min-h-screen bg-[var(--color-canvas)] text-[var(--color-ink)]">
      <header className="border-b border-[var(--color-line)] bg-[var(--color-surface)]">
        <div className="mx-auto flex max-w-[1240px] flex-wrap items-center gap-3 px-5 py-3">
          <div className="flex items-baseline gap-2">
            <h1 className="text-[15px] font-semibold" data-testid="app-title">
              体检指标追踪
            </h1>
            <span className="text-[11px] text-[var(--color-ink-3)]">
              报告 → 结构化指标 → 趋势与异常 → 有依据、不越界的解读
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <input
              type="password"
              value={token}
              onChange={(e) => persistToken(e.target.value)}
              placeholder="访问令牌（如已配置）"
              className="w-44 rounded-md border border-[var(--color-line-strong)] px-2 py-1.5 text-[12px]"
              data-testid="token-input"
            />
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1240px] px-5 py-4">
        {(error || notice) && (
          <div
            className={`mb-3 rounded-md border px-3 py-2 text-[12px] ${
              error
                ? "border-[var(--color-err)]/30 bg-[var(--color-err-soft)] text-[var(--color-err)]"
                : "border-[var(--color-line-strong)] bg-[var(--color-ok-soft)] text-[var(--color-ok)]"
            }`}
            data-testid={error ? "error-banner" : "notice-banner"}
          >
            {error || notice}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
          {/* ───── 左：导入 ───── */}
          <section className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-4">
            <h2 className="mb-3 text-[13px] font-semibold">导入报告</h2>

            <div className="mb-3 space-y-2">
              <label className="block text-[11px] text-[var(--color-ink-2)]">
                电子版 PDF（有文字层）
              </label>
              <input
                type="file"
                accept="application/pdf,.pdf"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onPickFile(f);
                }}
                className="block w-full text-[11px]"
                data-testid="pdf-input"
              />
              <div className="flex items-center gap-2">
                <label className="text-[11px] text-[var(--color-ink-2)]">扫描件（图片型 PDF，走 OCR，≤{PDF_MAX_OCR_PAGES} 页）</label>
                <input
                  type="file"
                  accept="application/pdf,.pdf"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void runOcr(f);
                  }}
                  className="text-[11px]"
                  data-testid="ocr-input"
                />
              </div>
              {ocrBusy && (
                <div className="text-[11px] text-[var(--color-ink-2)]" data-testid="ocr-progress">
                  正在识别第 {ocrBusy.page} / {ocrBusy.total} 页…
                </div>
              )}
            </div>

            <label className="mb-1 block text-[11px] text-[var(--color-ink-2)]">
              报告文本（可粘贴/编辑；OCR 结果务必逐行校对）
            </label>
            <textarea
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              rows={10}
              placeholder="粘贴体检报告文本，或在上方选择 PDF 自动抽取…"
              className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-inset)] p-2 font-[var(--font-mono)] text-[11px] leading-relaxed"
              data-testid="report-text"
            />

            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={() => void doExtract()}
                disabled={extracting || !rawText.trim()}
                className="rounded-md bg-[var(--color-brand)] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-40"
                data-testid="extract-btn"
              >
                {extracting ? "解析中…" : "解析指标"}
              </button>
              {extracting && (
                <button
                  onClick={() => abortRef.current?.abort()}
                  className="rounded-md border border-[var(--color-line-strong)] px-2 py-1.5 text-[12px]"
                  data-testid="extract-cancel"
                >
                  取消
                </button>
              )}
              <span className="text-[11px] text-[var(--color-ink-3)]">{rawText.length} 字符</span>
            </div>

            {/* 预览确认闸 */}
            {preview && (
              <div className="mt-4 border-t border-[var(--color-line)] pt-3" data-testid="preview-panel">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
                  <span className="font-medium">确认入库</span>
                  <span className="text-[var(--color-ink-3)]">
                    检测日期 {preview.checkDate} · 已勾选 {checkedRows.length}/{preview.metrics.length} · 异常 {abnormalCount} 项
                  </span>
                </div>
                <div className="max-h-[320px] overflow-auto rounded-md border border-[var(--color-line)]">
                  <table className="w-full border-collapse text-[11px]">
                    <thead className="sticky top-0 bg-[var(--color-inset)]">
                      <tr className="text-left text-[var(--color-ink-2)]">
                        <th className="w-8 px-2 py-1.5">
                          <input
                            type="checkbox"
                            checked={checked.size === preview.metrics.length && preview.metrics.length > 0}
                            onChange={(e) =>
                              setChecked(e.target.checked ? new Set(preview.metrics.map((_, i) => i)) : new Set())
                            }
                            data-testid="check-all"
                          />
                        </th>
                        <th className="px-2 py-1.5">指标</th>
                        <th className="px-2 py-1.5">结果</th>
                        <th className="px-2 py-1.5">参考范围</th>
                        <th className="px-2 py-1.5">状态</th>
                        <th className="px-2 py-1.5">原文片段</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.metrics.map((m, i) => (
                        <tr key={`${m.rawName}-${i}`} className="border-t border-[var(--color-line)]">
                          <td className="px-2 py-1.5 align-top">
                            <input
                              type="checkbox"
                              checked={checked.has(i)}
                              onChange={(e) => {
                                setChecked((prev) => {
                                  const next = new Set(prev);
                                  if (e.target.checked) next.add(i);
                                  else next.delete(i);
                                  return next;
                                });
                              }}
                              data-testid={`check-row-${i}`}
                            />
                          </td>
                          <td className="px-2 py-1.5 align-top">
                            <div>{m.rawName}</div>
                            {m.standardName !== m.rawName && (
                              <div className="text-[10px] text-[var(--color-ink-3)]">→ {m.standardName}</div>
                            )}
                          </td>
                          <td className="px-2 py-1.5 align-top font-[var(--font-mono)]">{formatValue(m)}</td>
                          <td className="px-2 py-1.5 align-top font-[var(--font-mono)]">{m.refText ?? "—"}</td>
                          <td className="px-2 py-1.5 align-top">
                            <span className={`rounded px-1.5 py-0.5 text-[10px] ${STATUS_CLASS[m.status]}`}>
                              {STATUS_LABEL[m.status]}
                            </span>
                          </td>
                          <td className="max-w-[220px] px-2 py-1.5 align-top text-[10px] text-[var(--color-ink-2)]">
                            {m.sourceQuote ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() => void confirmSave()}
                    disabled={saving || checkedRows.length === 0}
                    className="rounded-md bg-[var(--color-brand)] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-40"
                    data-testid="confirm-save-btn"
                  >
                    {saving ? "入库中…" : `确认入库（${checkedRows.length} 项）`}
                  </button>
                  <button
                    onClick={() => setPreview(null)}
                    className="rounded-md border border-[var(--color-line-strong)] px-2 py-1.5 text-[12px]"
                    data-testid="discard-preview"
                  >
                    放弃
                  </button>
                  <span className="text-[10px] text-[var(--color-ink-3)]">未确认前不会写入数据库</span>
                </div>
              </div>
            )}
          </section>

          {/* ───── 右：页签 ───── */}
          <section className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]">
            <nav className="flex gap-1 border-b border-[var(--color-line)] px-3 pt-2">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`rounded-t-md px-3 py-1.5 text-[12px] ${
                    tab === t.id
                      ? "border-b-2 border-[var(--color-brand)] font-medium text-[var(--color-brand)]"
                      : "text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
                  }`}
                  data-testid={`tab-${t.id}`}
                >
                  {t.label}
                </button>
              ))}
            </nav>

            <div className="p-4">
              {/* 时间线 */}
              {tab === "timeline" && (
                <div data-testid="timeline-panel">
                  {reports.length === 0 ? (
                    <p className="py-8 text-center text-[12px] text-[var(--color-ink-3)]">
                      还没有报告。左侧导入一份体检报告，或用手工补录添加一次检测。
                    </p>
                  ) : (
                    <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
                      <ul className="space-y-1.5">
                        {reports.map((r) => (
                          <li key={r.id}>
                            <button
                              onClick={() => void openReport(r.id)}
                              className={`w-full rounded-md border px-3 py-2 text-left text-[12px] ${
                                selectedId === r.id
                                  ? "border-[var(--color-brand-line)] bg-[var(--color-brand-soft)]"
                                  : "border-[var(--color-line)] hover:bg-[var(--color-hover)]"
                              }`}
                              data-testid={`report-item-${r.id}`}
                            >
                              <div className="flex items-center justify-between">
                                <span className="font-medium">{r.checkDate}</span>
                                <span className="text-[10px] text-[var(--color-ink-3)]">{SOURCE_LABEL[r.sourceType]}</span>
                              </div>
                              <div className="mt-0.5 text-[10px] text-[var(--color-ink-3)]">
                                {r.hospital ?? "未注明机构"} · {r.metricCount} 项指标
                              </div>
                            </button>
                          </li>
                        ))}
                      </ul>

                      <div className="min-w-0">
                        {detail ? (
                          <div data-testid="report-detail">
                            <div className="mb-2 flex flex-wrap items-center gap-2">
                              <h3 className="text-[13px] font-semibold">
                                {detail.report.checkDate} · {detail.report.hospital ?? "未注明机构"}
                              </h3>
                              <button
                                onClick={() => void deleteReport(detail.report.id)}
                                className="ml-auto rounded border border-[var(--color-err)]/40 px-2 py-1 text-[11px] text-[var(--color-err)]"
                                data-testid="delete-report-btn"
                              >
                                删除报告
                              </button>
                            </div>
                            <div className="max-h-[300px] overflow-auto rounded-md border border-[var(--color-line)]">
                              <table className="w-full border-collapse text-[11px]">
                                <thead className="sticky top-0 bg-[var(--color-inset)] text-[var(--color-ink-2)]">
                                  <tr className="text-left">
                                    <th className="px-2 py-1.5">指标</th>
                                    <th className="px-2 py-1.5">结果</th>
                                    <th className="px-2 py-1.5">参考范围</th>
                                    <th className="px-2 py-1.5">状态</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {detail.metrics.map((m) => (
                                    <tr key={m.id} className="border-t border-[var(--color-line)]">
                                      <td className="px-2 py-1.5">{m.rawName}</td>
                                      <td className="px-2 py-1.5 font-[var(--font-mono)]">{formatValue(m)}</td>
                                      <td className="px-2 py-1.5 font-[var(--font-mono)]">{m.refText ?? "—"}</td>
                                      <td className="px-2 py-1.5">
                                        <span className={`rounded px-1.5 py-0.5 text-[10px] ${STATUS_CLASS[m.status]}`}>
                                          {STATUS_LABEL[m.status]}
                                        </span>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                            <details className="mt-2">
                              <summary className="cursor-pointer text-[11px] text-[var(--color-ink-2)]">查看报告原文</summary>
                              <pre className="mt-1 max-h-[200px] overflow-auto whitespace-pre-wrap rounded-md border border-[var(--color-line)] bg-[var(--color-inset)] p-2 text-[10px]">
                                {detail.report.rawText}
                              </pre>
                            </details>
                          </div>
                        ) : (
                          <p className="py-8 text-center text-[12px] text-[var(--color-ink-3)]">选择左侧报告查看明细</p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* 趋势 */}
              {tab === "trend" && (
                <div data-testid="trend-panel">
                  {trendLoading ? (
                    <p className="py-8 text-center text-[12px] text-[var(--color-ink-3)]">加载中…</p>
                  ) : series.length === 0 ? (
                    <p className="py-8 text-center text-[12px] text-[var(--color-ink-3)]">
                      还没有可绘制的数值指标。导入至少一份含数值指标的报告后即可看趋势。
                    </p>
                  ) : (
                    <>
                      <div className="mb-3 flex flex-wrap gap-1.5">
                        {series.map((s) => (
                          <button
                            key={s.standardName}
                            onClick={() => setActiveSeries(s.standardName)}
                            className={`rounded-full border px-2.5 py-1 text-[11px] ${
                              activeSeries === s.standardName
                                ? "border-[var(--color-brand)] bg-[var(--color-brand-soft)] text-[var(--color-brand)]"
                                : "border-[var(--color-line-strong)] text-[var(--color-ink-2)] hover:bg-[var(--color-hover)]"
                            }`}
                            data-testid={`series-${s.standardName}`}
                          >
                            {s.standardName}
                            <span className="ml-1 text-[10px] text-[var(--color-ink-3)]">{s.points.length}</span>
                          </button>
                        ))}
                      </div>

                      {active && (
                        <div>
                          <div className="mb-1 flex flex-wrap items-baseline gap-2 text-[11px] text-[var(--color-ink-2)]">
                            <span className="text-[13px] font-semibold text-[var(--color-ink)]">{active.standardName}</span>
                            {active.unit && <span className="font-[var(--font-mono)]">{active.unit}</span>}
                            <span>· {active.points.length} 次检测</span>
                            {active.rawNames.length > 1 && (
                              <span className="text-[var(--color-ink-3)]">原文名：{active.rawNames.join(" / ")}</span>
                            )}
                            {active.unitChanged && (
                              <span
                                className="rounded bg-[var(--color-err-soft)] px-1.5 py-0.5 text-[10px] text-[var(--color-err)]"
                                data-testid="unit-changed-warning"
                              >
                                单位跨次不同（数值不可直接比较）
                              </span>
                            )}
                            {active.refChanged && (
                              <span
                                className="rounded bg-[var(--color-warn-soft)] px-1.5 py-0.5 text-[10px] text-[var(--color-warn)]"
                                data-testid="ref-changed-badge"
                              >
                                参考范围跨次变化
                              </span>
                            )}
                          </div>
                          <TrendChart series={active} />
                          <div className="mt-1 flex flex-wrap gap-3 text-[10px] text-[var(--color-ink-3)]">
                            <span>绿色带 = 最新一次的参考范围</span>
                            <span>红点=偏高 / 黄点=偏低 / 蓝点=正常</span>
                          </div>
                          <table className="mt-3 w-full border-collapse text-[11px]">
                            <thead className="text-[var(--color-ink-2)]">
                              <tr className="text-left">
                                <th className="px-2 py-1">检测日期</th>
                                <th className="px-2 py-1">结果</th>
                                <th className="px-2 py-1">参考范围</th>
                                <th className="px-2 py-1">状态</th>
                              </tr>
                            </thead>
                            <tbody>
                              {active.points.map((p) => (
                                <tr key={p.reportId} className="border-t border-[var(--color-line)]">
                                  <td className="px-2 py-1 font-[var(--font-mono)]">{p.checkDate}</td>
                                  <td className="px-2 py-1 font-[var(--font-mono)]">
                                    {p.valueNum}
                                    {p.unit ? ` ${p.unit}` : ""}
                                  </td>
                                  <td className="px-2 py-1 font-[var(--font-mono)]">
                                    {p.refLow ?? "—"}–{p.refHigh ?? "—"}
                                  </td>
                                  <td className="px-2 py-1">
                                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${STATUS_CLASS[p.status]}`}>
                                      {STATUS_LABEL[p.status]}
                                    </span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* 解读 */}
              {tab === "interpret" && (
                <div data-testid="interpret-panel">
                  {series.length === 0 ? (
                    <p className="py-8 text-center text-[12px] text-[var(--color-ink-3)]">先导入报告，再来解读指标。</p>
                  ) : (
                    <>
                      <div className="mb-3 flex flex-wrap gap-1.5">
                        {series.map((s) => (
                          <button
                            key={s.standardName}
                            onClick={() => setInterpretSeries(s.standardName)}
                            className={`rounded-full border px-2.5 py-1 text-[11px] ${
                              interpretSeries === s.standardName
                                ? "border-[var(--color-brand)] bg-[var(--color-brand-soft)] text-[var(--color-brand)]"
                                : "border-[var(--color-line-strong)] text-[var(--color-ink-2)] hover:bg-[var(--color-hover)]"
                            }`}
                            data-testid={`interpret-series-${s.standardName}`}
                          >
                            {s.standardName}
                          </button>
                        ))}
                      </div>
                      <button
                        onClick={() => interpretSeries && void runInterpret(interpretSeries)}
                        disabled={!interpretSeries || interpreting}
                        className="rounded-md bg-[var(--color-brand)] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-40"
                        data-testid="interpret-btn"
                      >
                        {interpreting ? "解读中…" : "解读该指标"}
                      </button>

                      {interpretation && (
                        <div className="mt-3 rounded-md border border-[var(--color-line)] p-3" data-testid="interpret-result">
                          {interpretation.refused ? (
                            <p className="text-[12px] text-[var(--color-warn)]" data-testid="interpret-refused">
                              {interpretation.text}
                            </p>
                          ) : (
                            <>
                              <div className="mb-1 text-[10px] text-[var(--color-ink-3)]">
                                {interpretation.mode === "trend" ? "含义 + 趋势" : "仅含义（数据不足，不判趋势）"}
                              </div>
                              <p className="whitespace-pre-wrap text-[12px] leading-relaxed">{interpretation.text}</p>
                              {interpretation.citations.length > 0 && (
                                <div className="mt-2 border-t border-[var(--color-line)] pt-2">
                                  <div className="mb-1 text-[10px] text-[var(--color-ink-3)]">依据的数据（可核对）</div>
                                  <ul className="space-y-0.5 text-[10px]">
                                    {interpretation.citations.map((c) => (
                                      <li key={c.reportId} className="font-[var(--font-mono)] text-[var(--color-ink-2)]">
                                        {c.checkDate} · {c.valueText}
                                        {c.unit ? ` ${c.unit}` : ""}
                                        {c.refText ? `（参考 ${c.refText}）` : ""} · {STATUS_LABEL[c.status] ?? c.status}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            </>
                          )}
                          <p className="mt-2 border-t border-[var(--color-line)] pt-2 text-[10px] text-[var(--color-ink-3)]">
                            {interpretation.disclaimer}
                          </p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* 手工补录 */}
              {tab === "manual" && (
                <div data-testid="manual-panel">
                  <div className="mb-2 flex items-center gap-2 text-[11px]">
                    <label>检测日期</label>
                    <input
                      ref={manualDateRef}
                      type="date"
                      value={manualDate}
                      onChange={(e) => setManualDate(e.target.value)}
                      className="rounded-md border border-[var(--color-line-strong)] px-2 py-1 text-[11px]"
                      data-testid="manual-date"
                    />
                  </div>
                  <div className="space-y-1.5">
                    {manualRows.map((row, i) => (
                      <div key={i} className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,0.6fr)_minmax(0,0.8fr)_auto] gap-1.5">
                        <input
                          value={row.rawName}
                          onChange={(e) => setManualRows((p) => p.map((r, j) => (j === i ? { ...r, rawName: e.target.value } : r)))}
                          placeholder="指标名（如 甘油三酯）"
                          className="rounded-md border border-[var(--color-line-strong)] px-2 py-1 text-[11px]"
                          data-testid={`manual-name-${i}`}
                        />
                        <input
                          value={row.valueText}
                          onChange={(e) => setManualRows((p) => p.map((r, j) => (j === i ? { ...r, valueText: e.target.value } : r)))}
                          placeholder="结果（如 2.31）"
                          className="rounded-md border border-[var(--color-line-strong)] px-2 py-1 text-[11px] font-[var(--font-mono)]"
                          data-testid={`manual-value-${i}`}
                        />
                        <input
                          value={row.unit}
                          onChange={(e) => setManualRows((p) => p.map((r, j) => (j === i ? { ...r, unit: e.target.value } : r)))}
                          placeholder="单位"
                          className="rounded-md border border-[var(--color-line-strong)] px-2 py-1 text-[11px]"
                          data-testid={`manual-unit-${i}`}
                        />
                        <input
                          value={row.refText}
                          onChange={(e) => setManualRows((p) => p.map((r, j) => (j === i ? { ...r, refText: e.target.value } : r)))}
                          placeholder="参考范围（如 0.45-1.7）"
                          className="rounded-md border border-[var(--color-line-strong)] px-2 py-1 text-[11px] font-[var(--font-mono)]"
                          data-testid={`manual-ref-${i}`}
                        />
                        <button
                          onClick={() => setManualRows((p) => (p.length > 1 ? p.filter((_, j) => j !== i) : p))}
                          className="rounded border border-[var(--color-line-strong)] px-2 text-[11px]"
                          data-testid={`manual-remove-${i}`}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      onClick={() => setManualRows((p) => [...p, { rawName: "", valueText: "", unit: "", refText: "" }])}
                      className="rounded-md border border-[var(--color-line-strong)] px-2 py-1 text-[11px]"
                      data-testid="manual-add-row"
                    >
                      + 加一行
                    </button>
                    <button
                      onClick={() => void saveManual()}
                      disabled={manualSaving}
                      className="rounded-md bg-[var(--color-brand)] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-40"
                      data-testid="manual-save-btn"
                    >
                      {manualSaving ? "保存中…" : "保存补录"}
                    </button>
                    <span className="text-[10px] text-[var(--color-ink-3)]">
                      同一天多次补录会合并为同一份手工报告
                    </span>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>

        <footer className="mt-4 text-[10px] leading-relaxed text-[var(--color-ink-3)]">
          数据只存放在本产品自己的 Cloudflare D1 实例中，不接入任何第三方分析或上报服务。
          本产品只做指标含义与趋势说明，不做诊断、不提供用药建议；指标异常或身体不适请及时就医。
        </footer>
      </div>
    </div>
  );
}