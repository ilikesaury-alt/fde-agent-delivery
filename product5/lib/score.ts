/**
 * lib/score.ts —— 两阶段评分（CONTEXT D5）
 *
 * 阶段 1（预筛，**本地纯函数，不花 LLM 调用**）：用确定性规则先干掉明显噪音，
 *   把 LLM 调用量压到可控范围（Free 套餐 subrequest 50/次 是硬预算）。
 * 阶段 2（打分，LLM）：对通过预筛的条目做多维评分，取 top N 进精选。
 *
 * 为什么预筛必须本地：一次 Cron 只能发有限个 subrequest，
 * 「180 条全部丢给 LLM」既超预算又浪费钱；而噪音的判据（太短、纯转发、无信息量标题）
 * 完全可以确定性判定，交给模型是浪费。
 *
 * 设计纪律：
 *  - 评分维度**可解释**（每维有明确语义），不搞黑盒总分
 *  - LLM 返回**必须可校验**：字段缺失/越界即判失败（沿用①「缺板块即失败重试」的硬纪律）
 *  - 阈值/权重是**可配置常量**，且由评测集标定（A3），不拍脑袋
 *  - 模型失败不编造分数：返回 `null` 让调用方决定降级，绝不塞默认分
 */

/** 参与打分的条目（比 RawItem 少了不必要的字段） */
export type ScoreInput = {
  title: string;
  summary: string;
  sourceId: string;
  /** 源的语言偏好（zh 源更可能产出中文资讯） */
  lang?: string;
};

/** 四维评分（0..10 整数） */
export type Dimensions = {
  /** 与「AI / 技术资讯」主题的相关性 */
  relevance: number;
  /** 新颖性：是否是新事件/新发布，而非旧闻回顾 */
  novelty: number;
  /** 实用度：对读者是否有可操作价值（教程/工具/数据） */
  usefulness: number;
  /** 权威度：来源可信度与一手性（官方博客 > 二手转载） */
  authority: number;
};

export type Score = Dimensions & {
  /** 加权综合分（0..100，保留 1 位小数） */
  total: number;
  /** 一句话理由（给人复核用，不进 UI 决策） */
  reason: string;
};

/** 权重：相关性最重，权威度次之（二手转载降权），新颖与实用各占两成 */
export const DEFAULT_WEIGHTS: Dimensions = {
  relevance: 0.4,
  novelty: 0.2,
  usefulness: 0.2,
  authority: 0.2,
};

export function totalOf(d: Dimensions, weights: Dimensions = DEFAULT_WEIGHTS): number {
  const raw =
    d.relevance * weights.relevance +
    d.novelty * weights.novelty +
    d.usefulness * weights.usefulness +
    d.authority * weights.authority;
  return Math.round(raw * 10 * 10) / 10; // 0..100，1 位小数
}

/* ─────────────────────── 阶段 1：本地预筛 ─────────────────────── */

/** 预筛结论：keep（进 LLM 打分）/ drop（确定性噪音） */
export type PrefilterVerdict = { keep: true } | { keep: false; reason: string };

/** 明确噪音的标题特征（中文资讯站常见模板化标题） */
const NOISE_TITLE_PATTERNS: Array<[RegExp, string]> = [
  [/^(广告|推广|赞助)/i, "广告位"],
  [/^(招聘|求职|招人)/i, "招聘信息"],
  [/^(转载|转自|来源[:：])/i, "纯转载标记"],
  [/(优惠|促销|折扣|秒杀|券)$/i, "促销信息"],
];

export type PrefilterOptions = {
  /** 正文/摘要最短字符数（默认 24；太短说明只有标题，信息量不足） */
  minSummaryChars?: number;
  /** 标题最短字符数（默认 12） */
  minTitleChars?: number;
};

/**
 * 本地预筛（确定性、可单测、不触网）。
 * 判据刻意保守：只砍**明确**噪音，不确定的一律放行给 LLM —— 宁可多花一次调用，
 * 也不要把好内容在预筛阶段误杀（误杀在评测集里体现为 recall 下降）。
 */
export function prefilter(input: ScoreInput, opts: PrefilterOptions = {}): PrefilterVerdict {
  const minSummary = opts.minSummaryChars ?? 24;
  const minTitle = opts.minTitleChars ?? 12;

  const title = input.title.trim();
  const summary = input.summary.trim();

  if (title.length < minTitle) return { keep: false, reason: "标题过短" };
  if (summary.length < minSummary) return { keep: false, reason: "缺少摘要，信息量不足" };

  for (const [pattern, reason] of NOISE_TITLE_PATTERNS) {
    if (pattern.test(title)) return { keep: false, reason };
  }

  // 纯转发/引用模板（"RT @"、"转推"）本身无增量信息
  if (/^(RT|转推)\s*@/i.test(title)) return { keep: false, reason: "纯转发" };

  return { keep: true };
}

/** 批量预筛，保持原顺序（便于与入库条目对齐） */
export function prefilterAll<T extends ScoreInput>(
  inputs: T[],
  opts?: PrefilterOptions,
): Array<{ input: T; verdict: PrefilterVerdict }> {
  return inputs.map((input) => ({ input, verdict: prefilter(input, opts) }));
}

/* ─────────────────────── 阶段 2：LLM 打分 ─────────────────────── */

export const SCORE_SYSTEM_PROMPT = `你是 AI 资讯编辑，负责给候选资讯打分。

维度（每项 0-10 的整数）：
- relevance：与「人工智能 / 前沿技术」主题的相关程度。纯消费电子、纯商业并购、纯体育娱乐 → 低分。
- novelty：新颖性。新发布/新事件/新论文 → 高分；旧闻回顾、常识科普、长期有效的基础教程 → 中等；重复报道 → 低分。
- usefulness：实用度。读者能否据此做出行动（用上某工具、理解某技术、避开某坑）→ 高分；纯观点、纯情绪 → 低分。
- authority：权威度。一手来源（官方博客/论文/当事人）→ 高分；二手转载/自媒体解读 → 中等；匿名爆料 → 低分。

只输出 JSON，不要任何解释文字：
{"relevance":<0-10>,"novelty":<0-10>,"usefulness":<0-10>,"authority":<0-10>,"reason":"<20 字以内中文理由>"}`;

export function buildScorePrompt(input: ScoreInput): string {
  return [
    `标题：${input.title}`,
    `摘要：${input.summary}`,
    `来源：${input.sourceId}${input.lang ? `（${input.lang}）` : ""}`,
    "",
    "按系统提示的四个维度打分，只输出 JSON。",
  ].join("\n");
}

export type ParseScoreResult =
  | { ok: true; score: Score }
  | { ok: false; reason: string };

function clampDimension(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 10) return null; // 越界即判失败，不做静默裁剪（否则阈值标定会失真）
  return Math.round(n);
}

/**
 * 解析并校验 LLM 返回的评分。
 * 缺字段/越界/非数字 → **失败**（不塞默认值），与「缺板块即失败重试」同纪律。
 */
export function parseScore(content: string): ParseScoreResult {
  const text = String(content ?? "").trim();
  if (!text) return { ok: false, reason: "模型返回为空" };

  // 允许模型在 JSON 外包 ```json 围栏
  const jsonText = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = jsonText.indexOf("{");
  const end = jsonText.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, reason: "模型未返回 JSON 对象" };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonText.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "模型返回的 JSON 无法解析" };
  }

  const dims: Partial<Dimensions> = {};
  for (const key of ["relevance", "novelty", "usefulness", "authority"] as const) {
    const v = clampDimension(parsed[key]);
    if (v === null) return { ok: false, reason: `维度 ${key} 缺失或越界（应为 0-10 整数）` };
    dims[key] = v;
  }

  const reason = typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 40) : "";
  const d = dims as Dimensions;
  return { ok: true, score: { ...d, total: totalOf(d), reason } };
}

/* ─────────────────────── 精选（阈值 + topN） ─────────────────────── */

export type SelectOptions = {
  /** 综合分门槛（0..100）；由评测集标定，不拍脑袋 */
  threshold: number;
  /** 最多进精选几条 */
  topN: number;
};

/**
 * 阈值 + topN 筛选。返回**保留原顺序**的入选集合与落选原因统计
 * （落选原因是给人复核与标定的依据，不只是日志）。
 */
export function selectTop<T extends { total: number }>(
  scored: T[],
  opts: SelectOptions,
): { kept: T[]; belowThreshold: number; overLimit: number } {
  const passed = scored.filter((s) => s.total >= opts.threshold);
  const belowThreshold = scored.length - passed.length;
  const sorted = [...passed].sort((a, b) => b.total - a.total);
  const keptSet = new Set(sorted.slice(0, opts.topN));
  return {
    kept: scored.filter((s) => keptSet.has(s)),
    belowThreshold,
    overLimit: Math.max(0, passed.length - opts.topN),
  };
}