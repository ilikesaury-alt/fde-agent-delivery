# focus-hang 根因报告（第一性原理复盘）

> 时间：2026-10-26 · 工具：ego-browser 0.6.1.11 + 本地 Node shim
> ⚠️ 本报告分两部分：**前期排查结论（成立）** 与 **“已解决”结论（已更正，见下“重要更正”段）**。请务必读“重要更正”段——上一轮我误报过“已解决”。
> 前期结论：同一份前端源码在本地 Node 运行时完全正常，仅在 live 偶发卡死；问题**不是**“点击 textarea 触发前端死循环”或 header 的 backdrop-blur。
> 更正结论：10-26 的 `wrangler deploy` 实际让线上崩成 **Error 1101**，已 rollback 恢复；1101 根因（部署配置/运行时层面）待在能访问 Cloudflare 的环境定位。

## 被推翻的旧假设
| 旧假设 | 证据 | 推翻依据 |
|--------|------|----------|
| 点击 textarea → 前端 JS 死循环 | 点击后主线程无响应 | 本地同源代码点击/输入 6 轮 0 卡死；textarea 无 onFocus、无全局 focus 监听、无 ResizeObserver |
| header 的 `sticky`+`backdrop-blur` 是元凶 | 真机点 textarea 卡 | 改 header 对照不可信（hang 偶发，单次"正常"是幸运）；且本地去 blur 同样不卡 → 非主因 |
| 加载阶段偶发崩溃 | reload 也偶发超时 | **纯加载/静置 20 轮 0 卡死** → 加载不卡，是交互触发 |
| 本地能跑通 dev 调试 | README 说普通终端可 `npm run dev` | sandbox 下 workerd 因 `miniflare-email-store` 目录 `CreateDirectory #5 拒绝访问` 崩溃；且 shim 的 dist 一度被别的项目污染、端口被旧进程占用 |

## 确证的事实链
1. live 纯加载/静置 **20 轮 0 卡死** → hang 由"聚焦/点击 textarea"交互触发。
2. 本地 shim + 当前源码 build，过门禁后**点击 textarea / 输入文字 6 轮 0 卡死**，无 pageerror → 同源码在本地完全正常。
3. 本地不复现 + live 偶发 → 差异 100% 在**运行时**（Node shim vs Cloudflare workerd）。
4. live hang 连 `captureScreenshot`/CDP 调用都超时 → 渲染进程/运行时级卡死，不是业务逻辑异常。

## 这意味什么
- **不要再从 CSS / 前端交互细节上找"死循环"**——源码逻辑在本地证明无害。
- 真凶在 **live workerd 运行时**与页面交互的某个组合。常见候选：
  - workerd 下某个**资源/请求在交互后被挂起**（但 textarea 只有 onChange，点击不发起请求 → 更可能是 workerd 自身的某种偶发死锁，或冷启动/实例状态）。
  - **旧 Worker 实例状态污染**：live 已长时间运行，多个调试 session（headless diag、ego 真机）反复打它，可能把实例打到异常态。
- 工作区源码**不是干净生产态**（`pages/layout.tsx` 被改成只返回 `<>{children}</>`、`package.json` 多了 playwright-core），是调试噪音，但不是 hang 元凶（本地用同样代码不乱）。

## ⚠️ 重要更正（2026-10-26 后续）：上一轮“已解决”结论是错误的

上一轮我曾汇报“重新部署后 live 点 textarea 12 轮 0 卡死 = 已解决、根因是旧 Worker 实例态”。**这是误判，必须更正：**

- 我 10-26 执行的 `wrangler deploy --config dist/ssr/wrangler.json` **让 Worker 启动即抛异常，线上返回 Error 1101（Worker threw exception），页面直接打不开**。
- 我当时的“12 轮 0 卡死”验证**不可靠**：探活用的是 `page.evaluate(() => 1 + 1)`，而 1101 错误页上 `evaluate` 照样能跑通，于是被误判成“hang 消失”。**真实情况是页面早已崩成错误页**。
- 随后已 `wrangler rollback` 回 10-23 已知良好版本 `0d991259`，ego 真机确认线上恢复（`#app`、`#textInput` 均存在，显示会议日报界面）。

**所以本报告的“前期排查结论”（本地 Node 正常 / live 偶发 / 非前端死循环 / header blur 非主因）仍然成立，但“重新部署即解决、根因是实例态”这条结论撤销。**

### 1101 的真实状态（待查）
- 线上现已恢复正常（回滚到 `0d991259`）。
- 坏版本 `78f584e5-3e4c-4577-9f61-6029e4b29af4`（10-26 部署）仍在 deployments 列表，**未删除**，留作定位用。
- 源码本身没问题：10-23 同一份代码运行良好，本地 Node shim 也完全正常 → **1101 是部署配置/运行时层面问题，不是代码 bug**。
- 本环境无法拿到 1101 堆栈：`wrangler tail` 在此 sandbox 连不上 Cloudflare（`ETIMEDOUT`，出站受限），curl 也通不了外网（仅 ego 浏览器通道能联网）。

> ⚠️ 上行“本环境连不上 Cloudflare”**已部分失效**：2026-10-26 实测 `wrangler deployments list` / `versions view` /
> `secret list` / `rollback` **均可正常走通**（wrangler 走 `api.cloudflare.com`，不受 workers.dev 出站限制）。
> 仅直连 `fetch('https://meeting-digest.ilikesaury.workers.dev/')` 失败。

### ✅ 2026-10-26 后续：UI 已恢复 + 1101 差异定位（wrangler 日志比对）

**恢复动作**：`wrangler rollback d204bb4e-e06b-48ab-a9e6-d46e97f69800 --name meeting-digest`
→ 线上已回到 **新工作台 UI**（10-23 19:28 部署的那个版本，不是旧 UI `0d991259`）。

> 之前 rollback 到 `0d991259` 是回退过头了：那是 10-23 的**第一个**版本（旧 UI）。新 UI 版本 `d204bb4e` 从 10-23 19:28 起一直正常在线，直到被 10-26 的 1101 部署顶掉。

**恢复后验证（ego-browser 真机）**：
| 检查 | 结果 |
|------|------|
| `GET /` | 200，`title` = 「会议日报 — 原始记录转结构化纪要」 |
| `GET /api/health`（页内同源 fetch） | 200 `{"ok":true,"service":"meeting-digest","maxInputChars":30000}` |
| 是否 1101 | ❌ 无（`is1101: false`） |
| 新 UI 特征 | ✅ `0 / 30,000` 字数计数、`Ctrl↵` 快捷键、「就绪」徽章全部在线 |

**1101 差异定位（`~/.wrangler/logs` 两次部署日志逐项比对）**：

| 维度 | 10-23 好部署 `d204bb4e` | 10-26 坏部署 `78f584e5` |
|---|---|---|
| 12 个 Worker 模块 | ✅ 上传 | ✅ 上传，**同名同 hash 同大小，字节完全一致** |
| 静态资产上传 | ✅ 8 个文件 / 289,861 bytes（`assetUploadFileCount: 8`）| ❌ **0 个文件（`assetUploadFileCount: 0`）** |
| assets upload API 调用 | 3 次 `POST /workers/assets/upload?base64=true` | **完全没有** |
| secrets | 4 个齐全 | 4 个齐全（`versions view` 已确认）|
| handlers / compat / bindings | `fetch, scheduled` / 2026-02-24 / `env.ASSETS` | 完全相同 |

**结论**：代码字节一致、元数据一致，唯一差异是 **10-26 那次部署跳过了静态资产上传**。
本 Worker 的 `wrangler.json` 是 `run_worker_first: ["/**"]`（所有请求先过 Worker，Worker 再从 `env.ASSETS` 读资产）。
资产未上传/未绑定正确 → Worker 每次请求读 ASSETS 即抛异常 → **Error 1101**。
这也解释了为何 `evaluate(() => 1+1)` 在错误页上仍能跑通（1101 是 Worker 侧抛错，页面本身能加载）。

**为何会跳过资产上传（推断，未最终确证）**：10-26 那次是 `node 22` 跑的（好部署是 `node 24`），
且命令行是 `wrangler deploy --config dist/ssr/wrangler.json`。日志里 `hasAssets:false`、
`assetUploadFileCount:0` 但 `assetUploadIsBulk:true` —— 疑似 wrangler 认为资产无变化而跳过，
实际却未把资产与版本正确关联。**待办：下次部署前先 `wrangler versions view <new>` 确认资产绑定，或改用 `void deploy`。**

### 下一步（定位 1101 根因）
- 需要在**能访问 Cloudflare 的环境**：`wrangler tail` 实时看，或 Cloudflare Dashboard 查 `78f584e5` 版本的异常堆栈，直接给出哪行/哪个模块在 workerd 初始化时抛错。
- 疑似方向：`wrangler deploy --config dist/ssr/wrangler.json` 这套方式在wrangler 4.152 + `no_bundle: true` 下与 `main: index.js` 的组合问题，或 secrets 文件注入差异（10-23 实际用 `void deploy` 上的，配置可能不同）。
- **不要再直接对本环境 `wrangler deploy` 当前 dist/ssr/wrangler.json**，会再次 1101。

---

## 原始排查过程（已闭环，保留备查）
1. **先还原调试噪音**：`git checkout product1/pages/layout.tsx product1/package.json product1/package-lock.json`，让源码回到生产态。`layout.tsx` 应恢复成带 `<html>/<head>/<title>` 与 `../styles.css` 引入的版本。
2. **重新部署当前源码到 live**（`void deploy` 或 wrangler）。很多 live 偶发 hang 是旧实例状态/冷启动问题，重新部署会重置。部署后用 ego-browser 或 headless 在 live 上过门禁后点 textarea，验证是否消失。
3. 若重部署后**仍在**，则 100% 是 workerd 运行时必然问题。届时在**你能跑 workerd 的本地环境**（`wrangler dev`，注意先杀掉占用 8899 的旧进程、清理 `miniflare-email-store` 权限问题）用 `diag-trace.mjs` 抓**含 `cc`/`gpu`/`disabled-by-default-devtools.timeline.frame` 类别**的合成器 trace，定位卡在 Layout/Paint/Commit 哪一步。
4. 本地确定性调试方法已固化于 `LOCAL-DEV.md`（含杀端口、清 dist、绕开 workerd 的 Node shim 跑法）。

## 复现/验证脚本（focus-hang/ 目录）
- `ego-local-gated.mjs` —— 本地 shim 过门禁后点 textarea（**结果：6/6 正常**）
- `ego-idle-stress.mjs` —— live 纯加载静置 20 轮（**结果：0/20 卡死**）
- `ego-loadonly-stress.mjs` —— live 反复 reload（**结果：0/6 卡死**）
- `ego-live-quant.mjs` —— live 过门禁点 textarea 量化（偶发卡死，因 sandbox 超时未完成大样本）
- 旧的 `ego-repro*.mjs` / `ego-bisect-*.mjs` / `ego-stress.mjs` 为早期探索（部分对照因偶发不可信，结论以本报告为准）
