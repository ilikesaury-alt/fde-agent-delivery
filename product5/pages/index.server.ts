/**
 * 页面级 head（标题必须在这里设置，layout 只返回 fragment）。
 */
import { defineHead } from "void";

export const head = defineHead(() => ({
  title: "AI 资讯雷达 — 多源聚合、评分精选、每日日报",
}));