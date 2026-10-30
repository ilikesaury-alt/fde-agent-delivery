/**
 * 趋势与异常判定 —— 纯函数层（无 IO、无 env，全部可单测）。
 *
 * 本文件承载产品④最核心的一条纪律（CONTEXT D4 + 高风险应对）：
 *   **参考范围解析不出，就绝不判异常。**
 * 理由：不同医院/方法学的参考范围格式千奇百怪（`3.5-5.5`、`≤100`、`阴性`、
 * 「未见异常」、`0~10^9/L`），任何「猜一个标准范围」的做法都会给出**错误的异常结论**，
 * 而健康数据上的错误结论比没有结论更糟。所以解析失败一律 status='unknown'。
 */

import type { Metric, MetricStatus, TrendPoint, TrendSeries } from "./types.ts";

export type RefRange = {
  low: number | null;
  high: number | null;
  /** 下限是「严格大于」（`>x`）：值恰等于下限时**不在**范围内 */
  lowStrict?: boolean;
  /** 上限是「严格小于」（`<x`）：值恰等于上限时**不在**范围内 */
  highStrict?: boolean;
};

/** 全角/异体符号归一：都折成 ASCII，避免为每个变体写一条正则 */
function foldSymbols(s: string): string {
  return s
    // ＜ / ＞ 是严格比较；≦ ⩽ / ≧ ⩾ 是「小于等于 / 大于等于」（非严格）。
    // 混为一谈会让「值恰等于界限」的判定反掉（审查与单测都抓过）。
    .replace(/[≦⩽]/g, "<=")
    .replace(/[≧⩾]/g, ">=")
    .replace(/[＜]/g, "<")
    .replace(/[＞]/g, ">")
    .replace(/[≤]/g, "<=")
    .replace(/[≥]/g, ">=")
    .replace(/[－−–—〜]/g, "-")
    .replace(/[～﹏]/g, "~")
    .replace(/，/g, ",")
    .trim();
}

const NUM = String.raw`(-?\d+(?:\.\d+)?)`;

/** 区间：`3.5-5.5` / `3.5~5.5` / `3.5 至 5.5` / `0-10^9/L`（尾部单位忽略） */
const RANGE_RE = new RegExp(String.raw`^${NUM}\s*(?:-|~|至|到)\s*${NUM}`);
/**
 * 上限：`<=100` / `<100` / `≤100`（fold 后等价）。
 * ⚠️ 必须用「非捕获组」写法：写成 `^<=NUM|^<NUM` 会产生两个捕获组，
 * 走第二个分支时 m[1] 是 undefined → Number(undefined) 得 NaN → 静默返回 null（实测踩过）。
 * 括号1 = 运算符（用来区分 `<` 与 `<=` 的严格性），括号2 = 数值。
 */
const UPPER_RE = new RegExp(String.raw`^(<=|<)\s*${NUM}`);
/** 下限：`>=1.0` / `>1.0`（同上，带运算符捕获） */
const LOWER_RE = new RegExp(String.raw`^(>=|>)\s*${NUM}`);

/**
 * 参考范围里出现**分区**（男/女/儿童/成人/孕期）时放弃解析。
 * 真实报告常写「130-175（男） 115-150（女）」，而我们没有性别字段可择一 ——
 * 随便取第一段就会给另一半用户判出**错误的异常结论**（D4：宁缺毋滥）。
 */
const PARTITION_RE = /男|女|儿童|成人|孕|新生儿|老年/;
/**
 * 范围后面跟了**数量级**（`0-10^9/L`、`100-300×10^9/L`、`2-10e3`）时也放弃。
 * 取到 `{0,10}` 会与 value 差 9 个数量级 —— 解析「成功」但结论全错，比返回 null 更危险。
 */
const SCALE_RE = /[\^×xX]\s*10|\b10\s*\^|e\s*[+-]?\s*\d/;
/** 中文上限：`100以下` / `100以内` */
const UPPER_CN_RE = new RegExp(String.raw`^${NUM}\s*(?:以下|以内)`);
/** 中文下限：`1.0以上` / `1.0起` */
const LOWER_CN_RE = new RegExp(String.raw`^${NUM}\s*(?:以上|起)`);

/**
 * 解析参考范围原文 → 结构化上下限。
 * 返回 null 表示**无法可靠解析**（定性指标、文字描述、格式罕见）→ 调用方必须判 unknown。
 */
export function parseRefRange(refText: string | null | undefined): RefRange | null {
  if (!refText) return null;
  const s = foldSymbols(refText);
  if (s === "") return null;

  // 分区（男/女/孕/儿童…）与数量级（10^9/L 等）**一律放弃解析** —— 见常量注释
  if (PARTITION_RE.test(s)) return null;
  if (SCALE_RE.test(s)) return null;

  const range = RANGE_RE.exec(s);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    // 写反的区间（`5.5-3.5`）不静默交换：交换等于替报告「猜」一个范围，
    // 而报告里的反序更可能是抄写/抽取错误。宁可不判（D4）。
    if (a >= b) return null;
    return { low: a, high: b };
  }

  const upper = UPPER_RE.exec(s);
  if (upper) {
    const v = Number(upper[2]);
    if (!Number.isFinite(v)) return null;
    return { low: null, high: v, highStrict: upper[1] === "<" };
  }
  const upperCn = UPPER_CN_RE.exec(s);
  if (upperCn) {
    const v = Number(upperCn[1]);
    return Number.isFinite(v) ? { low: null, high: v } : null;
  }

  const lower = LOWER_RE.exec(s);
  if (lower) {
    const v = Number(lower[2]);
    if (!Number.isFinite(v)) return null;
    return { low: v, high: null, lowStrict: lower[1] === ">" };
  }
  const lowerCn = LOWER_CN_RE.exec(s);
  if (lowerCn) {
    const v = Number(lowerCn[1]);
    return Number.isFinite(v) ? { low: v, high: null } : null;
  }

  return null;
}

/**
 * 判定状态。**三处宁缺毋滥**：
 *   1. 无数值（定性指标「阴性」/「<0.01」）→ unknown（画不出趋势点，也不该判异常）
 *   2. 无可用范围（解析失败）→ unknown
 *   3. 范围自身异常（low > high）→ unknown
 */
export function determineStatus(
  valueNum: number | null,
  range: RefRange | null,
  bound?: ValueBound | null,
): MetricStatus {
  if (valueNum == null || !Number.isFinite(valueNum)) {
    // 界值（`<2.000` / `>5.00`）不是数值，但**有些情况可以确定结论**：
    //   value < n 且 n <= 下限  → 必然低于下限 → low
    //   value > n 且 n >= 上限  → 必然高于上限 → high
    // 其余仍是 unknown（值落在区间内两侧都可能，猜就是错）。
    // 真实报告（乙肝五项 `>5.00` 参考 0-0.15，原报告已标 ↑）就吃到这条：不判就漏。
    if (bound && range) {
      const { low, high } = range;
      if (low != null && high != null && low > high) return "unknown";
      if (bound.op === "<" && low != null && bound.n <= low) return "low";
      if (bound.op === ">" && high != null && bound.n >= high) return "high";
    }
    return "unknown";
  }
  if (!range) return "unknown";
  const { low, high } = range;
  if (low == null && high == null) return "unknown";
  if (low != null && high != null && low > high) return "unknown";
  // 严格界限（`<x` / `>x`）：值恰等于界限时**不在**范围内 → 判异常。
  // 报告写「空腹血糖 <6.1」而值正好 6.1，原报告已标 ↑，我们判 normal 就是漏判。
  if (high != null && (valueNum > high || (range.highStrict && valueNum === high))) return "high";
  if (low != null && (valueNum < low || (range.lowStrict && valueNum === low))) return "low";
  return "normal";
}

/**
 * 剥掉值尾部的「方向标记」：`2.31 ↑` / `0.21↓` / `4.2 *`。
 *
 * 为什么必须剥（线上评测实测）：报告常用箭头标异常，模型照原样转录成 `2.31 ↑`，
 * 于是 parseValueNum 判成「非数值」→ status 变 unknown —— 一个**偏高**的指标被显示成
 * 「无法判断」，比没标异常更糟（违背 D4 的宁缺毋滥本意：不判错，但不能该判的不判）。
 * 箭头表达的信息由 status 承载，不需要留在值里。
 */
export function cleanValueText(valueText: string): string {
  return valueText.replace(/[↑↓⇧⇩*＊]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * 原文值 → 数值。只接受**纯数值**（可带正负号与小数）；
 * `<0.01`、`阴性`、`±` 之类返回 null —— 它们不是可绘制的点（诚实标注，不插值）。
 */
/** 界值：`<2.000` 表示「小于 2」，`>5.00` 表示「大于 5」（不做插值） */
export type ValueBound = { op: "<" | ">"; n: number };

/** 原文值 → 界值（只有 `<`/`>` 才算；`≤`/`≥` 仍按非严格处理成 `<=x` 时也当界值） */
export function parseValueBound(valueText: string): ValueBound | null {
  const s = foldSymbols(cleanValueText(valueText)).replace(/,/g, "").trim();
  const m = /^(<=|<|>=|>)\s*(-?\d+(?:\.\d+)?)$/.exec(s);
  if (!m) return null;
  const n = Number(m[2]);
  if (!Number.isFinite(n)) return null;
  return { op: m[1].startsWith("<") ? "<" : ">", n };
}

export function parseValueNum(valueText: string): number | null {
  const s = foldSymbols(cleanValueText(valueText)).replace(/,/g, "").trim();
  if (s === "") return null;
  const m = /^[+-]?\d+(?:\.\d+)?$/.exec(s);
  if (!m) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export type TrendInput = { metric: Metric; checkDate: string };

/**
 * 按标准指标聚合趋势。
 *
 * 只收录**可绘制**的点（valueNum 非空）；某次报告若该指标是定性值（阴性），
 * 该次不产生点 —— 前端需要能看出「这次没测/不可比」，所以不补 0、不插值。
 * points 按检测日期升序（图表 x 轴从左到右）。
 */
export function buildTrend(inputs: TrendInput[]): TrendSeries[] {
  const groups = new Map<string, TrendSeries>();

  for (const { metric, checkDate } of inputs) {
    if (metric.valueNum == null || !Number.isFinite(metric.valueNum)) continue;
    let series = groups.get(metric.standardName);
    if (!series) {
      series = {
        standardName: metric.standardName,
        rawNames: [],
        unit: null,
        points: [],
        refChanged: false,
        unitChanged: false,
      };
      groups.set(metric.standardName, series);
    }
    if (!series.rawNames.includes(metric.rawName)) series.rawNames.push(metric.rawName);
    if (series.unit == null && metric.unit) series.unit = metric.unit;

    const point: TrendPoint = {
      reportId: metric.reportId,
      checkDate,
      valueNum: metric.valueNum,
      unit: metric.unit,
      refLow: metric.refLow,
      refHigh: metric.refHigh,
      status: metric.status,
    };
    series.points.push(point);
  }

  for (const series of groups.values()) {
    series.points.sort((a, b) => (a.checkDate < b.checkDate ? -1 : a.checkDate > b.checkDate ? 1 : 0));
    // 参考范围变化可见（D4）：同一序列里出现不同的 (low, high) 组合即标记
    const seen = new Set<string>();
    const units = new Set<string>();
    for (const p of series.points) {
      seen.add(`${p.refLow ?? ""}|${p.refHigh ?? ""}`);
      if (p.unit) units.add(p.unit);
    }
    series.refChanged = seen.size > 1;
    // 单位不同 = 数值尺度不同 → 折线不可比，必须显式告警（不能静默画到一起）
    series.unitChanged = units.size > 1;
  }

  // 输出顺序稳定：点多的在前，其次按标准名字典序（码点序，跨平台确定）
  return [...groups.values()].sort(
    (a, b) => b.points.length - a.points.length || (a.standardName < b.standardName ? -1 : a.standardName > b.standardName ? 1 : 0),
  );
}

/** 一次报告内的异常指标（前端摘要用） */
export function abnormalMetrics(metrics: Metric[]): Metric[] {
  return metrics.filter((m) => m.status === "high" || m.status === "low");
}