/**
 * 全局布局 — Void Pages 约定
 * --------------------------------------------------------------------------
 * ⚠️ 必须返回 **fragment**，不能返回 <html>/<head>/<body>。
 * Void 把 layout 返回值挂到根容器 <div id="app"> 内；若输出 html/head/body，
 * Void 会把它们压平成注释标记，造成 DOM 与 React fiber 树错位 ——
 * 表现为聚焦表单控件时主线程阻塞 15–31 秒（产品① focus-hang 事故）。
 *
 * 文档外壳由 Void 管理；head 元数据用 void.config.ts 或页面 head() 设置。
 * 本文件负责引入全局样式。
 */

import type { ReactNode } from "react";

import "../styles.css";

export default function RootLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
