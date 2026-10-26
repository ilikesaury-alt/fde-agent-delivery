"use client";

/** 一条小红书笔记的展示：主标题 + 备选标题 + 正文 + 标签，各自可独立复制。 */

import { useState } from "react";

import { CopyButton } from "./CopyButton.tsx";
import { renderNoteText } from "../lib/note.ts";
import type { XhsNote } from "../lib/types.ts";

export type NoteView = XhsNote;

export function NoteCard({
  note,
  titleIndex,
  onSelectTitle,
  live = false,
}: {
  note: NoteView;
  titleIndex: number;
  onSelectTitle?: (i: number) => void;
  /** 流式中：显示光标、不显示完整复制区 */
  live?: boolean;
}) {
  const title = note.titles[titleIndex] ?? note.titles[0] ?? "";
  const tagsLine = note.tags.map((t) => `#${t}`).join(" ");
  const [showAllTitles, setShowAllTitles] = useState(false);

  return (
    <article className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] shadow-[var(--shadow-sm)]">
      {/* 标题 */}
      <header className="border-b border-[var(--color-line)] px-5 py-4">
        <div className="mb-1 flex items-center justify-between gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-ink-3)]">
            主标题
          </span>
          <CopyButton text={title} label="复制标题" />
        </div>
        <h2 className="title-candidate text-[var(--color-ink)]">{title || "（生成中…）"}</h2>

        {note.titles.length > 1 && (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setShowAllTitles((v) => !v)}
              className="text-xs text-[var(--color-brand)] hover:underline"
            >
              {showAllTitles ? "收起备选标题" : `备选标题 ${note.titles.length - 1} 个`}
            </button>
            {showAllTitles && (
              <ul className="mt-2 space-y-1.5">
                {note.titles.map((t, i) => (
                  <li
                    key={`${i}-${t}`}
                    className="flex items-start gap-2 rounded-md bg-[var(--color-inset)] px-3 py-2"
                  >
                    <button
                      type="button"
                      onClick={() => onSelectTitle?.(i)}
                      className={`flex-1 text-left text-sm leading-relaxed ${
                        i === titleIndex
                          ? "font-semibold text-[var(--color-brand)]"
                          : "text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
                      }`}
                      title="点击设为主标题"
                    >
                      {t}
                    </button>
                    <CopyButton text={t} label="复制" />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </header>

      {/* 正文 */}
      <div className="px-5 py-4">
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-ink-3)]">
            正文 · {note.body.length} 字
          </span>
          <CopyButton text={note.body} label="复制正文" />
        </div>
        <div className={`note-body ${live ? "stream-caret" : ""}`}>{note.body}</div>
      </div>

      {/* 标签 */}
      <footer className="flex items-start justify-between gap-3 border-t border-[var(--color-line)] px-5 py-3">
        <div className="flex flex-wrap gap-1.5">
          {note.tags.length === 0 ? (
            <span className="text-xs text-[var(--color-ink-3)]">（无标签）</span>
          ) : (
            note.tags.map((t) => (
              <span
                key={t}
                className="rounded-full bg-[var(--color-brand-soft)] px-2.5 py-0.5 text-xs text-[var(--color-brand)]"
              >
                #{t}
              </span>
            ))
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <CopyButton text={tagsLine} label="复制标签" />
          <CopyButton
            text={renderNoteText(note as XhsNote, titleIndex)}
            label="复制整篇"
          />
        </div>
      </footer>
    </article>
  );
}
