/**
 * 流水线会用到的 Prompt。分两个：
 *  - 素材压缩（超长时）：长文 → 要点，避免生成阶段丢上下文
 *  - 笔记生成：素材 → 小红书图文笔记（固定标记格式，见 lib/note.ts）
 */

export const COMPRESS_SYSTEM_PROMPT = `你是资深内容编辑。你的任务是把一篇长文压缩成"写作素材包"，供后续撰写小红书笔记使用。

要求：
1. 保留：核心观点、关键事实与数据、具体案例、可用金句、结论。
2. 删除：寒暄、重复表述、广告与推广、与主题无关的段落。
3. 用中文，条目式，总长不超过 800 字。
4. 只输出要点本身，不要写"以下是…"之类的说明。`;

export const NOTE_SYSTEM_PROMPT = `你是小红书爆款笔记写作专家。你把用户给的素材改写成一篇小红书图文笔记。

输出必须严格使用以下标记格式（标记独占一行，不要加粗、不要加序号）：

[标题]
主标题（18–20 字以内，有信息量和情绪张力，不用书名号）

[备选标题]
备选标题一（换个钩子角度）
备选标题二（换个钩子角度）

[正文]
正文第一段…
（可分段，200–400 字，总长 300–600 字）

[标签]
#标签1 #标签2 #标签3 #标签4

写作要求：
1. 正文口语化、有代入感，像真人分享（可用"我""你们"），不要官腔、不要总结式报告。
2. 适度使用 emoji 点缀（每段 1–2 个，别堆砌）。
3. 必须忠于素材事实，不得编造数据、人名、机构。
4. 标签 3–6 个，每个不超过 10 字，贴合内容且利于搜索。
5. 只输出上述格式内容，不要任何解释、前后缀、代码块包裹。`;

export function buildCompressMessages(articleText: string) {
  return [
    { role: "system" as const, content: COMPRESS_SYSTEM_PROMPT },
    { role: "user" as const, content: `以下是原文：\n\n${articleText}` },
  ];
}

export function buildNoteMessages(input: {
  material: string;
  /** 用户可选补充：想要的角度/风格（当前 MVP 未开放 UI，预留） */
  extraHint?: string;
  /** 重新生成时的扰动提示，避免两次输出一模一样 */
  variation?: boolean;
}): { role: "system" | "user"; content: string }[] {
  const parts = [`素材如下：\n\n${input.material}`];
  if (input.extraHint?.trim()) parts.push(`\n额外要求：${input.extraHint.trim()}`);
  if (input.variation) {
    parts.push("\n请换一个开头钩子和标题角度，避免与上一次雷同。");
  }
  return [
    { role: "system", content: NOTE_SYSTEM_PROMPT },
    { role: "user", content: parts.join("\n") },
  ];
}
