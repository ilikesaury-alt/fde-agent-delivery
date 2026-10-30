/**
 * 报告文本 → 结构化指标（LLM 抽取 + 强校验 + 重试）。
 *
 * ⭐ 本文件最重要的设计决策（CONTEXT 方案「推荐方案」）：
 *   **LLM 只负责「转录」，不做任何计算。**
 *   模型只输出它从原文看到的：指标名、原文值、单位、参考范围原文、原文片段。
 *   value_num / ref_low / ref_high / standard_name / status 全部由**服务端确定性计算**
 *   （parseValueNum / parseRefRange / normalizeMetricName / determineStatus）。
 *
 * 为什么：如果让模型自己给 status（「偏高/正常」），错误就无从复核 —— 模型算错一位
 * 就是医疗数据事故，而且不可测。转录 + 服务端计算 = 每一条结论都能用单测固定住，
 * 模型出错只会「抄错原文」，而抄错原文有 source_quote 对照 + 人工确认闸兜底。
 */

import { ERR, ExtractError } from "./errors.ts";
import { MAX_FIELD_CHARS } from "./http.ts";
import { callLLM, LLMError, MissingConfigError, type ChatMessage, type LLMEnv } from "./llm.ts";
import { normalizeMetricName } from "./metrics-dict.ts";
import { cleanValueText, determineStatus, parseRefRange, parseValueBound, parseValueNum } from "./trend.ts";
import type { ExtractedMetric, ExtractedReport } from "./types.ts";

/** 电子版报告文本上限（Void env 可覆盖）：超长直接拒绝，不做静默截断（截断会漏掉指标） */
export const DEFAULT_MAX_REPORT_CHARS = 60_000;
/** 单份报告最多接受的指标条数（防御模型输出爆炸） */
export const MAX_METRICS_PER_REPORT = 300;
/** 抽取重试次数（首次 + 重试） */
export const DEFAULT_EXTRACT_RETRY = 1;

export type ExtractOptions = {
  fetchImpl?: typeof fetch;
  /** 覆盖文本上限 */
  maxChars?: number;
  /** 重试次数（0 = 不重试） */
  retry?: number;
};

/* ────────────────────────── prompt ────────────────────────── */

const SYSTEM_PROMPT = `你是体检报告结构化助手。你的唯一任务是从报告文本中**逐字转录**指标信息。

严格规则：
1. 只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块标记。
2. 只转录原文中真实出现的内容。原文没有的字段一律用 null，**绝不推测、绝不补全**。
3. 不要计算、不要判断正常/异常、不要给出建议 —— 你只做转录。
4. value_text 必须与原文写法完全一致（例如 "5.31"、"<0.01"、"阴性"、">1000"）。
5. ref_text 必须与原文参考范围写法完全一致（例如 "3.5-5.5"、"≤100"、"阴性"）。
6. source_quote 必须是从原文**原样截取**的一个连续片段（包含该指标名与值），用于人工复核。
7. check_date 取报告上的「采样日期/检测日期/报告日期」，格式 YYYY-MM-DD；原文只有
   年月日中文写法时也要转成该格式；确实找不到则用 null。
8. 定性指标（阴性/阳性/未见异常）照原样转录到 value_text，不要转成数字。
9. 只转录**检验项目表格里的行**。页眉页脚、患者信息（姓名/性别/年龄/病历号/诊号/条码）、
   科室/标本/医师、时间戳（申请/采集/接收/报告时间）、联系电话、地址、声明/备注、
   「第N页 共N页」等**一律不要**当成指标。这些字段不是检验结果，混进来会变成假指标。
10. 扫描件文本常把同一个项目的「名称/结果/单位/参考范围」**拆到相邻多行**（尤其 OCR 结果）。
    遇到这种情况要按原文顺序把它们归回同一条指标；不要因为字段分行就整行丢弃。

输出 JSON 结构：
{
  "check_date": "YYYY-MM-DD" | null,
  "hospital": string | null,
  "metrics": [
    {
      "raw_name": string,          // 原文指标名，一字不改
      "value_text": string,        // 原文值
      "unit": string | null,       // 原文单位
      "ref_text": string | null,   // 原文参考范围
      "source_quote": string       // 原文连续片段
    }
  ]
}`;

function userPrompt(rawText: string): string {
  return `以下是体检报告原文，请转录其中的全部指标项（包括正常与异常，不要遗漏）：

<<<报告开始
${rawText}
报告结束>>>`;
}

/* ────────────────────── JSON 解析与校验 ────────────────────── */

/**
 * 从模型输出中取出 JSON 对象。
 * 三种常见脏输出都要能活下来：```json 代码块包裹、前后有解释文字、纯 JSON。
 */
export function parseJsonLoose(content: string): unknown {
  let s = content.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  if (fence) s = fence[1].trim();
  if (!s.startsWith("{")) {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) s = s.slice(start, end + 1);
  }
  return JSON.parse(s);
}

/** 截断到上限（null 保持 null；用于防超长垃圾进库） */
function clip(v: string | null, max: number = MAX_FIELD_CHARS): string | null {
  if (v == null) return null;
  return v.length > max ? v.slice(0, max) : v;
}

function asString(v: unknown): string | null {
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? null : t;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** 日期宽松接受 `2025-3-4` / `2025/03/04` / `2025年3月4日`，统一成 YYYY-MM-DD */
export function normalizeDate(v: unknown): string | null {
  const s = asString(v);
  if (!s) return null;
  const m = /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${y}-${pad(mo)}-${pad(d)}`;
}

/** 原始一行（模型输出的形状，字段宽松） */
type RawMetric = Record<string, unknown>;

/**
 * 把模型的一行转成领域指标行。
 * 返回 null = 该行不可用（缺名字或值）→ 丢弃，但**不因此让整份报告失败**
 * （报告常有表头/注释行被误认，丢一行比丢整份好）。
 */
export function toExtractedMetric(raw: RawMetric): ExtractedMetric | null {
  // 同时认 snake_case（模型输出 / 预览接口）与 camelCase（前端回传确认行）：
  // 前端把预览里勾选的行原样回传，字段名是 camelCase；只认 snake_case 会让
  // 「确认入库」把全部行判成无效 → 400（本地实测踩过）。
  const rawName = asString(raw.raw_name) ?? asString(raw.rawName) ?? asString(raw.name) ?? asString(raw.item);
  const valueText =
    asString(raw.value_text) ?? asString(raw.valueText) ?? asString(raw.value) ?? asString(raw.result);
  if (!rawName || !valueText) return null;

  const standardName = normalizeMetricName(rawName);
  if (standardName === "") return null;

  const unit = clip(asString(raw.unit));
  const refText =
    asString(raw.ref_text) ?? asString(raw.refText) ?? asString(raw.ref) ?? asString(raw.reference);
  const ref = parseRefRange(refText);
  // 值里可能带 ↑↓ 方向标记（报告常见写法）：剥掉后再算数值与状态，
  // 否则「偏高」会被算成「无法判断」（评测实测）。
  const cleanValue = cleanValueText(valueText) || valueText;
  const valueNum = parseValueNum(cleanValue);
  const sourceQuote = clip(
    asString(raw.source_quote) ?? asString(raw.sourceQuote) ?? asString(raw.quote),
    600,
  );

  return {
    standardName: clip(standardName) ?? standardName,
    rawName: clip(rawName) ?? rawName,
    valueNum,
    valueText: clip(cleanValue) ?? cleanValue,
    unit,
    refLow: ref?.low ?? null,
    refHigh: ref?.high ?? null,
    refText: clip(refText, 200),
    // 状态由服务端算 —— 绝不信任模型给的 status
    status: determineStatus(valueNum, ref, parseValueBound(valueText)),
    sourceQuote,
  };
}

/**
 * 校验并归一模型输出的整体结构。
 * 失败抛 ExtractError('extractInvalid') —— 调用方据此决定是否重试。
 */
export function validateExtracted(data: unknown): ExtractedReport {
  if (data == null || typeof data !== "object") {
    throw new ExtractError("extractInvalid");
  }
  const obj = data as Record<string, unknown>;

  // 日期只是**建议值**：确认识别不到的日期不该毁掉整次抽取 ——
  // 真实报告实测（扫描件丢失页脚时间块）就栽在这里：指标全都抽出来了，
  // 却因为 check_date 为 null 被整份丢弃（真缺陷）。日期由用户在确认闸补填，不猜。
  const checkDate = normalizeDate(obj.check_date ?? obj.checkDate ?? obj.date);

  const rawMetrics = obj.metrics ?? obj.items ?? obj.indicators;
  if (!Array.isArray(rawMetrics) || rawMetrics.length === 0) {
    throw new ExtractError("extractFailed");
  }

  const metrics: ExtractedMetric[] = [];
  const seen = new Set<string>();
  for (const item of rawMetrics.slice(0, MAX_METRICS_PER_REPORT)) {
    if (item == null || typeof item !== "object") continue;
    const m = toExtractedMetric(item as RawMetric);
    if (!m) continue;
    // 同一份报告内同名指标去重（模型偶尔把一行抄两遍）；保留首次出现的
    const key = `${m.rawName}|${m.valueText}`;
    if (seen.has(key)) continue;
    seen.add(key);
    metrics.push(m);
  }

  if (metrics.length === 0) throw new ExtractError("extractFailed");

  const hospital = asString(obj.hospital) ?? asString(obj.institution);
  return { checkDate, hospital, metrics };
}

/* ────────────────────────── 主流程 ────────────────────────── */

function assertText(rawText: string, maxChars: number): void {
  if (typeof rawText !== "string" || rawText.trim() === "") {
    throw new ExtractError("emptyText");
  }
  if (rawText.length > maxChars) {
    throw new ExtractError("tooLong", `${ERR.tooLong}（上限 ${maxChars} 字符，当前 ${rawText.length}）`);
  }
}

/**
 * 抽取主流程：文本 → JSON → 校验 → (失败重试) → ExtractedReport。
 *
 * 重试只对「解析/校验失败」做；上游错误（401/429/5xx）不重试 —— 重试上游错误
 * 只会放大限流（②③ 的教训），交路由映射状态码。
 */
export async function extractReport(
  env: LLMEnv,
  rawText: string,
  opts: ExtractOptions = {},
): Promise<ExtractedReport> {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_REPORT_CHARS;
  assertText(rawText, maxChars);

  const retries = Math.max(0, Math.trunc(opts.retry ?? DEFAULT_EXTRACT_RETRY));
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt(rawText) },
  ];

  let lastInvalid: ExtractError | null = null;
  let budget = retries;
  for (let attempt = 0; attempt <= budget; attempt++) {
    let content: string;
    try {
      content = await callLLM(env, messages, {
        temperature: 0.1,
        maxTokens: 8_000,
        fetchImpl: opts.fetchImpl,
      });
    } catch (err) {
      if (err instanceof MissingConfigError) throw err;
      if (err instanceof LLMError) {
        // 上游「200 但空内容」是退化响应（真实报告实测 84s 后返回空），瞬时性质，
        // 原实现直接失败 → 一次抖动就毁掉整次抽取。这里给它**一次**额外机会，
        // 且不吞掉用户可见的错误文案；错误码类失败仍不重试（②③ 的限流教训）。
        if (err.reason === "empty" && attempt === 0) {
          console.warn("[extract] empty content, retrying once");
          budget = Math.max(budget, 1);
          continue;
        }
        throw new ExtractError("extractFailed", err.message);
      }
      throw err;
    }

    try {
      return validateExtracted(parseJsonLoose(content));
    } catch (err) {
      const e = err instanceof ExtractError ? err : new ExtractError("extractInvalid");
      // 记一行日志便于排查「模型输出长什么样」，但不把它带进用户文案
      console.warn(`[extract] attempt ${attempt + 1} invalid: ${e.code}: ${content.slice(0, 200)}`);
      lastInvalid = e;
    }
  }

  throw lastInvalid ?? new ExtractError("extractFailed");
}