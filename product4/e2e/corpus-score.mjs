/**
 * 真实语料**字段级**打分（纯函数，无 IO）。
 *
 * 为什么要它：之前「真实语料跑通」只是我肉眼比对 + 数行数，那是「看起来对」。
 * 这里把每份报告的人工真值（`eval/corpus/truth.json`，**看图录入**，不是抄模型输出）
 * 与线上预览行逐字段比对，产出可复现的数字：名称 / 结果 / 单位 / 参考范围 / 状态 / 日期。
 *
 * 口径（很重要）：
 *   - 只比「行数 + 五个字段」，不比措辞。名称允许用**缩写命中**（报告上 `NEU#` ↔ 中文 `中性粒细胞数`）。
 *   - 单位比较是**大小写不敏感**的（`IU/mL` 与 `IU/ml` 是同一单位，不该扣分）。
 *   - 状态按我们的判定规则比对真值的方向标记：真值 `up`→期望 偏高、`down`→偏低、
 *     无标记 → 期望 正常或无法判定（界值行 `<500` vs `<500` 判不出方向是**允许**的）。
 *   - 多出来的行（页脚/散文碎行）单独计「多行」，不算漏行。
 */

const STATUS_LABEL = { normal: "正常", high: "偏高", low: "偏低", unknown: "无法判定" };

/** 去掉报告上的装饰记号与空白：`*白细胞计数` → `白细胞计数`，`（` → `(` */
export const cleanName = (s) =>
  String(s ?? "")
    .replace(/[*＊]/g, "")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/\s+/g, "")
    .toLowerCase();

/**
 * 名称匹配用的模糊键：在 cleanName 之上再抹掉 OCR 最常见的字母/数字混淆
 * （`MON0%` 与 `MONO%`、`P-LcR` 与 `P-LCR` 是同一条）。只用于**配对与名称比对**，
 * 不用于值/单位/参考范围的比对 —— 那里必须严格。
 */
export const fuzzyName = (s) =>
  cleanName(s)
    .replace(/0/g, "o")
    .replace(/1/g, "l")
    .replace(/5/g, "s");

/** 值的数值化：`<2.000` → 2、`>25.00` → 25、`13.5` → 13.5；非数值（阴性/阳性）→ null */
export const numeric = (s) => {
  const m = /^[<>≤≥]?\s*(-?\d+(?:\.\d+)?)$/.exec(String(s ?? "").replace(/\s+/g, ""));
  return m ? Number(m[1]) : null;
};

/** 单位归一：只做「同一单位的写法差异」，不做语义替换 */
export const unitKey = (s) =>
  String(s ?? "")
    .replace(/[${}]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase()
    .replace(/^10\^(\d+)\/l$/, "10^$1/l");

/** 参考范围归一：`0.4-8.0` / `0.4~8.0` / `0．4－8．0` 视为同一区间 */
export const refKey = (s) =>
  String(s ?? "")
    .replace(/[～~－—–]/g, "-")
    .replace(/[．。]/g, ".")
    .replace(/[≤]/g, "<=")
    .replace(/[≥]/g, ">=")
    .replace(/\s+/g, "")
    .toLowerCase();

/** 真值行 → 期望状态（用于与我们的判定比对） */
const expectedStatus = (row) => {
  if (row.flag === "up") return "high";
  if (row.flag === "down") return "low";
  return null; // 无标记：正常或无法判定都算对（界值行尤其如此）
};

/** 预览表格行（e2e 从 DOM 取）→ 结构化 */
export const parsePreviewRows = (raw) =>
  raw.map((r) => {
    const [nameCell = "", valueCell = "", ref = "", statusText = "", quote = ""] = r.cells.slice(1);
    const [rawName = "", standardName = ""] = nameCell.split("→").map((x) => x.trim());
    // 预览把「值 + 单位」放在同一列（`5.44 10^9/L`）→ 按第一个空格拆开
    const sp = valueCell.indexOf(" ");
    const value = sp < 0 ? valueCell : valueCell.slice(0, sp);
    const unit = sp < 0 ? "" : valueCell.slice(sp + 1);
    const status = Object.entries(STATUS_LABEL).find(([, label]) => label === statusText)?.[0] ?? "unknown";
    return { checked: r.checked, rawName, standardName, value, unit, ref, status, quote };
  });

/** 名称是否匹配（真值行 vs 预览行）：中文名相等，或缩写是**独立 token** */
const hardKey = (x) => fuzzyName(x).replace(/[^a-z0-9%]+/g, "");

const nameMatches = (raw, t) => {
  const nRaw = fuzzyName(raw);
  const nName = fuzzyName(t.name);
  const nCode = fuzzyName(t.code);
  if (!nRaw) return false;
  if (nRaw === nName || nRaw.includes(nName) || nName.includes(nRaw)) return true;
  // 只差标点/括号的写法（`HBsAg(H)` ↔ `HBsAg(H)` 去掉括号后相等）
  if (hardKey(nRaw) === hardKey(nCode) || hardKey(nRaw) === hardKey(nName)) return true;
  // 缩写必须是独立 token —— `RBC` 不能去匹 `*RBC平均HGB含量`（它是 MCH 那行）
  const tokens = nRaw.split(/[^a-z0-9%#-]+/).filter(Boolean);
  return Boolean(nCode) && tokens.includes(nCode);
};

/**
 * 行配对：**位置优先**（报告本身有顺序，预览也是同一顺序；模型漏一行时后续位置会漂，
 * 再用名称/缩写把它们各自找回来）。
 */
const pairRows = (truth, got) => {
  const used = new Set();
  const pairs = truth.map((t, i) => {
    // ① 同位优先
    let hit = got[i] && !used.has(i) && nameMatches(got[i].rawName, t) ? i : -1;
    // ② 名称/缩写在全表里找
    if (hit < 0) hit = got.findIndex((g, j) => !used.has(j) && nameMatches(g.rawName, t));
    if (hit >= 0) used.add(hit);
    return { truth: t, got: hit >= 0 ? got[hit] : null, index: hit };
  });
  const extra = got.filter((_, i) => !used.has(i));
  return { pairs, extra };
};

/**
 * 单份报告打分。
 * @param {{rows: Array}} truth 人工真值
 * @param {Array} got parsePreviewRows 的结果
 * @returns 各字段命中数 + 明细
 */
export const scoreReport = (truth, got) => {
  const { pairs, extra } = pairRows(truth.rows, got);
  const s = { name: 0, value: 0, unit: 0, ref: 0, status: 0, normalized: 0 };
  const misses = [];

  for (const { truth: t, got: g } of pairs) {
    if (!g) continue;
    const nameOk = nameMatches(g.rawName, t);
    const nv = numeric(t.value);
    const gv = numeric(g.value);
    const valueOk = nv !== null && gv !== null ? nv === gv : cleanName(g.value) === cleanName(t.value);
    const unitOk = unitKey(g.unit) === unitKey(t.unit);
    const refOk = refKey(g.ref) === refKey(t.ref);
    const want = expectedStatus(t);
    const statusOk = want === null ? g.status === "normal" || g.status === "unknown" : g.status === want;

    if (nameOk) s.name++;
    if (valueOk) s.value++;
    if (unitOk) s.unit++;
    if (refOk) s.ref++;
    if (statusOk) s.status++;
    if (g.standardName) s.normalized++;

    if (!nameOk) misses.push(`名称：真值 ${t.code}/${t.name} → 得到 ${g.rawName}`);
    if (!valueOk) misses.push(`结果：${t.code} 真值 ${t.value} → 得到 ${g.value}`);
    if (!refOk) misses.push(`参考范围：${t.code} 真值 ${t.ref} → 得到 ${g.ref}`);
    if (!statusOk) misses.push(`状态：${t.code} 期望 ${want} → 得到 ${g.status}`);
    if (!unitOk) misses.push(`单位：${t.code} 真值 ${t.unit} → 得到 ${g.unit || "(空)"}`);
  }

  const missed = pairs.filter((p) => !p.got).map((p) => `${p.truth.code}/${p.truth.name}`);
  return {
    truth: truth.rows.length,
    extracted: got.length,
    matched: pairs.filter((p) => p.got).length,
    name: s.name,
    value: s.value,
    unit: s.unit,
    ref: s.ref,
    status: s.status,
    normalized: s.normalized,
    missed,
    extra: extra.map((x) => x.rawName),
    checkedDefault: got.filter((x) => x.checked).length,
    misses,
  };
};

/** 多份聚合：把各字段命中数/总数汇总 */
export const aggregate = (scores) => {
  const tot = { truth: 0, extracted: 0, matched: 0, name: 0, value: 0, unit: 0, ref: 0, status: 0, normalized: 0 };
  for (const s of scores) for (const k of Object.keys(tot)) tot[k] += s[k] ?? 0;
  return tot;
};