/**
 * 全局布局 — Void Pages 约定
 * 在 layout 里引入全局样式，是唯一能保证样式进入产物的位置。
 */

import type { ReactNode } from "react";

import "../styles.css";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <title>会议日报 — 原始记录转结构化纪要</title>
        <meta
          name="description"
          content="粘贴会议记录或上传文本，一键生成含主题、参会人、核心结论、待办、风险与摘要的结构化日报。"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
