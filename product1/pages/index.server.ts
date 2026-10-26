import { defineHead } from "void";

/**
 * 页面级 head。
 * 标题必须在这里设置 —— 之前写在 pages/layout.tsx 的 <head> 里是错的：
 * layout 必须返回 fragment，输出 <html>/<head>/<body> 会导致水合错位（focus-hang）。
 */
export const head = defineHead(() => ({
  title: "会议日报 — 原始记录转结构化纪要",
}));
