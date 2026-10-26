"use client";

/** 复制按钮：复制成功给一次可见反馈（验收标准 8） */
import { useEffect, useRef, useState } from "react";

export function CopyButton({
  text,
  label = "复制",
  className = "",
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 剪贴板 API 在非安全上下文/旧浏览器不可用 → 退到 execCommand
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* 放弃 */
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  };

  return (
    <button
      type="button"
      onClick={onCopy}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
        copied
          ? "border-[var(--color-ok)] bg-[var(--color-ok-soft)] text-[var(--color-ok)]"
          : "border-[var(--color-line-strong)] bg-[var(--color-surface)] text-[var(--color-ink-2)] hover:bg-[var(--color-hover)] hover:text-[var(--color-ink)]"
      } ${className}`}
      aria-live="polite"
    >
      {copied ? "已复制" : label}
    </button>
  );
}
