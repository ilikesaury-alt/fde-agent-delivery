/**
 * 结构化切分 —— 检索质量的第一决定因素。
 *
 * 为什么不做「固定窗口瞎切」：中文文档的语义单元是标题+段落，按结构切能让
 * chunk 自带主题（headingPath），引用展示也能说清「这句话在 3.2 部署 里」。
 *
 * 策略（两级）：
 *   1. 先按 Markdown 标题（#..######）分节，记录 headingPath；
 *   2. 节内按空行分段，段落累积到 CHUNK_MAX 就切；超长单段按句子边界再切。
 *
 * 纯函数、零依赖 —— 可在任何环境跑单测（沙箱内也能）。
 */

import type { ChunkDraft } from "./types.ts";

/** 单 chunk 目标上限（字符）。bge-m3 上下文 60k token，瓶颈在我们的拼装与引用可读性 */
export const CHUNK_MAX = 800;
/** 目标下限：太碎会丢上下文，宁可合并 */
export const CHUNK_MIN = 200;
/** 相邻 chunk 的重叠（字符）：跨段语义断开时留一点粘合力 */
export const CHUNK_OVERLAP = 100;

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** 段落/句子边界：中文句号、问号、叹号、分号，英文句点后接空格 */
const SENTENCE_SPLIT_RE = /(?<=[。！？；!?;]|\.\s)\s*/;

export type SectionNode = {
  /** 「一级 / 二级 / 三级」按层级拼接的路径 */
  headingPath: string;
  lines: string[];
};

/**
 * 按标题分节。没有标题的文档整体作为一节（headingPath 为空）。
 */
export function splitSections(text: string): SectionNode[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const sections: SectionNode[] = [];
  /** 各级标题的当前文本，index = level-1 */
  const headingStack: string[] = [];
  let current: SectionNode = { headingPath: "", lines: [] };

  const flush = () => {
    if (current.lines.some((l) => l.trim())) sections.push(current);
  };

  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      flush();
      const level = m[1].length;
      headingStack.length = Math.max(0, level - 1);
      headingStack[level - 1] = m[2].trim();
      const path = headingStack.filter(Boolean).join(" / ");
      current = { headingPath: path, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  flush();
  return sections;
}

/** 把长文本按句子边界切到 ≤ max 字符（单句仍超长时硬切） */
export function splitLongText(text: string, max = CHUNK_MAX): string[] {
  if (text.length <= max) return [text];
  const sentences = text.split(SENTENCE_SPLIT_RE).filter((s) => s.length > 0);
  const out: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (s.length > max) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
      continue;
    }
    if (buf.length + s.length > max) {
      out.push(buf);
      buf = s;
    } else {
      buf += s;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * 主入口：文本 → chunk 草稿列表。
 *
 * 行为保证（都会被单测覆盖）：
 *  - 空文本 → 空数组（不产出空 chunk）
 *  - 每个 chunk 的 headingPath 来自所在节
 *  - 除最后一块，chunk 长度 ≥ CHUNK_MIN 或已被 CHUNK_MAX 限制
 *  - 相邻 chunk 带重叠，且重叠不会让 chunk 超过 CHUNK_MAX
 */
export function chunkText(text: string): ChunkDraft[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];

  const sections = splitSections(normalized);
  const drafts: ChunkDraft[] = [];
  let idx = 0;

  for (const section of sections) {
    const body = section.lines.join("\n").trim();
    if (!body) continue;

    // 先按段落聚合
    const paragraphs = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    let buf = "";

    const pushBuf = (carryOverlap: boolean) => {
      const text = buf.trim();
      if (!text) return;
      drafts.push({ idx: idx++, headingPath: section.headingPath, text });
      buf = carryOverlap ? tailOverlap(text) : "";
    };

    for (const para of paragraphs) {
      // 单段就超上限：先清空缓冲，再按句子切
      if (para.length > CHUNK_MAX) {
        pushBuf(true);
        const pieces = splitLongText(para, CHUNK_MAX);
        for (let i = 0; i < pieces.length; i++) {
          const isLast = i === pieces.length - 1;
          drafts.push({ idx: idx++, headingPath: section.headingPath, text: pieces[i] });
          if (!isLast) continue;
          // 末片留作下一段的缓冲种子
          buf = "";
        }
        continue;
      }

      if (buf.length + para.length + 2 > CHUNK_MAX) {
        pushBuf(true);
        // pushBuf(true) 会把 buf 换成重叠种子（≤ CHUNK_OVERLAP）；若种子 + 本段仍超限，
        // 必须丢掉种子，否则会产出超过 CHUNK_MAX 的 chunk（cross-review N2）。
        if (buf.length + para.length + 2 > CHUNK_MAX) buf = "";
      }
      buf = buf ? `${buf}\n\n${para}` : para;
    }
    pushBuf(false);
  }

  // 合并过碎的尾块：与前一块合并若仍不超上限
  const merged: ChunkDraft[] = [];
  for (const d of drafts) {
    const prev = merged[merged.length - 1];
    if (prev && prev.headingPath === d.headingPath && prev.text.length < CHUNK_MIN && prev.text.length + d.text.length <= CHUNK_MAX) {
      prev.text = `${prev.text}\n\n${d.text}`;
      continue;
    }
    merged.push({ ...d });
  }
  // idx 重新连续编号
  return merged.map((d, i) => ({ ...d, idx: i }));
}

/** 取尾部 N 字符作为重叠种子；尽量从句子边界开始，避免半句开头 */
function tailOverlap(text: string): string {
  if (text.length <= CHUNK_OVERLAP) return text;
  const tail = text.slice(-CHUNK_OVERLAP);
  const m = SENTENCE_SPLIT_RE.exec(tail);
  if (m && m.index !== undefined && m.index > 0 && m.index < tail.length - 1) {
    return tail.slice(m.index);
  }
  const nl = tail.indexOf("\n");
  if (nl >= 0 && nl < tail.length - 1) return tail.slice(nl + 1);
  return tail;
}
