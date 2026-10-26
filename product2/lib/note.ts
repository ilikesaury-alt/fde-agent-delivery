/**
 * 笔记结构化解析。
 *
 * 为什么不用 JSON：正文需要 **token 级流式**展示，JSON 在流中途不可读，
 * 用户会看到一堆 `{"body":"...` 的噪音。改用**行级标记**：
 *   [标题]
 *   主标题
 *   [备选标题]
 *   备选1
 *   备选2
 *   [正文]
 *   正文若干段…
 *   [标签]
 *   #a #b #c
 *
 * 前端在流式中可以安全地隐藏 /^\[.+\]$/ 这样的标记行，正文照常逐字出现。
 * 解析保持宽容：全角括号、Markdown 标题、缺段都能兜住（LLM 输出不稳定是常态）。
 */

import type { XhsNote } from "./types.ts";

export type ParseResult = {
  note: XhsNote;
  /** 解析过程中修正/容忍的问题，便于排查（不上前端） */
  issues: string[];
};

const MARKER = /^\s*(?:\[|【|#+\s*)(标题|备选标题|正文|标签|话题标签)(?:\]|】)?\s*[:：]?\s*$/;
const BODY_MARKER = /^\s*(?:\[|【|#+\s*)正文(?:\]|】)?\s*[:：]?\s*$/;

type Section = "titles" | "altTitles" | "body" | "tags";

function sectionOf(name: string): Section {
  if (name === "标题") return "titles";
  if (name === "备选标题") return "altTitles";
  if (name === "正文") return "body";
  return "tags"; // 标签 / 话题标签
}

function cleanLine(line: string): string {
  return line.replace(/^[\s>*\-•]+/, "").trim();
}

/** 去掉模型爱加的包裹符号：引号、书名号外层、`**` 粗体 */
function stripWrap(s: string): string {
  return s
    .replace(/^\*{1,2}|\*{1,2}$/g, "")
    .replace(/^["'“”「」『』]+|["'“”「」『』]+$/g, "")
    .trim();
}

export function parseNote(raw: string): ParseResult {
  const issues: string[] = [];
  const buckets: Record<Section, string[]> = { titles: [], altTitles: [], body: [], tags: [] };

  let current: Section | null = null;
  for (const rawLine of raw.split(/\r?\n/)) {
    const marker = MARKER.exec(rawLine);
    if (marker) {
      current = sectionOf(marker[1]);
      continue;
    }
    if (current === null) {
      // 标记之前的开头内容：若像标题就当归标题，否则丢弃（多是模型的客套话）
      const t = cleanLine(rawLine);
      if (t) buckets.titles.push(t);
      continue;
    }
    buckets[current].push(rawLine);
  }

  if (buckets.body.every((l) => !l.trim())) issues.push("缺少正文段标记");

  let titles = dedupe(
    [...buckets.titles, ...buckets.altTitles]
      .map((l) => stripWrap(cleanLine(l)))
      .filter((t) => t.length > 0 && t.length <= 60),
  );

  // 兜底：完全没有标题时，用正文首句当前 20 字作标题（不让 UI 出现空标题）
  if (titles.length === 0) {
    const firstSentence = buckets.body
      .join(" ")
      .split(/[。！？!?\n]/)
      .map((s) => s.trim())
      .find((s) => s.length > 0);
    if (firstSentence) {
      titles = [firstSentence.slice(0, 20)];
      issues.push("无标题段，已从正文首句截取");
    }
  }

  const body = buckets.body
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const tags = dedupe(
    buckets.tags
      .join(" ")
      .split(/[\s,，、]+/)
      .map((t) => t.replace(/^#+/, "").replace(/[。！？!?，,、\s]+$/g, "").trim())
      .filter((t) => t.length > 0 && t.length <= 20),
  ).slice(0, 6);

  if (tags.length === 0) issues.push("无话题标签");

  return { note: { titles, body, tags }, issues };
}

/**
 * 流式预览用：只取「正文」段并隐去标记行。
 * 解析完成前用它渲染，否则用户会看到 `[标题]` 这类标记混在正文里。
 *
 * 必须与 parseNote 共用同一套标记正则——早期版本在页面里另写了一份，
 * 且用「过滤后的下标」去切「未过滤的数组」，会丢正文前几行。
 */
export function previewBody(raw: string): string {
  const lines = raw.split("\n");
  const idx = lines.findIndex((l) => BODY_MARKER.test(l));
  const rest = idx >= 0 ? lines.slice(idx + 1) : lines;
  // 正文段到下一个标记（如 [标签]）为止；否则标签行会在流式中混进正文
  const stop = rest.findIndex((l) => MARKER.test(l));
  const slice = stop >= 0 ? rest.slice(0, stop) : rest;
  return slice
    .filter((l) => !MARKER.test(l))
    .join("\n")
    .replace(/^\n+/, "");
}

function dedupe(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const k = x.replace(/\s+/g, "");
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

/** 解析结果是否「可用」——正文为空即不可用（验收标准：非预期格式要提示重试，不能展示破碎内容） */
export function isUsableNote(note: XhsNote): boolean {
  return note.body.trim().length >= 20 && note.titles.length > 0;
}

/** 渲染为可整体复制的纯文本 */
export function renderNoteText(note: XhsNote, titleIndex = 0): string {
  const title = note.titles[titleIndex] ?? note.titles[0] ?? "";
  const tags = note.tags.map((t) => `#${t}`).join(" ");
  return `${title}\n\n${note.body}\n\n${tags}`.trim();
}
