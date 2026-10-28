/**
 * 多轮会话的上下文策略（CONTEXT D18：服务端会话 + 规则拼接改写）。
 *
 * 为什么不调一次 LLM 做查询改写：
 *   追问的 90% 是「它呢 / 那配额呢 / 还有吗」这类指代省略。用规则判断 + 拼上一轮问题
 *   就能把检索查询补全，零额外模型调用、首 token 不退化，且**行为可测、可解释**。
 *   LLM 改写留作 eval 驱动的开关（`CONTEXT_REWRITE_MODE=llm` 未实现，属二期外），
 *   到时用它和本规则版做 A/B，而不是现在就多花一秒钟用户等待时间。
 *
 * 两个副作用要知道（诚实标注，不是隐藏行为）：
 *   1. 拼接会让检索偏向上一轮主题 —— 这正是追问想要的效果，但对「其实是新话题」的
 *      短问句是负面（所以用指代词 + 长度双判据，尽量只在真追问时改写）。
 *   2. 改写后的查询会原样返回给前端（`retrievalQuery`），用户能看到「系统拿什么去搜」。
 */

/** 生成 prompt 里带几轮历史（越多越贵，2 轮足够理解指代） */
export const CONTEXT_TURNS = 2;
/** 拼接时上一轮问题最多带多少字（防长问题把查询撑爆） */
export const PREV_QUESTION_MAX = 120;
/** 进入 prompt 的每条历史最多多少字 */
export const HISTORY_ITEM_MAX = 200;
/**
 * 短问句阈值（**已停用，保留常量只为记录口径变化**）。
 *
 * 原设计：「≤6 字且无指代词」也当追问。实测这是错的（cross-review 发现 #8）：
 * 「回滚步骤」「D1 报错」这类新话题短问会被拼上上一轮主题，检索被拉回旧内容、
 * 命中配额片段还照它作答。现在只认指代词/省略标记，短问句本身不再触发改写。
 */
export const SHORT_QUESTION_MAX = 6;

/**
 * 指代词/省略式表达。命中任一即认为「这句话单独看不完整」。
 * 注意：这里刻意包含「呢/还有/那么」这类口语连接词，它们是中文追问的高频信号。
 */
const ANAPHORA_RE =
  /(它|他|她|这个|那个|上述|前面|上面|这些|那些|这条|那条|那里|那(?!么)|呢|还有|刚才|再说|同样)/;

export type HistoryTurn = {
  question: string;
  /** 上一轮的回答（可为空：落库失败或拒答时用它做指代锚点仍有效） */
  answer?: string;
};

/**
 * 这句话是否依赖上文（决定要不要改写检索查询）。
 *
 * 只认**指代词/省略标记**：短问句不再自动改写。理由是实测代价不对称 ——
 * 漏改写只是追问检索差一点（向量对短问也能召回），误改写会把新话题强行拉回旧主题，
 * 答错且引用错文档（cross-review 发现 #8）。
 */
export function needsContext(question: string): boolean {
  const q = question.trim();
  if (!q) return false;
  return ANAPHORA_RE.test(q);
}

export type RetrievalQuery = {
  /** 真正拿去嵌入 + 关键词检索的查询 */
  query: string;
  /** 是否被规则改写（前端 step 里展示，便于「为什么搜到这个」的可解释性） */
  rewritten: boolean;
};

/**
 * 规则拼接改写。
 *
 * 输入当前问题 + 会话历史（时间正序），输出检索查询。
 * 不改写的情形：开关关闭 / 无历史 / 这句话本身完整。
 */
export function buildRetrievalQuery(
  question: string,
  history: HistoryTurn[],
  enabled = true,
): RetrievalQuery {
  const q = question.trim();
  if (!enabled || history.length === 0 || !needsContext(q)) return { query: q, rewritten: false };

  const last = history[history.length - 1]?.question?.trim();
  if (!last) return { query: q, rewritten: false };

  const prev = last.length > PREV_QUESTION_MAX ? last.slice(0, PREV_QUESTION_MAX) : last;
  return { query: `${prev} ${q}`, rewritten: true };
}

/** 会话标题：取首问，截断到 max（默认 60，侧栏一行能放下） */
export function buildTitle(question: string, max = 60): string {
  const flat = question.replace(/\s+/g, " ").trim();
  if (!flat) return "新会话";
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * 生成 prompt 用的历史块。
 *
 * 关键声明（与 lib/answer.ts 的 grounded 规则配套）：历史只用于理解指代，
 * 事实依据仍然只能来自检索片段 —— 否则多轮会把「上一轮模型编的话」变成
 * 「这一轮的事实来源」，幻觉会被继承并放大。
 */
export function buildContextBlock(
  history: HistoryTurn[],
  opts: { turns?: number; maxChars?: number } = {},
): string {
  const turns = opts.turns ?? CONTEXT_TURNS;
  const maxChars = opts.maxChars ?? HISTORY_ITEM_MAX;
  const recent = history.slice(-turns);
  if (!recent.length) return "";

  const clip = (s: string) => {
    const flat = s.replace(/\s+/g, " ").trim();
    return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars)}…`;
  };

  const lines = recent.map((t) => {
    const a = t.answer ? clip(t.answer) : "（未作答）";
    return `用户：${clip(t.question)}\n助手：${a}`;
  });

  return [
    "此前的对话（**仅用于理解指代与省略**，不构成回答依据；事实只能来自资料片段）：",
    ...lines,
  ].join("\n");
}