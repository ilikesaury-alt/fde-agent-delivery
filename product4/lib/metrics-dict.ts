/**
 * 指标名归一字典（CONTEXT 方案「指标名归一」）。
 *
 * 为什么必须归一：不同医院/不同年份叫法不同 —— 「甘油三酯 / TG / Triglyceride」
 * 若各存各的，趋势图会碎成三条互不相连的线（每份报告一条）。归一后按 standardName
 * 聚合，rawName 保留原文可追溯。
 *
 * 两层策略（**不设入库白名单**，D3）：
 *   1. 命中字典（含别名）→ standardName = 标准名
 *   2. 未命中 → standardName = cleanLoose(rawName)，仍然入库、仍然画趋势；
 *      只是跨医院的同义变体可能分线（已知取舍，见 CONTEXT「待决问题」的改名合并入口）
 *
 * 字典只服务于**归一**，不服务于**拦截** —— 报告里有的指标一律入库。
 */

/** 标准指标定义：standard 标准名，unit 常用单位提示，aliases 报告里见过的写法（小写比较） */
export type StandardMetric = { standard: string; aliases: string[] };

/**
 * 首发字典（涵盖高频 panel：血常规 / 血脂 / 肝功 / 肾功 / 血糖 / 尿酸 / 甲状腺）。
 * 新增指标只需往这里加一条 —— 不需要改任何业务逻辑。
 */
export const STANDARD_METRICS: StandardMetric[] = [
  // ── 血常规 ────────────────────────────────────────────────
  { standard: "白细胞计数", aliases: ["白细胞", "wbc", "白细胞数", "leucocyte", "white blood cell"] },
  { standard: "红细胞计数", aliases: ["红细胞", "rbc", "红细胞数", "erythrocyte"] },
  { standard: "血红蛋白", aliases: ["hb", "hgb", "hemoglobin", "血红蛋白浓度"] },
  { standard: "血小板计数", aliases: ["血小板", "plt", "platelet", "血小板数"] },
  { standard: "中性粒细胞百分比", aliases: ["中性粒细胞比率", "neut%", "ne%", "neutrophil%"] },
  { standard: "淋巴细胞百分比", aliases: ["淋巴细胞比率", "lymph%", "ly%", "lymphocyte%"] },

  // ── 血脂 ──────────────────────────────────────────────────
  { standard: "总胆固醇", aliases: ["胆固醇", "tc", "total cholesterol", "chol"] },
  { standard: "甘油三酯", aliases: ["tg", "triglyceride", "甘油三脂"] },
  { standard: "高密度脂蛋白胆固醇", aliases: ["hdl", "hdl-c", "高密度脂蛋白"] },
  { standard: "低密度脂蛋白胆固醇", aliases: ["ldl", "ldl-c", "低密度脂蛋白"] },

  // ── 血糖 ──────────────────────────────────────────────────
  { standard: "空腹血糖", aliases: ["血糖", "glu", "glucose", "空腹葡萄糖", "葡萄糖"] },
  { standard: "糖化血红蛋白", aliases: ["hba1c", "糖化血红蛋白a1c", "glycated hemoglobin"] },

  // ── 肝功 ──────────────────────────────────────────────────
  { standard: "丙氨酸氨基转移酶", aliases: ["谷丙转氨酶", "alt", "gpt"] },
  { standard: "天门冬氨酸氨基转移酶", aliases: ["谷草转氨酶", "ast", "got"] },
  { standard: "总胆红素", aliases: ["tbil", "total bilirubin"] },
  { standard: "白蛋白", aliases: ["alb", "albumin"] },
  { standard: "γ-谷氨酰转移酶", aliases: ["谷氨酰转肽酶", "ggt", "γ-gt", "ggtp"] },

  // ── 肾功 ──────────────────────────────────────────────────
  { standard: "肌酐", aliases: ["cr", "creatinine", "血肌酐"] },
  { standard: "尿素氮", aliases: ["尿素", "bun", "urea nitrogen", "血尿素氮"] },
  { standard: "尿酸", aliases: ["ua", "uric acid", "血尿酸"] },

  // ── 甲状腺 ────────────────────────────────────────────────
  { standard: "促甲状腺激素", aliases: ["tsh", "促甲状腺素"] },
  { standard: "游离甲状腺素", aliases: ["ft4", "游离t4", "free t4"] },
  { standard: "游离三碘甲状腺原氨酸", aliases: ["ft3", "游离t3", "free t3"] },
];

/** aliases 索引（小写 → 标准名）。模块级构建一次。 */
const ALIAS_INDEX: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const def of STANDARD_METRICS) {
    m.set(def.standard.toLowerCase(), def.standard);
    for (const a of def.aliases) m.set(a.toLowerCase(), def.standard);
  }
  return m;
})();

/**
 * 宽松清洗：用于**未命中字典**的指标名，尽量让同一指标的写法靠拢。
 *
 * 只做安全的、不会把不同指标合并到一起的操作：
 *   - 去掉括号内的说明（「白细胞(血常规)」→「白细胞」）
 *   - 去掉尾部的 ↑↓ / * 标记（报告里常见「肌酐 ↑」）
 *   - 压缩空白、去首尾「:：」
 *   - **拉丁字母转小写**（「ALT」与「alt」是同一指标；中文不受影响）
 *
 * 不做：单词级缩写展开、语义相似度合并 —— 那会把不同指标误并（宁可分线，不可错并）。
 */
export function cleanLoose(rawName: string): string {
  const s = rawName
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[↑↓*＊]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s:：]+|[\s:：]+$/g, "");
  return s.replace(/[A-Za-z]/g, (ch) => ch.toLowerCase());
}

/**
 * 归一：命中字典 → 标准名；未命中 → cleanLoose(rawName)。
 * 传入空串时返回空串（调用方负责判定该指标是否可用）。
 */
export function normalizeMetricName(rawName: string): string {
  const cleaned = cleanLoose(rawName);
  if (cleaned === "") return "";
  const hit = ALIAS_INDEX.get(cleaned.toLowerCase());
  return hit ?? cleaned;
}

/** 该指标是否命中字典（前端可用于标注「已归一 / 仅原文名」） */
export function isKnownMetric(rawName: string): boolean {
  const cleaned = cleanLoose(rawName);
  return cleaned !== "" && ALIAS_INDEX.has(cleaned.toLowerCase());
}