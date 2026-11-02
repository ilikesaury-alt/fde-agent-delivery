/**
 * 全局布局 — Void Pages 约定
 * ⚠️ 必须返回 **fragment**，不能返回 <html>/<head>/<body>。
 * 若输出外壳标签，Void 会压平成注释标记 → DOM 与 React fiber 树错位 →
 * 聚焦表单控件时主线程阻塞 15–31s（产品① focus-hang 事故）。
 * 文档外壳由 Void 管理；head 元数据用 void.config.ts 或页面 head() 设置。
 */

import type { ReactNode } from "react";

import "../styles.css";

export default function RootLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}