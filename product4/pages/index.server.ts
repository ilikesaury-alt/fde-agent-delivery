/**
 * 页面级 head。
 * 标题必须在这里设置 —— layout 必须返回 fragment，输出 <html>/<head>/<body>
 * 会导致水合错位（产品① focus-hang 事故的根因）。
 */
import { defineHead } from "void";

export const head = defineHead(() => ({
  title: "体检指标追踪 — 报告结构化、趋势与克制的 AI 解读",
}));