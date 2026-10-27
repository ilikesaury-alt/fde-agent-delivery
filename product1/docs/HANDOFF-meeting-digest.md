# HANDOFF — 会议日报生成器（产品 ①，v2 Void 版）

> 供未来会话冷启动：从哪接着干、哪些已验证、哪些是猜测。

## 当前 revision
未提交（工作区 diff）。v2 重做中：旧 v1 手写栈已移至 `legacy/`（gitignore），主目录为 `product1/`。

## 复现 / 验证命令
```bash
cd H:\Work\Projects\Personal\fde-agent-delivery\product1
node node_modules/typescript/bin/tsc --noEmit          # 类型检查
node --experimental-strip-types test/run.ts            # 29 项测试
node node_modules/vite/bin/vite.js build               # 构建
node node_modules/vite/bin/vite.js dev --port 5210     # 本地起服（需无沙箱限制）
```
Node 24：`C:\Users\lichun\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`

## 已验证（事实）
- **测试 29/29 通过**（21 纯函数 + 8 Void 路由层）。
- `tsc --noEmit` **exit 0**。
- `vite build` **成功**：SSR 85 modules + client 25 modules，235ms。
- **`void --version` = 0.10.13 可运行**（CLI 本身不 spawn）。
- **`vite build` 不 spawn**：Void 生成的 `wrangler.json` 带 `"no_bundle": true`，
  Vite 用 Rolldown/Oxc 预打包，wrangler 只上传 → 绕过了 esbuild service。
- **真实 E2E 证据已归档**：`product1/docs/e2e-evidence/T01-digest-output.json` 是 v1 期用真实 magpie
  凭据生成的日报，6 板块齐全、表格正确、内容忠于原文。v2 复用同一 `lib/prompt.ts`，证据仍有效。

## 已验证为环境限制（非代码缺陷）
- **`vite dev` 失败**：`ERR_RUNTIME_FAILURE` — `@cloudflare/vite-plugin` 内部 miniflare 需 spawn
  `workerd`，沙箱禁止 confined spawn。构建不受影响。
- `npm install` 必须 `--ignore-scripts`（esbuild/workerd postinstall 要 spawn 下载二进制）。
- `.npmrc` 需 `cache=./.npm-cache`（默认缓存目录不可写）。

## 猜测 vs 已验证
| 项 | 状态 |
|----|------|
| 测试/typecheck/build 通过 | ✅ 已验证 |
| void CLI 可运行 | ✅ 已验证 |
| vite build 可用（no_bundle 绕 esbuild） | ✅ 已验证 |
| vite dev 因 workerd spawn 失败 | ✅ 已验证 |
| 普通终端能 `npm run dev` | ⚠️ 推测，未验证 |
| magpie 真实调用（v2 路径） | ⚠️ 未验证（v1 期证据可用作旁证） |
| `void deploy` / `wrangler deploy` 到 Cloudflare | ✅ 10-23 上线成功；⚠️ 10-26 用 `wrangler deploy --config dist/ssr/wrangler.json` 导致 1101（根因已定位：该次部署**跳过静态资产上传**）。已 `wrangler rollback d204bb4e` 恢复新 UI。部署后必查 `versions view` 资产绑定 |
| wrangler 已 OAuth 登录可直连部署（绕过 void 云凭据） | ✅ 已验证 |
| 本地 dev：用 Node shim（`e2e/server.mjs`）绕开 workerd 跑通 SSR | ✅ 已验证 |

## focus-hang 排查（2026-10-26，含重要更正）

> **✅ 已解决。最终根因报告：`product1/docs/e2e-evidence/focus-hang/ROOT-CAUSE-FINAL.md`**
>
> 根因是**我们自己的代码**：`pages/layout.tsx` 返回 `<html>/<head>/<body>`，违反 Void Pages 约定（layout 必须返回 fragment）。
> Void 把 layout 输出挂到 `<div id="app">` 内 → `<meta>/<title>` 进了 `#app`、`html/head/body` 被压成注释 → SSR 水合错位
> → React 聚焦表单控件时 `Wt()→fm()` 反查 fiber 缓存永不命中、反复遍历上万次 → 主线程阻塞 15–31 秒。
>
> **修复**：layout 改返回 `<>{children}</>`；head 移到 `void.config.ts` + `pages/index.server.ts` 的 `defineHead()`。
> **验证**：聚焦 textarea 15,651ms → **0ms**；20 轮点击 **0/20 卡死**；线上 `a62f2e7f` 真实 LLM 生成 6 板块齐全。
>
> 下文为**历史排查过程**，其中若干结论已被推翻，仅作存档。

**现象**：线上点击/聚焦 textarea 偶发卡死（连 CDP 截图都超时），几天未定位。

**前期排查结论（成立）**：
- 旧假设「点击 textarea 触发前端死循环 / header 的 `backdrop-blur` 是元凶」**均被推翻**。
- 决定性对照：**同一份源码在本地 Node 运行时（shim）点 textarea 6 轮 0 卡死**，而 live 偶发卡死 → 差异在运行时（Node vs Cloudflare workerd），**非源码逻辑 bug**。
- live 纯加载/静置 20 轮 0 卡死 → 卡死由交互触发，非加载崩溃。

**⚠️ 重要更正**：我曾误报“重新部署即解决、根因是旧 Worker 实例态”。**实为误判**——当时探活用 `evaluate(()=>1+1)`，在 1101 错误页上也能跑通，被错判成“hang 消失”。真相是：**10-26 那次 `wrangler deploy` 让 Worker 启动即抛异常，线上直接 1101 打不开**。已 `wrangler rollback` 回 10-23 好版本 `0d991259`，ego 真机确认恢复。

**✅ 2026-10-26 收尾（UI 已恢复 + 1101 差异已定位）**
- **UI 恢复**：`wrangler rollback d204bb4e-e06b-48ab-a9e6-d46e97f69800 --name meeting-digest`
  → 线上回到 **新工作台 UI**（10-23 19:28 部署）。之前回滚到 `0d991259` 是**回退过头**（那是当天第一个版本 = 旧 UI）。
  真机验证：`title`「会议日报 — 原始记录转结构化纪要」、无 1101、`0 / 30,000` 计数 + `Ctrl↵` + 「就绪」徽章在线、`GET /api/health` 200。
- **1101 差异定位**：比对 `~/.wrangler/logs` 两次部署日志：
  12 个 Worker 模块**同名同 hash、字节完全一致**；secrets（4 个）、handlers、compat、bindings 全部一致。
  **唯一差异：10-26 那次 `assetUploadFileCount: 0` —— 跳过了静态资产上传**（好版本是 8 个文件 / 289,861 bytes，3 次 `POST /workers/assets/upload`）。
  本 Worker 是 `run_worker_first: ["/**"]`，所有请求先过 Worker 再从 `env.ASSETS` 取资产；资产没绑对 → 每次请求抛异常 → 1101。
- **部署铁律（新增）**：部署后必须 `wrangler versions view <id>` 确认资产绑定；勿在 node 22 下用 `wrangler deploy --config dist/ssr/wrangler.json`（好部署用的是 node 24）。

**待办**：1101 是部署配置/运行时层面问题（非代码 bug，10-23 同代码正常、本地 shim 也正常）。需在**能访问 Cloudflare 的环境**用 `wrangler tail` 或 Dashboard 查坏版本 `78f584e5` 的异常堆栈定位。坏版本已保留未删。
**注意**：本环境勿再直接 `wrangler deploy` 当前 `dist/ssr/wrangler.json`，会再次 1101。
证据与完整复盘：`product1/docs/e2e-evidence/focus-hang/ROOT-CAUSE-REPORT.md`（含“重要更正”段）、`LOCAL-DEV.md`、各 `ego-*.mjs`。

## ✅ focus-hang 已解决（2026-10-26 晚，最终）

**根因**：`pages/layout.tsx` 返回 `<html>/<head>/<body>`，违反 Void Pages 约定（layout 必须返回 fragment）。
Void 把 layout 输出挂进 `<div id="app">` → `<meta>/<title>` 进了 `#app`、`html/head/body` 被压成注释 → **SSR 水合错位**
→ React 聚焦表单控件时 `Wt()→fm()` 反查 fiber 缓存永不命中、反复遍历上万次 → 主线程阻塞 15–31 秒。

**修复**：`layout.tsx` 改返回 `<>{children}</>`；head 移到 `void.config.ts` 站点配置 + `pages/index.server.ts` 的 `defineHead()`。

**验证**：聚焦 textarea **15,651ms → 0ms**；20 轮连续点击 **0/20 卡死**；线上版本 `a62f2e7f` 真实 LLM 生成 6 板块 + 表格，全程最大长任务仅 115ms。

完整报告：`product1/docs/e2e-evidence/focus-hang/ROOT-CAUSE-FINAL.md`

## LLM 接入（2026-10-26 更新）

- 新隧道：`https://corporate-relationship-possibility-considered.trycloudflare.com`（旧 `tahoe-mainland-selection-cigarette` 已失效）
- 模型：`group/cheap-first`（便宜优先路由组，实际路由 `deepseek-v4.1-flash`）
- 隧道重启后域名会变，用 `wrangler versions secret put MAGPIE_BASE_URL` 更新，**无需重新部署代码**

## pi Skill 配置

本项目沉淀的 2 个 Skill（`perf-hang-triage`、`cf-worker-local-env`）
真源在 `E:/Obsidian/lic-notebook/skills/`，项目内 `.pi/skills/` 为 junction 链接（不进 git）。
重建步骤见 `docs/pi-skills-setup.md`。

## 未解决 / 待办
1. **预留接口未迁入**：v1 的 `transcribe.ts`（ASR）/`chunk.ts`（分块）在 v2 未建，如需要应由 `routes/` 承接。
2. **隧道为临时方案**：cloudflared 重启/断网 → 域名变 → 需更新 secret（电脑关机也调不通）。
3. **真实用户感知未验证**：focus-hang 的 15–31 秒阻塞是否影响真人交互，尚未用真实浏览器手动验证（自动化工具已确认修复）。
