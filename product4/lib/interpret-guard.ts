/**
 * 解读提问的意图守卫（红线第一道闸，确定性、可单测）。
 *
 * 为什么用规则而不是让模型「自己拒绝」：模型拒绝是不可测的 —— 同一个提问可能
 * 有时拒、有时不拒，而医疗红线不能有概率。规则守卫宁可误拒（少答），不可漏放。
 *
 * 命中即拒；不命中才交给模型，模型仍有自己的红线 system prompt（第二道闸）。
 */

export type GuardResult =
  | { allowed: true }
  | { allowed: false; hits: string[] };

/**
 * 禁止意图模式。分三组（诊断 / 用药 / 危急处置），命中任一组即拒。
 * 维护口径：只加「明确越界」的模式；模糊词（如「怎么办」）不加，避免误拒正常提问。
 */
const FORBIDDEN: Array<{ kind: "diagnosis" | "medication" | "emergency"; re: RegExp; label: string }> = [
  // ── 诊断类：要求下结论 / 判断病情 ──
  { kind: "diagnosis", label: "诊断", re: /诊断|确诊|我(是不是|是否)(得|患|有)|得(了)?什么病|什么病|病情(严重|如何|怎么样)|是否(严重|危险)/ },
  { kind: "diagnosis", label: "病理推断", re: /(说明|意味着|提示)(我)?(得|患|有)(了)?[^。？?]{0,6}(病|癌|炎|症)/ },

  // ── 用药类：要求推荐/调整/停用药物 ──
  { kind: "medication", label: "用药推荐", re: /吃什么药|用什么药|买什么药|推荐.{0,4}药|药(物|品)?(推荐|建议)|(该|应|需要)吃.{0,6}药/ },
  { kind: "medication", label: "用药调整", re: /(停药|减药|加药|换药|调整.{0,4}药|剂量|吃多少|服用多少|一天吃几)/ },
  { kind: "medication", label: "保健品", re: /保健品|补剂|吃什么补|营养品.{0,4}(推荐|建议)/ },

  // ── 危急处置类：要求判断是否需要急救 ──
  { kind: "emergency", label: "危急判定", re: /(需要|要不要|该不该)(马上|立即|立刻)?(去)?(急诊|抢救|住院)|(是否|是不是)(危急|有生命危险|要命)|会不会(死|有生命危险)/ },
];

/**
 * 守卫：返回 allowed=false 时列出命中的类别（内部用；不直接回传前端）。
 * 空/未提供提问视为允许。
 */
export function interpretGuard(question: string | undefined | null): GuardResult {
  if (question == null) return { allowed: true };
  const q = String(question).trim();
  if (q === "") return { allowed: true };

  const hits: string[] = [];
  for (const rule of FORBIDDEN) {
    if (rule.re.test(q)) hits.push(rule.label);
  }
  return hits.length ? { allowed: false, hits } : { allowed: true };
}

/** 是否属于「禁止意图」（供评测集直接断言） */
export function isForbiddenQuestion(question: string): boolean {
  return !interpretGuard(question).allowed;
}