# 本地开发环境跑通（focus-hang 调试用）

> 第一性原理排查结论：同一份源码在 **本地 Node 运行时（shim）完全正常**，
> 仅在 **live（Cloudflare workerd 运行时）偶发卡死**。所以调试要在本地确定性跑通。

## 关键坑（已踩过）
1. **端口占用**：旧的 shim 进程（甚至别的项目的 shim）可能仍占着 8899，导致新 shim 起不来、curl 打到旧服务。
   - 这个 shell 里 **`pkill` 不存在**，要用 Node 杀：
     ```js
     // kill-8899.mjs
     import { execSync } from "node:child_process";
     const out = execSync("netstat -ano | findstr :8899").toString();
     [...new Set(out.trim().split("\n").map(l => l.trim().split(/\s+/).pop()).filter(p => /^\d+$/.test(p)))]
       .forEach(p => { try { process.kill(p, "SIGKILL"); console.log("killed", p); } catch {} });
     ```
   - 或 `node kill-8899.mjs`，确认 `curl 127.0.0.1:8899/` 返回 000 再继续。
2. **dist 被污染**：`product1/dist` 曾被别的项目构建产物覆盖（曾返回 `rts 面板·沪深飙升`）。
   - 先 `rm -rf product1/dist` 再 `npm run build` 重建。
3. **沙箱起不了 workerd**：`wrangler dev` / `void` 的 miniflare 会因 `miniflare-email-store` 目录 `CreateDirectory #5 拒绝访问` 崩溃（workerd 在 Windows/sandbox 的 FS 限制，与业务代码无关）。**不要在这条路上耗**。

## 跑通步骤（纯 Node，绕开 workerd）
```bash
cd product1
rm -rf dist                 # 清掉可能被污染的旧 dist
npm run build               # 重新构建（需完整 node，见下方 PATH 说明）
# 起本地 shim（纯 Node 跑 SSR worker bundle，无需 workerd）
MAGPIE_BASE_URL=https://example.invalid MAGPIE_API_KEY=x MAGPIE_MODEL=auto/hy3 \
  node --import ./e2e/bootstrap.mjs e2e/server.mjs 8899
# 另开一个终端验证
curl http://127.0.0.1:8899/            # 应返回会议日报 SSR HTML（含 #app）
curl http://127.0.0.1:8899/api/health  # {"ok":true,"service":"meeting-digest","maxInputChars":30000}
```

### node 说明
- 本机 nvm 的 `node` 包装脚本需要先 `nvm use`，否则报 "No active Node.js version"。
- 直接用绝对路径 node 即可：`export PATH="/c/nodejs/node-v22.22.2-win-x64:$PATH"`。

### 门禁注意
- shim 没配 `ACCESS_TOKEN`，所以 **localStorage 里随便设个 `md_token` 即可过前端门禁**（`server.mjs` 只校验前端 token 是否存在）。
- 不过门禁时页面只显示"访问令牌" gate，**没有 #textInput**，测不到 hang。要先在 localStorage 写入 `md_token` 再 reload。

## 现状结论（截至 2026-10-26）
- ✅ 本地 shim + 当前源码 build：过门禁后 **点击/聚焦 textarea、输入文字，6 轮 0 卡死**（含无 pageerror）。
- ✅ live 上纯加载/静置 20 轮 0 卡死 → hang 由交互触发，非加载崩溃。
- ❌ live 上点击 textarea 偶发卡死，连 `captureScreenshot`/CDP 都超时 → live 运行时级问题。
- ⚠️ 差异在 **运行时（Node shim vs Cloudflare workerd）**，非前端源码逻辑（否则本地必复现）。
- ⚠️ 本地无法起 workerd（sandbox 限制），无法在当前环境对 workerd 做确定性 trace。
- ⚠️ 工作区源码非干净生产态：`pages/layout.tsx` 被改成只返回 `<>{children}</>`（原版有 `<html>/<head>/<title>` 与全局样式引入）；`package.json` 多了 `playwright-core`。这些不是 hang 元凶（本地用同样代码不乱），但是调试噪音，建议先还原成 git 上的版本。
