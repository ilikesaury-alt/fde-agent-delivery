/**
 * 页面级 head。
 * 标题必须在这里设置 —— layout 必须返回 fragment，输出 <html>/<head>/<body>
 * 会导致水合错位（产品① focus-hang 事故的根因）。
 * 缺失本文件时浏览器标签页标题为空（线上实测过）。
 */
import { defineHead } from "void";

export const head = defineHead(() => ({
  title: "知识库问答 — 私有文档带引用作答",
}));