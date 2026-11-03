# HANDOFF · ai-hot-radar（产品⑤）

> 面向**下一个开发者会话**：现状、坑、下一步。读完应能直接接着干，不用翻聊天记录。
> 最后更新：2026-11-03（UI 令牌层重设计已上线）
> **Status：`ready-for-review`** —— 实现完成、证据齐、已上线；**交叉对抗审查已完成**（8 条阻塞全修）、**手动完整流程线上实测通过**、线上 ACCESS_TOKEN 已配置；剩余的是「评测标签人工复核」等人做决策的事，故不用 `complete`。
>

## 1. 当前状态（一句话）

**最新上线通过「手动完整流程」验证**（version `14704c76`，部署 `2026-11-03T10:40Z`）：**取消全部定时任务改手动触发 + L1/L2 标题去重**。线上实测：点一次刷新 **20.4 秒**跑完「抓取 195 条 → 去重 → 评分 7 条 → 日报入选 12 条 → 队列清空」，**14 源全可抓、0 失败源**。
日报**随刷新即时生成**并落库（不再是 00:30 定时生成）、四页签 UI 可用；阈值经评测集实测标定为 70（Precision 100% / Recall 77.3%）。
**手动完整流程线上实测通过**（`POST /api/refresh`）：抓取 ~6 秒 + 评分 ~14 秒 = 总 20.4 秒；队列 pending 5 → 0。
**线上定时触发器已清零**（`GET .../schedules` 返回空）—— 抓取/评分/日报**全部由用户点击触发**。

需求口径与全部决策在 [CONTEXT.md](../CONTEXT.md)（只增不改）。交付/原理/部署文档：
[交付文档](./features/ai-hot-radar/ai-hot-radar-交付文档.md) ·
[工作原理](./features/ai-hot-radar/ai-hot-radar-工作原理.md) ·
[部署记录](./deploy-ai-hot-radar.md)

**线上**：https://ai-hot-radar.ilikesaury.workers.dev · D1 `ai-hot-radar-db`（id `1e53e023-38f4-4afe-bc92-ade98e4b5a93`）

## 2. 代码地图（按修改频率）

```
product5/
├── CONTEXT.md                   需求活文档（口径唯一权威源；§3 决策 D1–D11 含四轮数据源演进）
├── void.config.ts               CF 配置权威源（D1 id / account）
├── env.ts                       env 声明（Void 校验）
├── db/migrations/
│   ├── 0001_sources_items.sql   sources / items / source_health
│   └── 0002_scores.sql          scores
│   └── 0003_daily.sql           daily
├── lib/
│   ├── rss.ts      ★            零依赖 RSS/Atom 解析 + 抓取 + 去重 + 源健康（healthOf：截断≠异常）
│   ├── score.ts    ★            两阶段评分：本地预筛 + 四维打分 + 阈值/topN（纯函数）
│   ├── dedup.ts    ★新增        L1 标题 Jaccard + L2 SimHash 指纹 + 数字签名硬闸（省 LLM 调用）
│   ├── digest.ts   ★            日报 6 板块 + selectWithQuota 单源配额（纯函数）
│   ├── daily.ts                 日报生成编排（cron 与 POST 共用）
│   ├── ingest.ts                抓取编排（/api/feed 与 cron 共用）
│   ├── llm.ts                   magpie 适配（严格 JSON 校验、失败分类、单条失败不写库）
│   ├── store.ts                 D1 实现（批量写入走 db.batch）+ 内存实现（同接口）
│   ├── types.ts  sources.ts  http.ts  auth.ts
├── routes/api/{health,feed,items,top,score,digest,sources,refresh}.ts
│   └── refresh.ts ★新增        手动触发完整流程：抓取 → 去重 → 评分 → 日报
├── pages/{index.tsx,index.server.ts,layout.tsx}   layout 必须返回 fragment；index.tsx 含自研 Markdown 渲染
├── styles.css                     设计令牌层（与①–④同构：表面/描边/文字/品牌/语义色 + 亮暗两套）
├── test/*.ts                      116 项单测（node --experimental-strip-types；含审查回归 19 项 + 源健康/队列排序/候选窗口回归）
├── eval/                        阈值标定：labels.json + scores.json + run.ts + report.md
├── scripts/deploy.mjs           构建 → 迁移 → 部署 → 探针（支持 DEPLOY_PROXY / --probe-only）
└── e2e/{local-e2e.mjs,d1-shim.mjs,live-m0.mjs,fixtures/}
```

## 3. 六条不能破坏的纪律（破坏任意一条都是回退）

1. **去重必须靠 DB 唯一约束**（`items.content_key`），不能靠内存 Set。
   内存去重在重启/多实例下失效，而资讯去重恰恰是跨请求的。
2. **评分失败不写库、不塞默认分**。默认分会静默拉低区分度，让阈值标定失去意义。
   失败条目保持「未评分」，下一轮 cron 自动补偿。
3. **阈值必须由评测集实测得出**，不得拍脑袋。改模型或改 prompt 后必须重跑 `npm run eval`
   并同步更新 `lib/score.ts` 的 `DEFAULT_THRESHOLD` **和**线上 `DIGEST_THRESHOLD` 环境变量。
4. **手动接口与 Cron 必须共用同一实现**（`lib/ingest.ts` / `lib/daily.ts`）。
   否则手动刷新与自动生成的口径会分叉 —— 这类分叉在「一天只产出一份」的东西上极难发现。
5. **坏源不污染基线**：`baseline_count` 只在「正常且条目更多」时抬升。
   否则坏源会把基线拉低，导致「条目骤降」判定永久失效。
6. **取样上限与健康判定必须解耦**（2026-11-03 新增）：`maxItems` 是**配置行为**，
   「被截断」既不是源异常、也不该参与「条目骤降」判定；且比较 baseline 前必须**先按当前上限封顶**
   —— 否则改 maxItems 就会让全部源误报 degraded（实测踩过两次）。
   反面：源真的只给 3 条时仍要报 degraded（封顶不掩盖真故障）。

## 4. 已知坑（都踩过，别再踩）

| 坑 | 根因 | 处置 |
|---|---|---|
| 本机 Node/curl 访问不了 workers.dev | **不认系统代理**（不是网络白名单） | `curl --proxy` / `DEPLOY_PROXY=…` |
| 部署脚本报「部署失败」但其实成功了 | 探针用 Node fetch，探不到就 exit 1 | 已改：收不到任何 HTTP 响应 → 记「未验证」exit 0 |
| `curl: Unsupported proxy syntax` | Windows cmd `set X=Y && …` 把**尾空格**带进环境值 | 代理值强制 `.trim()` |
| `wrangler d1 migrations apply` 报「No migrations folder」 | wrangler 按 **cwd** 解析 `migrations_dir` | 部署脚本先把 `db/migrations` 拷进 `dist/ssr/db/migrations` |
| RSS 标题变空、条目被跳过 | CDATA 被 `<[^>]+>` 整段吞掉 | **先解包 CDATA 再剥标签** |
| 同一篇文章被判成两条 | URL 尾斜杠未归一 | `normalizeUrl` 去尾斜杠 + 去追踪参数 |
| `arXiv` RSS 返回空壳 | 旧端点 `export.arxiv.org/rss/<cat>` 已迁移 | 改 `rss.arxiv.org/rss/<cat>`（**2026-11-03：此端点也已失效** → 改用官方 Atom API `export.arxiv.org/api/query`） |
| 首页没有客户端脚本（页面不响应） | Void 读 `/.vite/manifest.json`，替身剥掉 `.vite` 就 404 | 替身只剥前导斜杠，保留 `.vite/` |
| 精选被单个源垄断 | `arxiv-cs-ai` 日更 40 篇、权威度天然高 | D11 单源配额（topN 的 1/3），让位给次高分其它源 |
| 本地 D1 测不出绑定上限 | 本地 SQLite 上限 32766，线上 D1 是 100 | 批量写入按**变量数**切批（items 10 行、scores 9 行） |
| **白底近白字（上线首版 UI）** | 页面用暗色系 class（text-slate-100）但 body 没有背景色 → 白底上浅灰字几乎不可见 | 2026-11-03 重设计：接入与①–④同构的设计令牌层（styles.css），颜色只从 `var(--color-*)` 取，亮暗各一套；页面内不再出现硬编码色值 |
| **Markdown 渲染丢粗体/拆散列表** | 旧 renderInline 只认「粗体包裹的链接」，日报里 `**180**` 这类纯粗体带星号原样显示；bullet 的缩进续行（来源 · 时间）被当独立段落 | renderInline 先按 `**…**` 分段再解析链接；续行并入上一条列表项渲染为 `.doc-sub` 次行 |
| 浏览器 E2E ④ 假阴性 | 旧断言依赖「点击后 600ms 内按钮仍是抓取中」，本地 shim 抓取 2ms 完成 → 必挂 | 改为「轮询到抓取中 **或** 页头抓取统计变化」双凭据（2026-11-03） |
| **健康源被误报 degraded（2026-11-03）** | 「被 maxItems 截断」被当成「源异常」——hf-blog 真实 895 条、ithome 真实 60 条，都只因被取样到 40 条而报警 | 截断不再参与健康判定；只有真条目骤降才 degraded（`lib/rss.ts` healthOf） |
| **改 maxItems 后全源误报 degraded** | baseline 记的是历史抓取量（40），新上限是 15 → 「15 < 40×0.4」恒成立 | 比较前把 baseline 封顶到当前上限（healthOf 的 `opts.maxItems`）；并用迁移 0006 清理存量 |
| **精选被单个源垄断** | `arxiv-cs-ai` 日更 40 篇、权威度天然高 | D11 单源配额（topN 的 1/3），让位给次高分其它源 |
| **精选只来自 3 个源（2026-11-03）** | `/api/top` 候选窗口只有 `limit×3` → 全库 66 条 ≥70 分的条目被挡在候选池外 | 候选窗口提到 `limit×10`（D11 配额才能真正把不同源填进来） |
| **待评队列只增不减（2026-11-03）** | `ORDER BY attempts ASC, published_at DESC` → 同 attempts 时永远取最新，旧条目持续饿死（线上 pending 394 条） | 改为 `published_at ASC`（最旧优先）；内存版与 D1 版必须同步 |
| **D1 写入打满 subrequest** | 扩源后一轮要写 200+ 条 + 14 源快照，逐条 `prepare().run()` = 200+ 次往返 | 写入走 `db.batch()`（官方 limits：整批计 1 个 query；内部上限 1,000/次） |
| **本地 E2E 夹具跟不上源列表** | 源从 6 扩到 14 后，未覆盖的 host 全被当 network 失败 → 「A6 好源仍为 ok」等断言全线失败 | 上游替身**逐个 host 覆盖**；新增源时必须同步加夹具（这类失败最易被误读成产品 bug） |
| **magpie 网关下线（2026-11-03）** | trycloudflare 快速隧道：**cloudflared 进程没在跑**（不是「域名到期」）→ 隧道不通 | **五个产品共用同一网关**，需重起 tunnel 并逐个 `wrangler secret put MAGPIE_BASE_URL`；抓取侧不受影响。工具：`tools\启动隧道.bat` / `tools\查状态.bat` |

## 5. 环境约束（本沙箱）

- **不能 `vite dev`**（workerd 需 spawn）→ 本地验证用 Node shim：`e2e/bootstrap.mjs` + `e2e/local-e2e.mjs`
  （加载真实 `dist/ssr/index.js` + 真实 HTTP + `node:sqlite` 替身跑**真实迁移 SQL**）。
- **本机 Node 出网需显式代理**（`http://127.0.0.1:7890`）；`ego-browser` 二进制当前缺失，
  依赖它的线上 E2E 脚本在本机跑不了（用 `curl --proxy` 替代）。
- `npm install` 必须 `--ignore-scripts`（沙箱禁 spawn）。
- 线上 secrets 用 **product4 同款 magpie 网关**（复用凭据，值不回显）。

## 5.1 猜测 vs 已验证（严格分开）

**已验证（有证据）**
- **14 源在真环境全部可抓**（2026-11-03 实测）：openai / deepmind / google-ai / aws-ml / nvidia / arxiv / hn / simonw /
  techcrunch-ai / importai / marktechpost / mit-tech-review / ithome / sspai，**195 条/轮、0 失败源**
- **评分队列已清空**（2026-11-03，magpie 网关恢复后连打 16 批）：pending 558 → **1**，scored 230 → **703**、dead 0
- **精选来源数 3 → 7**（候选窗口修正 + 源扩充 + 评分提速的联合效果）：
  arxiv 4 / nvidia 2 / deepmind 2 / google-ai / openai-news / simonw / ithome 各 1
- 跨请求去重生效：连打两次 `/api/feed` → 180 新增 → 180 判重
- 真实评分 60 条零失败（magpie `auto/minimax-m3.1-flash`，prompt `score-v1`）
- 阈值标定：70 → Precision 100% / Recall 77.3% / F1 0.872（50 条标签 × 60 条真实评分）
- **无任何定时任务**（2026-11-03 增量 8：原 3 个 Cron 全部删除，线上触发器已清零）
  - ⚠️ `wrangler deploy` / `wrangler triggers deploy` **只增不删** cron —— 必须用
    `PUT /accounts/{id}/workers/scripts/{name}/schedules`（body `[]`）清零；已写进 `scripts/deploy.mjs`
  - ⚠️ `wrangler deploy --secrets-file` 会用文件覆盖全部 secrets —— **换隧道域名后必须同步各产品 `.secrets.json`**
- 单源配额生效：27 条过阈值 → 入选 9 条、让位 18 条；不设配额时 top5 全为 arxiv
- 本地 E2E 31/31、单测 116/116、typecheck 0 error、文档 0 断链

**未验证 / 待人确认**
- **50 条评测标签是 AI 初标，非人工标注** —— 阈值数字的可靠性受此限制（流程可复核）
- **前端 401 处理已补**（2026-11-03 白屏回归的教训）：配 ACCESS_TOKEN 后前端若不处理 401 会白屏。
  已改为 `fetchJson` 统一入口（只有 200 的 body 进 state）+ 鉴权模式感知提示；浏览器 E2E ④b 断言双模式不白屏
- **CPU 直接读数未取**（A9 的 subrequest 39/50 与墙钟 3044ms 是实测；CPU 需看 Dashboard/observability）。
  但**比 CPU 读数更强的证据是**：cron 已连续 16+ 小时每小时自动触发成功 —— 若超 CPU，Cloudflare 会记 1102 且任务失败
- ~~Cron 真实触发未观测~~ → **已验证**（2026-11-03）：抓取每���时 :06 一次无间断；评分队列两次采样 +8/-8；日报 00:30 自动生成。
  证据 `product5/docs/e2e-evidence/cron-verification.log`
- ~~未做浏览器走查~~ → **已补**：`e2e/browser-e2e.mjs`（Playwright + 真实 Chromium 打线上站点）
  **双模式实测（2026-11-03，线上 `7088bef7`）**：带令牌 **19/19**（水合、页签点击、分数徽标、折叠展开、
  日报 Markdown 渲染、外链可点、无 JS 错误、无失败请求）；无令牌 **13/19** —— 未过的 6 项全是
  数据类断言（无令牌拿不到数据是预期），关键回归断言 ④b 不白屏 + ⑪ 无 JS 错误均通过。
  **令牌层重设计上线后复测（2026-11-03，线上 `9b69b06c`）**：带令牌 **19/19** 全过
  （分数徽标 33 个、日报 Markdown 标题 8 个、外链 2 个、折叠区 open=1、无 JS 错误、无失败请求）。
  ⚠️ 跑带令牌模式**必须显式传 `TOKEN`**，否则默认无令牌模式会得到假红（13–14/19）。
  截图 `product5/docs/e2e-evidence/browser-e2e.png`（日志中令牌值已脱敏）

## 6. 下一步（按价值排序）

1. **评测标签人工复核**（用户）：改 `eval/labels.json` → 重跑 `npm run eval` → 更新阈值 → 同步线上 `DIGEST_THRESHOLD`。
2. ~~Cron 触发观测~~ → **已验证**（2026-11-03）：抓取每小时 :06 无间断 16h+；评分队列两次采样 +8/-8；
   日报 00:30 UTC 自动生成。证据 `product5/docs/e2e-evidence/cron-verification.log`。
3. ~~作品集索引收录~~ → **已完成**（README 一览表 + 产品⑤ 章节 / `docs/作品集-总览.md` / `docs/线上环境速查.md`）。
4. **源健康可视化增强**：目前历史是纯文字列表，可做成迷你时间线。
5. **可选**：把「每日推送」（Webhook / 邮件）做成二期；把 `evaluate` 的阈值扫描接进 CI 防漂移。

## 7. 复现与验收命令

```bash
cd product5
npm install --ignore-scripts
npm run typecheck && npm test && npm run build
npm run e2e:local                                   # 27 项（接口/SSR 级，本机可跑）
npm run e2e:browser                                 # 19 项（浏览器交互级，需出网；可加 PROXY=… BASE=… TOKEN=…）
npm run eval                                       # 阈值标定（需 eval/scores.json）
node scripts/deploy.mjs --secrets .secrets.json     # 构建→迁移→部署→探针
node scripts/deploy.mjs --probe-only                # 只验线上，不重新部署
# 本机需代理时前置 DEPLOY_PROXY=http://127.0.0.1:7890
```

线上接口（需令牌时加 `Authorization: Bearer <ACCESS_TOKEN>`）：
`/api/health` · `/api/feed` · `/api/items` · `/api/top` · `/api/digest` · `/api/sources`

## 8. 相关技能（真源在全局库，项目内 junction）

- `cf-worker-local-env` —— Cloudflare 本地环境约束与部署路径选择
- `ci-parity-triage` —— 本地全绿但 CI 红的分层诊断（本产品尚未接入 CI，见 §6-3）
- `rag-retrieval-tuning` —— 阈值标定方法论（本产品的 `eval/` 是其「筛选标定」变体）
- `workers-ai-model-usage` —— Workers AI 入参形状（本产品用 magpie 中转，未用 Workers AI）
