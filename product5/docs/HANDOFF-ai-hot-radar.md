# HANDOFF · ai-hot-radar（产品⑤）

> 面向**下一个开发者会话**：现状、坑、下一步。读完应能直接接着干，不用翻聊天记录。
> 最后更新：2026-11-02
>
> **Status：`ready-for-review`** —— 实现完成、证据齐、已上线；剩余的是「评测标签人工复核」等人做决策的事，
> 故不用 `complete`。

## 1. 当前状态（一句话）

**已上线并通过真环境验证**：version `72123c29`，线上 6 源全部可抓（180 条/轮）、180 条真实评分零失败、
日报自动生成并落库、四页签 UI 可用；阈值经评测集实测标定为 70（Precision 100% / Recall 77.3%）。

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
│   ├── rss.ts      ★            零依赖 RSS/Atom 解析 + 抓取 + 去重 + 源健康（23 项测试）
│   ├── score.ts    ★            两阶段评分：本地预筛 + 四维打分 + 阈值/topN（纯函数）
│   ├── digest.ts   ★            日报 6 板块 + selectWithQuota 单源配额（纯函数）
│   ├── daily.ts                 日报生成编排（cron 与 POST 共用）
│   ├── ingest.ts                抓取编排（/api/feed 与 cron 共用）
│   ├── llm.ts                   magpie 适配（严格 JSON 校验、失败分类、单条失败不写库）
│   ├── store.ts                 D1 实现 + 内存实现（同接口）
│   ├── types.ts  sources.ts  http.ts  auth.ts
├── crons/
│   ├── fetch.ts                 每小时 :05 抓取
│   ├── score.ts                 每小时 :20 评分一批
│   └── digest.ts                每天 00:30 UTC 生成日报
├── routes/api/{health,feed,items,top,score,digest,sources}.ts
├── pages/{index.tsx,index.server.ts,layout.tsx}   layout 必须返回 fragment；index.tsx 含自研 Markdown 渲染
├── test/*.ts                    88 项单测（node --experimental-strip-types）
├── eval/                        阈值标定：labels.json + scores.json + run.ts + report.md
├── scripts/deploy.mjs           构建 → 迁移 → 部署 → 探针（支持 DEPLOY_PROXY / --probe-only）
└── e2e/{local-e2e.mjs,d1-shim.mjs,live-m0.mjs,fixtures/}
```

## 3. 五条不能破坏的纪律（破坏任意一条都是回退）

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

## 4. 已知坑（都踩过，别再踩）

| 坑 | 根因 | 处置 |
|---|---|---|
| 本机 Node/curl 访问不了 workers.dev | **不认系统代理**（不是网络白名单） | `curl --proxy` / `DEPLOY_PROXY=…` |
| 部署脚本报「部署失败」但其实成功了 | 探针用 Node fetch，探不到就 exit 1 | 已改：收不到任何 HTTP 响应 → 记「未验证」exit 0 |
| `curl: Unsupported proxy syntax` | Windows cmd `set X=Y && …` 把**尾空格**带进环境值 | 代理值强制 `.trim()` |
| `wrangler d1 migrations apply` 报「No migrations folder」 | wrangler 按 **cwd** 解析 `migrations_dir` | 部署脚本先把 `db/migrations` 拷进 `dist/ssr/db/migrations` |
| RSS 标题变空、条目被跳过 | CDATA 被 `<[^>]+>` 整段吞掉 | **先解包 CDATA 再剥标签** |
| 同一篇文章被判成两条 | URL 尾斜杠未归一 | `normalizeUrl` 去尾斜杠 + 去追踪参数 |
| `arXiv` RSS 返回空壳 | 旧端点 `export.arxiv.org/rss/<cat>` 已迁移 | 改 `rss.arxiv.org/rss/<cat>` |
| 首页没有客户端脚本（页面不响应） | Void 读 `/.vite/manifest.json`，替身剥掉 `.vite` 就 404 | 替身只剥前导斜杠，保留 `.vite/` |
| 精选被单个源垄断 | `arxiv-cs-ai` 日更 40 篇、权威度天然高 | D11 单源配额（topN 的 1/3），让位给次高分其它源 |
| 本地 D1 测不出绑定上限 | 本地 SQLite 上限 32766，线上 D1 是 100 | 批量写入按**变量数**切批（items 10 行、scores 9 行） |

## 5. 环境约束（本沙箱）

- **不能 `vite dev`**（workerd 需 spawn）→ 本地验证用 Node shim：`e2e/bootstrap.mjs` + `e2e/local-e2e.mjs`
  （加载真实 `dist/ssr/index.js` + 真实 HTTP + `node:sqlite` 替身跑**真实迁移 SQL**）。
- **本机 Node 出网需显式代理**（`http://127.0.0.1:7890`）；`ego-browser` 二进制当前缺失，
  依赖它的线上 E2E 脚本在本机跑不了（用 `curl --proxy` 替代）。
- `npm install` 必须 `--ignore-scripts`（沙箱禁 spawn）。
- 线上 secrets 用 **product4 同款 magpie 网关**（复用凭据，值不回显）。

## 5.1 猜测 vs 已验证（严格分开）

**已验证（有证据）**
- 6 源在真环境全部可抓：hn 20 / hf-blog 40 / arxiv 40 / simonw 30 / ithome 40 / sspai 10，180 条/轮
- 跨请求去重生效：连打两次 `/api/feed` → 180 新增 → 180 判重
- 真实评分 60 条零失败（magpie `auto/minimax-m3.1-flash`，prompt `score-v1`）
- 阈值标定：70 → Precision 100% / Recall 77.3% / F1 0.872（50 条标签 × 60 条真实评分）
- Cron 已注册（`dist/ssr/wrangler.json` 的 `triggers.crons` 三条）
- 单源配额生效：27 条过阈值 → 入选 9 条、让位 18 条；不设配额时 top5 全为 arxiv
- 本地 E2E 22/22、单测 88/88、typecheck 0 error、文档 0 断链

**未验证 / 待人确认**
- **50 条评测标签是 AI 初标，非人工标注** —— 阈值数字的可靠性受此限制（流程可复核）
- **CPU 直接读数未取**（A9 只测了 subrequest 6/50 与墙钟 2.7–5s；CPU 需看 Dashboard/observability）
- **Cron 的真实触发记录未观测**（只验证了注册与手动等价路径；需等到点后查 Dashboard 或 `wrangler tail`）
- **未做浏览器真人走查**（页面为自研 Markdown 渲染，四页签 SSR 已验，交互未验）

## 6. 下一步（按价值排序）

1. **评测标签人工复核**（用户）：改 `eval/labels.json` → 重跑 `npm run eval` → 更新阈值 → 同步线上 `DIGEST_THRESHOLD`。
2. **Cron 触发观测**：等到整点后查 Cloudflare Dashboard 的触发记录 + `npx wrangler tail` 看 `[cron:*]` 日志，
   确认三个任务都真的跑起来了（这是「自动扫描」这一核心定位的最后一块拼图）。
3. **作品集索引收录**（README 一览表 / `docs/作品集-总览.md` / `docs/线上环境速查.md`）。
4. **源健康可视化增强**：目前历史是纯文字列表，可做成迷你时间线。
5. **可选**：把「每日推送」（Webhook / 邮件）做成二期；把 `evaluate` 的阈值扫描接进 CI 防漂移。

## 7. 复现与验收命令

```bash
cd product5
npm install --ignore-scripts
npm run typecheck && npm test && npm run build
npm run e2e:local                                   # 22 项
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
