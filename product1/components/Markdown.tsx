/**
 * 受限 Markdown 渲染器（React）
 * --------------------------------------------------------------------------
 * 解析逻辑在 ./markdown-parse.ts（纯函数，可单测）。
 * 用 React 元素构建，**不使用 dangerouslySetInnerHTML**，因此天然无 XSS。
 *
 * 为什么不用 marked + DOMPurify：那两个加起来 ~80KB，且要额外维护消毒规则。
 * 受限渲染器零依赖、零注入面，代价是语法支持窄 —— 对固定 6 板块的输出刚好够。
 */

import type { ReactNode } from "react";

import { parseMarkdown } from "./markdown-parse.ts";

/** 行内解析：**加粗** 与 `代码` */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[2] !== undefined) {
      nodes.push(<strong key={`${keyPrefix}-b-${i++}`}>{m[2]}</strong>);
    } else if (m[4] !== undefined) {
      nodes.push(<code key={`${keyPrefix}-c-${i++}`}>{m[4]}</code>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** 渲染受限 Markdown */
export function Markdown({ source }: { source: string }) {
  const blocks = parseMarkdown(source);

  return (
    <>
      {blocks.map((b, idx) => {
        const key = `blk-${idx}`;
        switch (b.kind) {
          case "h2":
            return <h2 key={key}>{renderInline(b.text, key)}</h2>;
          case "h3":
            return <h3 key={key}>{renderInline(b.text, key)}</h3>;
          case "p":
            return <p key={key}>{renderInline(b.text, key)}</p>;
          case "ul":
            return (
              <ul key={key}>
                {b.items.map((it, j) => (
                  <li key={`${key}-${j}`}>{renderInline(it, `${key}-${j}`)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={key}>
                {b.items.map((it, j) => (
                  <li key={`${key}-${j}`}>{renderInline(it, `${key}-${j}`)}</li>
                ))}
              </ol>
            );
          case "table":
            return (
              <table key={key}>
                <thead>
                  <tr>
                    {b.head.map((h, j) => (
                      <th key={`${key}-h-${j}`}>{renderInline(h, `${key}-h-${j}`)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((row, r) => (
                    <tr key={`${key}-r-${r}`}>
                      {row.map((cell, c) => (
                        <td key={`${key}-r-${r}-c-${c}`}>
                          {renderInline(cell, `${key}-r-${r}-c-${c}`)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          default:
            return null;
        }
      })}
    </>
  );
}
