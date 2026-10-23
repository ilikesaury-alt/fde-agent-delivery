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
- **真实 E2E 证据已归档**：`docs/e2e-evidence/T01-digest-output.json` 是 v1 期用真实 magpie
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
| `void deploy` 到 Cloudflare | ⚠️ 未验证（需 CF 账号） |

## 未解决 / 待办
1. **E2E 待跑**（完成闸门）：`npm run dev` 后按交付文档 T01–T09 执行。T02（文件上传）、
   T06（剪贴板）尚无证据。
2. **未提交**：需 commit 并标 `E2E pending`。
3. **未部署**：`void deploy --backend cloudflare --provision` 未验证（需 CF 账号授权）。
4. **预留接口未迁入**：v1 的 `transcribe.ts`（ASR）/`chunk.ts`（分块）在 v2 未建，
   如需要应由 `routes/` 承接。

## 下一步建议
1. 普通终端 `cd product1 && npm run dev`，跑 T01–T09 补证据。
2. 配 `void secret put MAGPIE_API_KEY` 后试 `void deploy`。
3. 之后启动产品②（建议也用 Void，模板见 `FDE作品调研与模仿起步方案.md` 第 8 节）。
