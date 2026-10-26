/** 页面级 head。⚠️ layout 必须返回 fragment，标题在这里设（不能写在 layout 的 <head>）。 */
import { defineHead } from "void";

export const head = defineHead(() => ({
  title: "内容工作台 — 素材转小红书笔记",
}));
