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

/**
 * 标准指标定义。
 * - `aliases`：报告里见过的写法（小写比较，**整串精确匹配**，不做子串匹配）
 * - `veto`：**上下文否决**——命中则这条别名不适用，退回到「清洗后的原文名」自成一条序列。
 *   为什么需要：别名是整串匹配，但括号被 `cleanLoose` 剥掉后可能撞车，
 *   例如「葡萄糖(餐后2h)」清洗后就是「葡萄糖」→ 会被错并入空腹血糖（同单位、无告警、假趋势）。
 *   审查实测把这类错并列为**阻塞**：错误的异常结论比没有结论更糟。
 */
export type StandardMetric = { standard: string; aliases: string[]; veto?: RegExp };

/**
 * 常见面板/口径标记（用于 veto）。
 * 只否决「同名字不同测项」的已知撞车，不做泛化猜测 —— 宁可分线，不可错并。
 */
const NOT_FASTING = /餐后|餐前|随机|1h|2h|3h|糖耐|OGTT|负荷|尿|糖化|空腹胰岛素/;
const NOT_BLOOD_PANEL = /尿|粪|便|脑脊液|胸水|腹水|HPF|镜检|沉渣/;
const NOT_SERUM = /尿|微量|脑脊液/;

/**
 * 首发字典（涵盖高频 panel：血常规 / 血脂 / 肝功 / 肾功 / 血糖 / 尿酸 / 甲状腺）。
 * 新增指标只需往这里加一条 —— 不需要改任何业务逻辑。
 */
export const STANDARD_METRICS: StandardMetric[] = [
  // ── 血常规 ────────────────────────────────────────────────
  { standard: "白细胞计数", aliases: ["白细胞", "wbc", "白细胞数", "leucocyte", "white blood cell"], veto: NOT_BLOOD_PANEL },
  { standard: "红细胞计数", aliases: ["红细胞", "rbc", "红细胞数", "erythrocyte"], veto: NOT_BLOOD_PANEL },
  { standard: "血红蛋白", aliases: ["hb", "hgb", "hemoglobin", "血红蛋白浓度"] },
  { standard: "血小板计数", aliases: ["血小板", "plt", "platelet", "血小板数"] },
  { standard: "中性粒细胞百分比", aliases: ["中性粒细胞比率", "neut%", "ne%", "neutrophil%", "neu%", "neut%"] },
  { standard: "淋巴细胞百分比", aliases: ["淋巴细胞比率", "lymph%", "ly%", "lymphocyte%", "lym%", "lymph%"] },

  // ── 血脂 ──────────────────────────────────────────────────
  { standard: "总胆固醇", aliases: ["胆固醇", "tc", "total cholesterol", "chol"] },
  // 「甲状腺球蛋白 TG」是另一个测项（ng/mL），不能并入甘油三酯
  { standard: "甘油三酯", aliases: ["tg", "triglyceride", "甘油三脂"], veto: /甲状腺|球蛋白|游离/ },
  { standard: "高密度脂蛋白胆固醇", aliases: ["hdl", "hdl-c", "高密度脂蛋白"] },
  { standard: "低密度脂蛋白胆固醇", aliases: ["ldl", "ldl-c", "低密度脂蛋白"] },

  // ── 血糖 ──────────────────────────────────────────────────
  // ⚠️ 这里刻意**不收**「血糖 / glu / glucose / 葡萄糖」这类宽别名：
  //    它们同时也是「餐后血糖 / OGTT 负荷试验 / 尿糖」的写法，同单位错并后
  //    趋势图会给出假趋势、异常判定会给出错误结论（审查阻塞项）。
  //    未命中就退回原文名自成一条线 —— 宁可分线，不可错并。
  { standard: "空腹血糖", aliases: ["空腹血糖", "空腹葡萄糖"], veto: NOT_FASTING },
  { standard: "糖化血红蛋白", aliases: ["hba1c", "糖化血红蛋白a1c", "glycated hemoglobin"] },

  // ── 肝功 ──────────────────────────────────────────────────
  { standard: "丙氨酸氨基转移酶", aliases: ["谷丙转氨酶", "alt", "gpt"] },
  { standard: "天门冬氨酸氨基转移酶", aliases: ["谷草转氨酶", "ast", "got"] },
  { standard: "总胆红素", aliases: ["tbil", "total bilirubin"] },
  { standard: "白蛋白", aliases: ["alb", "albumin"], veto: NOT_SERUM },
  // ── 血常规五分类（真实报告实测：24 项，含绝对值 # 与百分比 % 两套，**绝不能混**）──
  // 绝对值与百分比是不同指标：NEU# 中性粒细胞数(10^9/L) ≠ NEU% 中性粒细胞率(%)
  { standard: "中性粒细胞绝对值", aliases: ["neu#", "neut#", "中性粒细胞数", "中性粒细胞绝对值"] },
  { standard: "淋巴细胞绝对值", aliases: ["lym#", "lymph#", "淋巴细胞数", "淋巴细胞绝对值"] },
  { standard: "单核细胞绝对值", aliases: ["mono#", "mon#", "单核细胞数", "单核细胞绝对值"] },
  { standard: "嗜酸性粒细胞绝对值", aliases: ["eos#", "嗜酸性细胞数", "嗜酸性粒细胞绝对值"] },
  { standard: "嗜碱性粒细胞绝对值", aliases: ["baso#", "bas#", "嗜碱性细胞数", "嗜碱性粒细胞绝对值"] },
  { standard: "单核细胞百分比", aliases: ["mono%", "mon%", "单核细胞率", "单核细胞百分比"] },
  { standard: "嗜酸性粒细胞百分比", aliases: ["eos%", "嗜酸性细胞率", "嗜酸性粒细胞百分比"] },
  { standard: "嗜碱性粒细胞百分比", aliases: ["baso%", "bas%", "嗜碱性细胞率", "嗜碱性粒细胞百分比"] },
  { standard: "红细胞压积", aliases: ["hct", "红细胞比容", "红细胞压积"] },
  { standard: "平均红细胞体积", aliases: ["mcv", "红细胞平均体积", "平均红细胞体积"] },
  { standard: "平均红细胞血红蛋白量", aliases: ["mch", "rbc平均hgb含量", "平均红细胞血红蛋白量"] },
  { standard: "平均红细胞血红蛋白浓度", aliases: ["mchc", "rbc平均hgb浓度", "平均红细胞血红蛋白浓度"] },
  { standard: "红细胞分布宽度标准差", aliases: ["rdw-sd", "rbc分布宽度-标准差", "红细胞分布宽度标准差"] },
  { standard: "红细胞分布宽度变异系数", aliases: ["rdw-cv", "rbc分布宽度-变异系数", "红细胞分布宽度变异系数"] },
  { standard: "平均血小板体积", aliases: ["mpv", "血小板平均体积", "平均血小板体积"] },
  { standard: "血小板分布宽度", aliases: ["pdw", "血小板体积分布宽度", "血小板分布宽度"] },
  { standard: "大血小板比率", aliases: ["p-lcr", "大血小板比率"] },
  // ⚠️ 刻意**不收** `PCT`：它既可能是「血小板压积」（%）也可能是「降钙素原」（ng/mL），
  //   与「尿素 vs 尿素氮」同类撞车 —— 名字分不出来就宁可不合并，让它自成一条线。
  { standard: "血小板压积", aliases: ["血小板压积"] },

  // 乙肝五项（真实报告里最常见的定量组套；HBsAg(H) 是「高值」稀释复测，与分析物同一）
  { standard: "乙肝表面抗原", aliases: ["hbsag", "hbsag(h)", "乙肝表面抗原", "乙肝表面抗原定量"] },
  { standard: "乙肝表面抗体", aliases: ["hbsab", "抗-hbs", "乙肝表面抗体", "乙肝表面抗体定量"] },
  { standard: "乙肝e抗原", aliases: ["hbeag", "hbeag(h)", "乙肝e抗原", "乙肝e抗原定量"] },
  { standard: "乙肝e抗体", aliases: ["hbeab", "抗-hbe", "乙肝e抗体", "乙肝e抗体定量"] },
  { standard: "乙肝核心抗体", aliases: ["hbcab", "抗-hbc", "乙肝核心抗体", "乙肝核心抗体定量"] },
  { standard: "γ-谷氨酰转移酶", aliases: ["谷氨酰转肽酶", "ggt", "γ-gt", "ggtp"] },

  // ── 肾功 ──────────────────────────────────────────────────
  { standard: "肌酐", aliases: ["cr", "creatinine", "血肌酐"] },
  // 「尿素(UREA)」与「尿素氮(BUN)」数值标度差约 2.14 倍且常见单位都是 mmol/L，
  // 错并不会被 unitChanged 拦下 → 不收「尿素」这个别名，让它自成一条线。
  { standard: "尿素氮", aliases: ["尿素氮", "bun", "urea nitrogen", "血尿素氮"] },
  { standard: "尿酸", aliases: ["ua", "uric acid", "血尿酸"] },

  // ── 甲状腺 ────────────────────────────────────────────────
  { standard: "促甲状腺激素", aliases: ["tsh", "促甲状腺素"] },
  { standard: "游离甲状腺素", aliases: ["ft4", "游离t4", "free t4"] },
  { standard: "游离三碘甲状腺原氨酸", aliases: ["ft3", "游离t3", "free t3"] },
];

/** aliases 索引（小写 → {标准名, veto}）。模块级构建一次。 */
const ALIAS_INDEX: Map<string, { standard: string; veto?: RegExp }> = (() => {
  const m = new Map<string, { standard: string; veto?: RegExp }>();
  for (const def of STANDARD_METRICS) {
    const entry = { standard: def.standard, veto: def.veto };
    m.set(def.standard.toLowerCase(), entry);
    for (const a of def.aliases) {
      const prev = m.get(a.toLowerCase());
      // 别名冲突时保留「有 veto」的那条：veto 是更保守的处理
      if (prev == null || (entry.veto && !prev.veto)) m.set(a.toLowerCase(), entry);
    }
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

  // 「尿素氮 BUN」这类「中文名 + 英文缩写」的写法：整串匹配不上，但拆开两半都指向同一标准名 ——
  // 只有当两半**互相印证**时才合并（判据：都命中字典且标准名相同）。
  // 不做「任一命中就合并」：那会把「甲状腺球蛋白 TG」并进甘油三酯（错并）。
  const spaced = cleaned.lastIndexOf(" ");
  if (spaced > 0) {
    const head = cleaned.slice(0, spaced);
    const tail = cleaned.slice(spaced + 1);
    const h = lookup(head, rawName);
    const t = lookup(tail, rawName);
    if (h && t && h === t) return h;
  }

  const direct = lookup(cleaned, rawName);
  if (direct) return direct;

  // 拉丁缩写里的 OCR 混淆（真实报告实测）：`MON0%` `BAS0%` `P-LcR` `EoS%`。
  // 归一后**必须能命中字典**才采用（否则仍返回原文名）—— 只修「已知指标认不出」，
  // 不凭猜测把两个陌生指标并到一起。
  const variant = ocrLatinVariant(cleaned);
  if (variant && variant !== cleaned) {
    const hit = lookup(variant, rawName);
    if (hit) return hit;
  }
  return cleaned;
}

/** 拉丁缩写里的常见 OCR 混扰：数字 0/1/5 与字母 O/l/S、大小写不一致 */
export function ocrLatinVariant(name: string): string {
  if (!/[a-zA-Z]/.test(name)) return name;
  return name
    .replace(/0/g, "o")
    .replace(/1/g, "l")
    .replace(/5/g, "s");
}

/** 别名查询（含上下文否决）；未命中返回 null */
function lookup(cleaned: string, rawName: string): string | null {
  const hit = ALIAS_INDEX.get(cleaned.toLowerCase());
  if (!hit) return null;
  // 上下文否决：用**原始名**判定（cleanLoose 会剥掉括号，而「(餐后2h)」正在括号里）
  if (hit.veto && hit.veto.test(rawName)) return null;
  return hit.standard;
}

/** 该指标是否命中字典（前端可用于标注「已归一 / 仅原文名」） */
export function isKnownMetric(rawName: string): boolean {
  const cleaned = cleanLoose(rawName);
  if (cleaned === "") return false;
  const hit = ALIAS_INDEX.get(cleaned.toLowerCase());
  if (!hit) return false;
  if (hit.veto && hit.veto.test(rawName)) return false;
  return true;
}