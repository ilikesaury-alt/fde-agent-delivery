# HANDOFF — 内容工作台（产品②）

> 供未来会话冷启动：从哪接着干、哪些已验证、哪些是猜测。

## 当前 revision
`product2/` 工作区（首次交付）。提交后以 `git log -- product2` 的最新 commit 为准。

## 一句话现状
MVP 功能全部实现并通过本地端到端（33 项）：链接/文本 → 三步流水线（抓取→压缩→生成）→ 流式小红书笔记 → D1 历史（列表/回看/删除/重新生成）。**尚未部署到 Cloudflare**（第 11 步 E2E 待用户执行）。

## 复现 / 验证命令
```bash
cd H:\Work\Projects\Personal\fde-agent-delivery\product2

node node_modules/typescript/bin/tsc --noEmit              # 类型检查（0 错误）
node --experimental-strip-types test/run.ts                # 单测 101 项，约 5s
node node_modules/vite/bin/vite.js build                   # 构建（SSR + client）

# 本地起服（绕开 workerd；D1 用 node:sqlite 跑真 migration）
ACCESS_TOKEN=test-token-123 node --experimental-sqlite --import ./e2e/bootstrap.mjs e2e/run-local.mjs 8901

# 接口级端到端全流程自检（真 magpie + 真 SQLite）
node e2e/flow-check.mjs http://127.0.0.1:8901 test-token-123
```

诊断脚本：
- `e2e/m0-upstream-stream.mjs [baseUrl] [model]` —— 验证某个上游/模型的 `stream:true` 是否真增量、首 token 延迟
- `e2e/diag-frames.mjs [model]` —— 打印上游 SSE 帧结构（排查「有帧但无 content」）

## 已验证（事实）
- 单测 **101/101**；`tsc --noEmit` **0 错误**；`vite build` 成功。
- 生成的 `dist/ssr/wrangler.json` 含 `d1_databases: [{binding:"DB"}]` 与 `assets: {binding:"ASSETS", run_worker_first:["/**"]}`。
- 本地端到端 **33/33**（真 magpie 流式 + node:sqlite 跑真 `db/migrations`）：
  流式时间线 `step@78ms → token@14794ms → …22 个增量… → done@15481ms`；历史倒序/回看/删除/重生成新记录；7280 字自动压缩为 287 字要点；404 链接明确报错 + 引导；空输入 400；无令牌 401。
- magpie 上游 `stream:true` 为真增量（`text/event-stream`，83 帧 / 13 增量帧）。
- `void/sse` 的 `eventStream()` 在 build 后可用且非缓冲。

## 已验证为环境限制（非代码缺陷）
- `vite dev` 不可用：miniflare 需 spawn `workerd`，沙箱禁止。
- D1 无法本地启动 → shim 用 `node:sqlite` 实现 D1Like 子集（`e2e/d1-shim.mjs`），跑同一份 migration 与同一份 SQL。
- 必须 `--experimental-sqlite` 启动 shim。
- `product1/.env` 的 `MAGPIE_BASE_URL` 是 cloudflared 临时隧道（当前不通）；本地验证用 `http://127.0.0.1:3425/v1`（`e2e/run-local.mjs` 会自动回退）。
- **模型差异极大**：`auto/minimax-m3.1-flash` 可用且较快；`auto/deepseek-v4.1-flash` 首 token 22.9s；`auto/glm-5.3-flash` 90s 无 content；`group/cheap-first` 直接 400（benefit not found）。`run-local.mjs` 因此**不复用** product1 的 `MAGPIE_MODEL`。

## 猜测 vs 已验证
| 项 | 状态 |
|---|---|
| 单测/类型/构建 | ✅ 已验证 |
| 本地端到端（真上游 + 真 SQLite） | ✅ 已验证 33/33 |
| 真实网页抓取成功率 | ⚠️ 仅测过 example.com（404 路径）。**真实站点（公众号/知乎/博客）未测**，预期动态渲染页会失败并走引导 |
| 线上 D1（真实 Cloudflare D1） | ⚠️ 未验证。SQL 与 migration 已用 SQLite 验证语义，但 D1 的 `RETURNING` 支持、绑定行为需线上一验 |
| 浏览器端 UI（复制/取消/流式渲染/移动端） | ⚠️ 未验证（需人工） |
| `void deploy --provision` 首次建 D1 | ⚠️ 未验证（产品①当时未用 D1） |
| 长文压缩后笔记质量 | ⚠️ 结构通过，未评估「要点保真度」 |

## 未解决问题 / 下一步
1. **部署（第 11 步之前）**：`void deploy --backend cloudflare --provision` + secrets；部署后**必查** `wrangler versions view <id>` 同时有 `env.ASSETS` 与 `env.DB`，并看日志 `assetUploadFileCount > 0`（产品① 1101 教训）。
2. **人工 E2E 清单（用户执行）**：见 `product2/docs/features/content-studio/内容工作台-交付文档.md` §4，重点 T1（真实链接）、T11（剪贴板）、T12（空输入禁用）、T16（刷新后历史仍在）。
3. 可选改进（按性价比）：
   - 抓取质量：现在靠启发式；若要提升，可换 `HTMLRewriter`（Workers 原生）或针对主流站点加选择器规则
   - 正文长度稳定性：prompt 已给区间，实际仍会波动；可加重试或后置长度矫正
   - SSRF 残余风险：DoH 校验与真实 fetch 之间有 DNS rebinding TOCTOU 窗口（已登记）

## 关键文件地图
| 关注什么 | 看哪 |
|---|---|
| 需求/方案/验收/证据 | `product2/CONTEXT.md` |
| 三步流水线 | `lib/pipeline.ts` |
| LLM 流式解析（跨 chunk/错误帧/降级） | `lib/llm.ts` |
| 笔记标记格式解析 + 流式预览 | `lib/note.ts` |
| 抓取 + SSRF 三道闸 | `lib/fetch-article.ts` |
| 存储（D1/内存）+ SQL | `lib/store.ts` + `db/migrations/0001_init.sql` |
| SSE 路由 | `routes/api/generate.ts` |
| 客户端流式消费（超时/终态） | `lib/client-stream.ts` |
| 交付/测试指引 | `product2/docs/features/content-studio/内容工作台-交付文档.md` |

## 踩过的坑（本产品新增，可迁移）
1. **`void/sse` 的 keepAlive 是 `setInterval`**：消费端不把流读完（如只断言 status），interval 不会清 → Node 进程挂住不退出。已在 handler 加 `finally { stream.close() }`。
2. **同 tick 连发 SSE 事件会被合并 flush**：验证「真流式」必须在事件之间留真实间隔，否则自测会误判为「非流式」（我第一版 M0 探针就这么误判了）。
3. **产品① 的 shim 用 `arrayBuffer()` 缓冲整包**：SSE 会被缓冲成一次性到达 → 本地「假绿」。产品② shim 改为按 chunk 泵送。
4. **模型名不能跨产品复用**：product1 的 `MAGPIE_MODEL` 在本网关不存在，直接 400。
5. **`previewBody` 这类「过滤 + 切片」组合极易错**：用过滤后的下标切未过滤的数组会静默吞行；把解析逻辑收到一个模块里共享同一套正则，才测得住。
