# HANDOFF — 会议日报生成器（产品 ①）

> 供未来会话冷启动：从哪接着干、哪些已验证、哪些是猜测。

## 当前 revision
未提交（工作区 diff 状态）。改动文件：
- `CONTEXT.md`（需求活文档）
- `worker/{package.json,wrangler.toml,tsconfig.json,tsconfig.build.json,.npmrc}`
- `worker/src/{index,prompt,validate,llm,transcribe,chunk}.ts`
- `worker/test/{digest.test.ts,run.ts}`
- `worker/scripts/{build.mjs,dev.mjs}`
- `frontend/{index.html,app.js,style.css}`
- `README.md`、`docs/features/meeting-digest/meeting-digest-交付文档.md`、`docs/HANDOFF-meeting-digest.md`

## 复现 / 验证命令
```bash
cd H:\Work\Projects\Personal\fde-agent-delivery\worker
node scripts/build.mjs                                          # 构建 dist/
node --experimental-strip-types test/run.ts                     # 11 项测试
node node_modules/typescript/bin/tsc --noEmit                   # 类型检查
node scripts/dev.mjs                                            # 本地起服务（需无沙箱限制的环境）
```
Node 路径：`C:\Users\lichun\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`

## 已验证（事实）
- 测试 11/11 通过；`tsc --noEmit` exit 0；`scripts/build.mjs` 成功产出 `dist/`。
- 依赖安装：**必须用 npm flat 布局**（`npm install --ignore-scripts`）。pnpm 的 isolated 布局会导致 wrangler 的传递依赖（miniflare）无法解析。
- `.npmrc` 设 `cache=./.npm-cache`，因为默认缓存目录在沙箱内不可写。
- `worker/node_modules/@cloudflare/workerd-windows-64/bin/workerd.exe` 与 `@esbuild/win32-x64/esbuild.exe` 均已就位（平台包自带二进制）。

## 已验证为环境限制（非代码缺陷）
- DSH Windows 沙箱禁止 confined 进程 spawn 子进程 → `node --test`、`wrangler dev`（esbuild service）、miniflare（spawn workerd）全部 `spawn EPERM`。
- 这是 `test/run.ts`（进程内测试）与 `scripts/dev.mjs`（绕开 wrangler CLI）存在的原因。
- **换到普通终端后本地跑应无此限制**（未验证，属推测）。

## 未解决 / 待办
1. **E2E 未跑**：需配 `MAGPIE_BASE_URL` / `MAGPIE_API_KEY` / `MAGPIE_MODEL` 后在无限制环境跑交付文档的 T01–T09。
2. **未提交 git**：本仓库尚未 `git init` / commit（需确认是否要建仓库）。
3. 第 5 步对抗审查 + 第 6 步人工 Review 的发现项待逐条处置。
4. 前端 `dist/` 与 `frontend/` 分离：目前 `wrangler dev` 未配置静态资源托管（Workers Assets 或 Pages 绑定），部署时需补。

## 猜测 vs 已验证
| 项 | 状态 |
|----|------|
| 测试/typecheck/构建通过 | ✅ 已验证 |
| 依赖可解析、原生二进制就位 | ✅ 已验证 |
| 本地沙箱无法起运行时 | ✅ 已验证（spawn EPERM） |
| 普通终端可本地跑 | ⚠️ 推测，未验证 |
| magpie 中转真实调用成功 | ⚠️ 未验证（无凭据） |
| Cloudflare 部署流程 | ⚠️ 未验证（未部署） |

## 下一步建议
1. 在有 magpie 凭据的环境跑 E2E，填 `CONTEXT.md ## 验收证据`。
2. 处置对抗审查发现项（若有阻塞）。
3. `git init` + 首次 commit，MR 标注 `E2E pending`。
4. 之后可启动产品 ②（情报站 / 内容生产工作台）。
