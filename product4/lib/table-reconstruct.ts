/**
 * 表格重建：OCR 检测框 → 表格行（**纯函数，不依赖 DOM / 模型**）。
 *
 * 背景（2026-10-29 真实报告实测）：
 *   视觉大模型整页一次性读，会把「值、指标名、单位」错位（78.440 落到 HBsAb 上），
 *   而 PP-OCR 给的是**带坐标的文本框**。所以正确做法不是让模型更聪明，
 *   而是拿坐标做确定性重建：按 y 聚行、按表头 x 区间定列 —— 错行从结构上消失。
 *
 * 三条纪律：
 *   1. 不猜：认不出表头就退回「按 x 排序的顺序」并**标记为不可靠**（`reliable: false`）
 *   2. 不删：低置信度框保留但记 `score`，由上层决定提示（人对不上时能看到原文）
 *   3. 不并：高度异常框（序号列的竖框、整列竖排文字）会被剔除 —— 实测它会把两行并成一行
 */

/** OCR 出来的一个文本框（坐标系与源图一致，左上原点） */
export type TableLine = {
  text: string;
  score: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

/** 聚好的一行：`midY` 用于排序，`cells` 已按 x0 升序 */
export type TableRow = { midY: number; height: number; cells: TableLine[] };

/** 表头识别出的列（key 是语义名，x 区间用于把单元格归列） */
export type TableColumn = { key: string; label: string; x0: number; x1: number };

export type ReconstructedRow = {
  /** 语义列 → 文本（未识别的列为空字符串） */
  cells: Record<string, string>;
  /** 该行原始单元格（按 x 排序），便于人工核对/调试 */
  raw: string[];
  /** 该行最低置信度（用于提示「此行可能不准」） */
  minScore: number;
};

export type ReconstructResult = {
  rows: ReconstructedRow[];
  /** 是否识别到表头列（false 时 rows 只按顺序切，列语义不可信） */
  reliable: boolean;
  columns: TableColumn[];
  /** 被剔除的异常框数量（高度离群） */
  droppedLines: number;
};

const DEFAULT_MAX_HEIGHT_FACTOR = 1.8;
const DEFAULT_ROW_TOLERANCE_FACTOR = 0.6;

/**
 * 表头关键词 → 语义列。顺序即优先级（先匹配先得）。
 * 真实报告的表头写法差异很大，这里只收**能确定含义**的词：
 * 认不出就不认（`reliable: false`），交给上层提示人工核对。
 */
const HEADER_PATTERNS: Array<{ key: string; re: RegExp }> = [
  { key: "index", re: /^(序号|编号|No\.?|#)$/i },
  { key: "name", re: /项目(名称|名)?|检验项目|测试项目|项目$/ },
  { key: "cname", re: /中文(名称|名)|项目中文/ },
  { key: "value", re: /^(结果|结果值|测定值|检测值|数值|浓度)$/ },
  { key: "unit", re: /^(单位|计量单位)$/ },
  { key: "ref", re: /参考(区间|范围|值)|正常(范围|值|参考)/ },
  { key: "flag", re: /^(提示|异常|标记|箭头|↑↓)$/ },
];

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * 按 y 坐标聚行。
 *
 * 两个实测细节（真实报告）：
 *   - 序号列「1 2 3 4 5 6」被识别成**一个竖长框**（y 344→526），若不剔除，
 *     它的 midY 会成为一个「磁铁」，把相邻两行吸进来 → 两行并成一行；
 *   - 阈值必须相对**中位行高**，写死像素值换个分辨率就崩。
 */
export function clusterRows(lines: TableLine[], opts: { maxHeightFactor?: number; toleranceFactor?: number } = {}): {
  rows: TableRow[];
  droppedLines: number;
} {
  const usable = lines.filter((l) => l.text.trim() !== "");
  if (usable.length === 0) return { rows: [], droppedLines: 0 };

  const heights = usable.map((l) => l.y1 - l.y0);
  const medH = median(heights) || 1;
  const maxH = medH * (opts.maxHeightFactor ?? DEFAULT_MAX_HEIGHT_FACTOR);
  const tol = medH * (opts.toleranceFactor ?? DEFAULT_ROW_TOLERANCE_FACTOR);

  const kept = usable.filter((l) => l.y1 - l.y0 <= maxH);
  const droppedLines = usable.length - kept.length;

  const rows: TableRow[] = [];
  for (const line of [...kept].sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2)) {
    const midY = (line.y0 + line.y1) / 2;
    const last = rows[rows.length - 1];
    if (last && midY - last.midY <= tol) {
      last.cells.push(line);
      // 行中位随成员更新，避免首元素偏上把后续行吸进来
      last.midY = median(last.cells.map((c) => (c.y0 + c.y1) / 2));
      last.height = Math.max(last.height, line.y1 - line.y0);
    } else {
      rows.push({ midY, height: line.y1 - line.y0, cells: [line] });
    }
  }
  for (const row of rows) row.cells.sort((a, b) => a.x0 - b.x0);
  return { rows, droppedLines };
}

/** 在一行里识别表头列（识别失败返回 null） */
export function detectColumns(row: TableRow): TableColumn[] | null {
  const found: TableColumn[] = [];
  for (const cell of row.cells) {
    const text = cell.text.trim();
    const hit = HEADER_PATTERNS.find((p) => p.re.test(text));
    if (!hit) continue;
    if (found.some((c) => c.key === hit.key)) continue;
    found.push({ key: hit.key, label: text, x0: cell.x0, x1: cell.x1 });
  }
  // 至少要能定位「名称 + 结果」，否则列语义不可信
  const hasName = found.some((c) => c.key === "name" || c.key === "cname");
  const hasValue = found.some((c) => c.key === "value");
  if (!hasName || !hasValue) return null;
  return found.sort((a, b) => a.x0 - b.x0);
}

/**
 * 找一个单元格属于哪一列：用**列边界**判定（列 x 区间按相邻表头中线切开），
 * 而不是「离哪个表头中心最近」—— 后者在合并单元格/长文本时会跳到隔壁列。
 */
export function columnBounds(columns: TableColumn[], imageWidth?: number): Array<{ key: string; lo: number; hi: number }> {
  const sorted = [...columns].sort((a, b) => a.x0 - b.x0);
  return sorted.map((col, i) => {
    const prev = sorted[i - 1];
    const next = sorted[i + 1];
    const lo = prev ? (prev.x1 + col.x0) / 2 : 0;
    const hi = next ? (col.x1 + next.x0) / 2 : imageWidth ?? col.x1 * 2;
    return { key: col.key, lo, hi };
  });
}

/**
 * 纯粹的「方向标记」单元格：`↑` `↓` `⇑` `H` `L` `+` `-` 之类。
 *
 * 真实报告里它是单独一列（提示/箭头），但表头可能认不出来 —— 那就按**内容**认，
 * 否则它会落进「单位」列，变成 `↑ mmol/L`（实测踩过）。
 * 箭头表达的信息由服务端「值 vs 参考范围」重新算出来，不需要它留在文本里。
 */
const FLAG_ONLY_RE = /^[↑↓⇧⇩⇑⇓HL+\-*＊]{1,3}$/u;

export function isFlagOnly(text: string): boolean {
  const t = text.replace(/\s/g, "");
  return t !== "" && FLAG_ONLY_RE.test(t);
}

function classifyCell(line: TableLine, bounds: Array<{ key: string; lo: number; hi: number }>): string {
  const text = line.text.trim();
  if (isFlagOnly(text)) return "flag";
  const center = (line.x0 + line.x1) / 2;
  const exact = bounds.find((b) => center >= b.lo && center < b.hi);
  if (exact) return exact.key;
  // 中心落在所有列之外（超宽单元格/水印）：按重叠面积归列，仍不中就丢给 name
  let best: { key: string; overlap: number } | null = null;
  for (const b of bounds) {
    const overlap = Math.min(line.x1, b.hi) - Math.max(line.x0, b.lo);
    if (overlap > 0 && (!best || overlap > best.overlap)) best = { key: b.key, overlap };
  }
  return best?.key ?? "name";
}

/**
 * 表格重建主入口。
 *
 * `imageWidth` 用于最后一列的右边界（虚拟列表里常缺右侧表头）。
 * 没有识别到表头 → 仍按 y 聚行返回 `raw`，但 `reliable: false`（上层必须提示人工核对）。
 */
export function reconstructTable(
  lines: TableLine[],
  opts: { imageWidth?: number; maxHeightFactor?: number; toleranceFactor?: number } = {},
): ReconstructResult {
  const { rows, droppedLines } = clusterRows(lines, opts);

  // 表头可能在最上面若干行里（前面常有标题/科室/患者信息）
  let headerRow: TableRow | null = null;
  let columns: TableColumn[] | null = null;
  for (const row of rows.slice(0, 12)) {
    const cols = detectColumns(row);
    if (cols) {
      headerRow = row;
      columns = cols;
      break;
    }
  }

  const startIdx = headerRow ? rows.indexOf(headerRow) + 1 : 0;
  const bounds = columns ? columnBounds(columns, opts.imageWidth) : [];

  const out: ReconstructedRow[] = [];
  for (const row of rows.slice(startIdx)) {
    if (columns) {
      const cells: Record<string, string> = {};
      for (const cell of row.cells) {
        const key = classifyCell(cell, bounds);
        const raw = cell.text.trim();
        const text = key === "unit" ? normalizeUnitText(raw) : raw;
        cells[key] = cells[key] ? `${cells[key]} ${text}` : text;
      }
      out.push({
        cells,
        raw: row.cells.map((c) => c.text.trim()),
        minScore: Math.min(...row.cells.map((c) => c.score)),
      });
    } else {
      out.push({
        cells: { name: row.cells[0]?.text?.trim() ?? "", value: row.cells[1]?.text?.trim() ?? "" },
        raw: row.cells.map((c) => c.text.trim()),
        minScore: Math.min(...row.cells.map((c) => c.score)),
      });
    }
  }

  return { rows: out, reliable: columns !== null, columns: columns ?? [], droppedLines };
}

/**
 * 把重建结果转成喂给抽取的文本（每行一条，列序固定）。
 * 为什么还要转文本：抽取链路（LLM 转录 + 服务端算状态 + 人工确认闸）保持不变，
 * 扫描件只是「取文本」的一种手段（CONTEXT D2），不要为它开第二条结构化路径。
 */
export function rowsToText(result: ReconstructResult, opts: { header?: boolean } = {}): string {
  const keys = result.columns.map((c) => c.key);
  const order = ["name", "cname", "value", "unit", "ref"].filter((k) => keys.includes(k));
  const useKeys = order.length >= 2 ? order : ["name", "value"];
  const header = opts.header === false ? [] : [useKeys.map((k) => columnLabel(k)).join(" | ")];
  const body = result.rows
    .filter((r) => isMetricRow(r.cells))
    .map((r) => useKeys.map((k) => (r.cells[k] ?? "").trim()).join(" | "));
  if (header.length === 0) return body.join("\n");
  return [header[0], ...body].join("\n");
}

/**
 * 单位里 OCR 常见混淆修正：`IU/m1` → `IU/ml`、`lU/ml` → `IU/ml`。
 * 这不是「猜」：`m1` 不是任何合法单位，`ml` 才是；字母 l 与数字 1 在低分辨率扫描里极易混。
 * 只改**能确定**的替换，不碰大小写语义（`IU` 与 `iu` 是不同写法，但都合法）。
 */
export function normalizeUnitText(unit: string): string {
  return unit
    .replace(/\s+/g, "")
    .replace(/l(?=U)/g, "I") // lU → IU
    .replace(/m1(?![a-zA-Z])/g, "ml")
    .replace(/mI(?![a-zA-Z])/g, "ml")
    .replace(/1U/g, "IU");
}

/**
 * 从**全部**识别行里找报告日期（含被 `isMetricRow` 过滤掉的页脚）。
 *
 * 为什么需要单独找：表格下面的「采集时间 / 报告时间」是好日期的**唯一来源**，
 * 但它们同时是「不该进抽取文本的噪声」。所以两件事分开做 ——
 * 页脚不进指标行，但日期用一条 `检测日期：YYYY-MM-DD` 干净地补回去。
 * 没有它，趋势图会把每次导入都堆到「今天」（实测：真实扫描件那天就发生了）。
 *
 * 优先级：采集/检测/采样（真正的检测时刻） > 报告/打印（出具时刻） > 申请（开单时刻）。
 * 都不认就返回 null —— 不猜日期。
 */
const DATE_PATTERNS: Array<{ weight: number; re: RegExp }> = [
  { weight: 3, re: /(?:采集|采样|检测|检验日期|检验时间)[^0-9]{0,4}(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})/ },
  { weight: 2, re: /(?:报告|签发|审核|打印)时间[^0-9]{0,4}(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})/ },
  { weight: 1, re: /(?:申请|开单|登记)时间[^0-9]{0,4}(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})/ },
  // 兜底：只有年月日、没有名目前缀的写法（容易误命中身份证/编号，所以权重最低）
  { weight: 0, re: /(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})/ },
];

export function findReportDate(lines: TableLine[]): string | null {
  let best: { weight: number; date: string } | null = null;
  for (const line of lines) {
    const text = line.text;
    for (const { weight, re } of DATE_PATTERNS) {
      const m = re.exec(text);
      if (!m) continue;
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (!(y >= 1990 && y <= 2100) || !(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) continue;
      const date = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      if (!best || weight > best.weight) best = { weight, date };
      break;
    }
  }
  return best?.date ?? null;
}

/**
 * 这一行是不是**检验项目行**（而不是表头之后的页脚/签名/时间/页码）。
 *
 * 实测踩坑：真实报告表格下面有一大坨「申请时间：… 采集时间：…」「报告时间：… 检验者：…」
 * 以及「以下为空」「第1页，共1页」。它们按列边界会落到「项目名称」和「结果」列里，
 * 光看「两列都非空」根本筛不掉，会原样喂给抽取（模型得靠提示词忽略，属于兜不住的地方）。
 *
 * 判据（都很硬）：
 *   - 必须**同时**有名称和结果
 *   - 名称不是「键：值」形态（`申请时间：…`）——检验项目名里不会有冒号
 *   - 名称不以页脚关键词开头
 */
const FOOTER_NAME_RE = /^(备注|声明|注[:：]|申请时间|采集时间|接收时间|核收时间|报告时间|检验者|审核者|打印者|联系电话|电话|地址|以下为空|第\d+页)/;

export function isMetricRow(cells: Record<string, string>): boolean {
  const name = (cells.name ?? "").trim();
  const value = (cells.value ?? "").trim();
  if (name === "" || value === "") return false;
  if (/[：:]/.test(name)) return false;
  if (FOOTER_NAME_RE.test(name)) return false;
  return true;
}

const LABELS: Record<string, string> = {
  index: "序号",
  name: "项目名称",
  cname: "中文名称",
  value: "结果",
  unit: "单位",
  ref: "参考范围",
  flag: "提示",
};

export function columnLabel(key: string): string {
  return LABELS[key] ?? key;
}