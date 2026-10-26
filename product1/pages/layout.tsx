/**
 * 全局布局 — Void Pages 约定
 * --------------------------------------------------------------------------
 * ⚠️ 关键：这里必须返回 **fragment**，不能返回 <html>/<head>/<body>。
 * Void 把 layout 的返回值挂到自己的根容器 <div id="app"> 内；
 * 若在此输出 html/head/body，Void 会把它们压平成注释标记（<!--html--><!--head-->…），
 * 造成 DOM 与 React fiber 树错位 —— 表现为聚焦表单控件时 React 的
 * Wt()/fm() 反查 fiber 走入兜底遍历，主线程被阻塞 30 秒（focus-hang）。
 *
 * 文档外壳（html/head/body）由 Void 管理；
 * head 元数据用 void.config.ts 的 head 配置或页面 head() 设置。
 *
 * 本文件负责：引入全局样式（唯一能保证样式进入产物的位置）。
 */

import type { ReactNode } from "react";

import "../styles.css";

export default function RootLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
