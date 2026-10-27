# 浏览器冒烟证据（本地构建产物）

> 环境：本地 shim `http://127.0.0.1:8901`（`node:sqlite` 顶替 D1，`ACCESS_TOKEN=test-token-123`）
> 跑的是 `vite build` 产物，与线上同一份 dist，故 UI 接线行为可代表线上。
> 日期：2026-10-26

## 为什么没有截图

`page.screenshot` 全部超时。按 `perf-hang-triage` 分层判定，实测：

| 探针 | 读数 | 判读 |
|---|---|---|
| `page.evaluate` 耗时 | **5 ms** | 主线程正常（H1 排除） |
| `requestAnimationFrame` 计数（1.5s） | **0** | 不产帧（H2） |
| `setInterval` 计数（1.5s） | 16 | 定时器正常 |
| `longtask` 条目 | 0 | 无长任务 |

→ **H2 不产帧**：headless 窗口合成器不产帧，无帧可截。
（`perf-hang-triage` 已写明「`page.screenshot` 超时 ≠ 渲染进程卡死」，本次再次印证。）
故本文件用 **DOM 断言** 作为证据，而非截图。

## DOM 断言结果

| # | 验收/用例 | 断言方式 | 结果 |
|---|---|---|---|
| 1 | T12 空输入禁用 | 读按钮 `disabled` | ✅ 链接模式 `disabled=true`；切文本模式后仍 `true` |
| 2 | T12 有输入才启用 | 填入素材后读 `disabled` | ✅ `disabled=false` |
| 3 | T1/T15 流式真到达 | 轮询 `.stream-caret` 文本长度 | ✅ **5.6s** 出现首字并从 11 字开始增长 |
| 4 | T2 结构完整 | 读 `已生成 N 个标题 · M 字正文 · K 个标签` | ✅ 文本模式 3 标题 / 411 字 / 5 标签；URL 模式 3 / 625 / 5 |
| 5 | T2 无标记泄漏 | `innerText` 正则查 `[标题]` 等 | ✅ 两次均为 `false` |
| 6 | T8 四个复制按钮 | 检查按钮文案齐全 | ✅ 复制标题/正文/标签/整篇 全在 |
| 7 | T11 复制反馈 | 点「复制标题」后读按钮文案 | ✅ 变「已复制」；1.8s 后恢复「复制标题」 |
| 8 | 取消 | 生成中点「取消」 | ✅ 生成中显示「取消」；点后提示「已取消」、按钮回到「生成笔记」且可点、「取消」消失 |
| 9 | T1 真实链接抓取 | 轮询「已抓取 N 字」 | ✅ MDN Streams API：**2.0s 抓到 4,272 字**（标题 `Streams API - Web APIs \| MDN`），无错误提示 |
| 10 | T1 URL 端到端 | 等完成态 | ✅ 生成成功（3 标题 / 625 字 / 5 标签） |
| 11 | T6 历史累积 | 读 `历史记录 N` | ✅ 随生成递增（0 → 5） |

## 剪贴板

`navigator.clipboard.readText()` 在 evaluate 里 **15s 超时**：窗口无焦点时浏览器拒绝读取剪贴板（文档要求 focus + 权限）。
→ 属环境限制。**写入路径的 payload 正确性**由单测覆盖（`note.renderNoteText` 含标题+正文+标签、按 titleIndex 切换）。

## 本轮冒烟抓到并修复的缺陷

**首屏 401 闪烁**：`HistoryPanel` 挂载即发请求，而 `token` 由 `useEffect` 从 localStorage 恢复，首帧恒为 `""` → 先吃一个 401 并显示「访问令牌缺失或错误」，随后才用正确 token 重拉。

修复：新增 `tokenReady` 标记，未恢复前不发请求（`HistoryPanel` 的 effect 加 `if (!tokenReady) return`）。
复验（重建 + 重启 shim 后）：首屏 `has401=false`、`tokenField` 已恢复、历史正常加载（`历史记录 0`，因 shim 内存库重启清空）。
