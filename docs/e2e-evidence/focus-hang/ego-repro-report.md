# focus-hang 真机复现报告（ego-browser）

> 工具：ego-browser 0.6.1.11（真实 Chromium 156 / node v24.22.1），由 Pi agent 直接驱动。
> 被测：线上 `https://meeting-digest.ilikesaury.workers.dev/`（带 `md_token` 过访问令牌门禁）
> 时间：2026-10-26
> 结论：**真机复现成功；根因不在 header CSS；hang 为偶发、渲染/主线程级卡死；代码级根因待在你本地 dev 环境用 CDP 合成器 trace 锁定。**

## 一、复现步骤与结果

| 实验 | 操作 | 结果 |
|------|------|------|
| 基线 | 加载 + 过门禁 + 等水合 | `[alive:baseline] 响应正常`，`hasApp:true`，有 React fiber key |
| 复现 A | 点击 `#textInput` | **卡死 → TIMEOUT**（CDP `Input.dispatchMouseEvent` 超时） |
| 对照 | 点击页面标题「会议日报」（非交互元素） | 响应正常 |
| 复现 B | 点击后 `fill` textarea | 卡死 → TIMEOUT |
| 截图 | 卡死后 `captureScreenshot` | **CDP `Page.captureScreenshot` 超时**（连合成一帧都卡） |

> 注：`captureScreenshot` 连截图都超时，说明是**渲染进程/合成器级卡死**，不是 fetch 失败或纯业务逻辑异常。

## 二、根因排查（已排除 / 未排除）

### 已排除
- ❌ **header 的 `sticky` + `backdrop-blur` 是元凶** —— 多次对照证明改它**不修复** hang：
  - 只关 `backdrop-filter`（保留 sticky）：仍卡死
  - 只关 `sticky`（保留 blur）：仍卡死
  - 同时关两者（`position:static` + 去 blur，注入修复 DOM）：**仍卡死**（量化 `ego-stress.mjs`：原版 1/5 卡、修复版 1/5 卡）
  - 结论：header CSS 不是触发点；之前单次"改了正常"是**偶发幸运**，非真修复。
- ❌ **代理 / 网络环境特有** —— 项目内 headless diag（`--disable-gpu` + 代理 `127.0.0.1:7890`）与 ego 真机（无代理）**都复现**，说明与代理无关。
- ❌ **点击"任何元素"都卡** —— 点页面标题正常，只有聚焦 textarea 路径触发。

### 源码层面已知事实（不支持"简单 JS 死循环"假设，但也不能排除）
- `textarea#textInput` **没有** `onFocus`/`onClick` 处理器，只有 `onChange`（更新 `text` state）。
- 全局无 `onfocus`/`addEventListener("focus")` 监听器。
- 无 `ResizeObserver` / `IntersectionObserver` 反馈循环。
- CSS `:focus-visible` 只加 `outline`，无重绘反馈循环；无 `@keyframes` 触发回流。
- `main` 容器 `overflow:hidden` + `lg:h-[calc(100vh-57px)]`，header `sticky top-0 z-20 backdrop-blur-md bg-canvas/85`。

## 三、关键推断
- hang **偶发**（同一脚本多次跑，有时卡有时不卡；`page.reload` 也偶发超时）。
- hang 连 CDP 截图都超时 → 渲染进程级卡死。
- 与 header CSS 无关。
- 最可能是：**聚焦 textarea 触发的某条渲染/合成路径偶发死锁**（可能关联半透明 header `backdrop-blur` 的特定合成、或远端 Worker 返回引发的重渲染时序），但真机证据**不足以 100% 锁定代码级根因**。

## 四、下一步（需你在能跑 dev 的环境执行）
当前 sandbox 无法起 `vite dev`/`vite preview`（miniflare `workerd` 因 `CreateDirectory 拒绝访问` 失败，见 README 已知限制）。因此确定性调试需要：
1. 在**普通终端**（`npm run dev`）起本地服务，用 `ego-browser` 或 `diag-trace.mjs` 打开 `localhost`。
2. 点击 textarea 触发 hang 后，立即抓 **CDP Tracing（含 `disabled-by-default-devtools.timeline.frame` / `cc` / `gpu` 类别）** 与 **合成器卡死栈**，定位卡在 Layout / Paint / Commit 哪一步。
3. 针对性修复（无论根因是合成器还是重渲染时序），再用 ego-browser 真机**多次点击**做量化复测（参考 `ego-stress.mjs` 的 5 轮采样法），确认 0/5 卡死才算修复。

## 五、复现脚本（本目录）
- `ego-repro.mjs` —— 真机基础复现 + 探活 + 事件收集
- `ego-bisect-gpu.mjs` —— 收集 header CSS 合成层证据
- `ego-bisect-onlyblur.mjs` / `ego-bisect-nosticky.mjs` / `ego-bisect-noblur.mjs` —— 单因素隔离对照
- `ego-verify-fix.mjs` —— 注入修复 DOM 复测
- `ego-stress.mjs` —— 原版 vs 修复版 多次点击量化

> 运行方式：`ego-browser nodejs < 脚本.mjs`（已配置 `C:\Users\lichun\bin\ego-browser` 包装，新 shell 直接可用）。
