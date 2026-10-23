/**
 * 受限 Markdown 解析器（纯逻辑，无 React 依赖）
 * --------------------------------------------------------------------------
 * 只支持日报实际用到的语法：## / ### 标题、- / 1. 列表、| 表格 |、段落。
 * 行内（加粗/代码）由渲染层处理。
 *
 * 抽成独立 .ts 是为了能被 Node 直接测试（.tsx 无法被 strip-types 加载）。
 */

export type Block =
  | { kind: "h2"; text: string }
  | { kind: "h3"; text: string }
  | { kind: "p"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "table"; head: string[]; rows: string[][] };

/** 把表格行拆成单元格，去掉首尾空列 */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

/** 判断是否是表格分隔行：| --- | :--: | */
function isSeparator(line: string): boolean {
  return /^\|?[\s:-]*-{2,}[\s:|-]*\|?$/.test(line.trim());
}

export function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // 标题
    if (/^###\s+/.test(trimmed)) {
      blocks.push({ kind: "h3", text: trimmed.replace(/^###\s+/, "") });
      i++;
      continue;
    }
    if (/^##?\s+/.test(trimmed)) {
      blocks.push({ kind: "h2", text: trimmed.replace(/^##?\s+/, "") });
      i++;
      continue;
    }

    // 表格：当前行含 |，且下一行是分隔行
    if (trimmed.includes("|") && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const head = splitRow(trimmed);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].trim().includes("|")) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ kind: "table", head, rows });
      continue;
    }

    // 无序列表
    if (/^[-*+]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*+]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    // 有序列表
    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+[.)]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }

    // 段落：聚合到空行或下一个块级标记
    const para: string[] = [trimmed];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,3}\s|[-*+]\s|\d+[.)]\s)/.test(lines[i].trim())
    ) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push({ kind: "p", text: para.join(" ") });
  }

  return blocks;
}
