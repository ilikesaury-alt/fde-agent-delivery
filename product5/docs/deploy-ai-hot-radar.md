# 产品⑤ 部署记录 · ai-hot-radar

> 本文档记录部署事实与线上验证状态（唯一真源在 `../CONTEXT.md` 的验收标准；此处只记「做过什么、结果如何」）。
> 凭据（复用关系）统一登记在 `docs/线上环境速查.md`，本文不回显任何密钥。

## 0.11 源扩充 + 健康口径修正 + 评分提速 · 2026-11-03

| 项 | 值 |
|---|---|
| 线上版本 | `ebf7e21d-cf22-47c1-bf5c-c64fa360fbc0`（部署 `2026-11-03T08:34Z`） |
| 上一版本 | `06836c3b`（同批首次部署，被本批修正） · 再上 `9b69b06c`（UI 令牌层） |
| 源数 | 6 → **14**（全部实测可用，0 失败源） |
| 迁移 | `db/migrations/0006_source_expansion.sql`（清理陈旧源 + baseline 封顶） |
| 测试 | 单测 **116/116** · 本地 E2E **31/31** · 浏览器 E2E **19/19** |

### 触发原因（用户报「数据太少、几个源异常」）

三条**独立**的根因，全部实测定位：

| 现象 | 真因 | 处置 |
|---|---|---|
| `arxiv-cs-ai` 连续 7 次失败 | **上游 RSS 端点失效**：`rss.arxiv.org/rss/cs.AI` 返回 892B 空壳（0 个 `<item>`，cs.CL/cs.LG 同样） | 改用官方 Atom API `export.arxiv.org/api/query?search_query=cat:cs.AI&...`（实测 40 条 / 日期齐 / 摘要 40/40） |
| `hf-blog` / `ithome` 显示 degraded | **误判**：旧实现把「被 maxItems 截断」当「源异常」。hf-blog 真实 895 条、ithome 真实 60 条，都只是被取样到 40 条 | 截断不再污染健康等级；只有**真条目骤降**才 degraded（`lib/rss.ts` healthOf） |
| 精选只有 12 条、只来自 3 个源 | **候选窗口太窄**：`/api/top` 只取 `limit×3` 条候选，全库 66 条 ≥70 分的条目被挡在候选池外 | 候选窗口提到 `limit×10` |

### 改动清单

- **源列表 6 → 14**（D13，官方源优先）：openai / deepmind / google-ai / aws-ml / nvidia / arxiv（官方一手）
  + hn / simonw / techcrunch-ai / importai / marktechpost / mit-tech-review（社区与媒体）+ ithome / sspai（中文）。
  每个都用**真实解析器**（`lib/rss.ts`）实测条目数 / 日期覆盖 / 摘要达标率后才入列。
- **移除 hf-blog**（D14）：该 feed 不提供任何摘要（实测 0/40 条有 description）→ 预筛必然全丢、占库存零贡献。
- **maxItems 40 → 15**：实测解析耗时与**条目数**近似线性、与文档大小几乎无关（14 源在 maxItems=15 时 ≈19ms，
  maxItems=40 时 ≈35ms）—— Cron 的 CPU 预算只有 10ms（Workers Free 官方 limits）。
- **评分 cron 提速**：批量 10 → 30 条/次，LLM 并发 2 → 5（Workers 同时等待响应的连接上限 6）。
- **待评队列排序修正**：原 `attempts ASC, published_at DESC` → 同 attempts 时永远取最新，旧条目持续饿死
  （线上实测 pending 394 条只增不减）；改为 `published_at ASC`（最旧优先）。
- **D1 写入改 `db.batch()`**：官方 limits —— D1 内部 subrequest 1,000/次、外部 50/次，
  而 `db.batch()` **整批计 1 个 query**。扩源后一轮要写 200+ 条 + 14 源快照，逐条发会打满预算。
- **baseline 封顶**：baseline 记的是「历史抓到过多少条」，而 maxItems 会变 → 比较前必须先按当前上限封顶，
  否则改 maxItems 后「15 < 40×0.4」恒成立 → **全源误报 degraded**（上线首轮实测 arxiv/ithome 中招）。
- **迁移 0006**：删除 `hf-blog` 快照行（保留 `source_health` 历史——它是「这个源什么时候坏的」的证据），
  并把存量 baseline 封顶到 15。

### 线上验证

- **14/14 源全 ok，0 失败源**；每轮 **195 条**（原 140 条），去重后 194，墙钟 4.7s。
- `/api/sources` 返回 14 个源，全部 `lastHealth=ok`、`consecutiveFailures=0`。
- 浏览器 E2E 19/19：UI 显示「195 条 / 去重后 194」「源健康 14」。
- 证据：`e2e-evidence/deploy-2026-11-03-v2.log`、`browser-e2e.log`（带令牌 19/19）、`local-e2e.log`（31/31）。

### ⚠️ 外部依赖故障（与本次改动无关）：magpie 网关下线

**症状**：评分全部失败（`error: upstream`，详情「AI 服务暂不可用」），预筛丢弃的条目不受影响。

**根因（2026-11-03 17:00 查清）**：**不是「域名到期」—— 是 cloudflared 隧道进程没在跑**。
`tools/status-tunnel.ps1` 实测：magpie 本机 3425 端口 HTTP 200 **正常**，但 `cloudflared` 进程已退出 → 隧道不通。
`trycloudflare.com` 是 Cloudflare 的**免费快速隧道**：进程一关域名立即失效，每次重启**随机换域名**。

**影响面**：**五个产品共用同一个网关** —— 实测产品② 的 `/api/generate` 同样失败（`generate: failed`），
产品①③④ 同样受影响（抓取/只读接口正常，只有 LLM 生成链路挂）。

**处置**：重起隧道 + 逐个同步 secret（工具链已就位，见 `docs/线上环境速查.md` §4）：
- `tools\启动隧道.bat` → 新域名 `butler-episode-lanka-capture`（2026-11-03 16:54）
- 5 个 Worker 的 `MAGPIE_BASE_URL` secret 全部同步成功
- `tools/start-tunnel.ps1` 已扩展为**五产品口径**（原只含 ①②）；因产品①–④ 无 `dist/ssr` 构建产物，
  改用产品⑤ 的 `dist/ssr` 作凭据上下文 + `--name <worker 名>` 同步

**恢复验证**：
- 网关直连 → HTTP 200 正常返回
- 产品⑤ 评分 → `scored=15 failed=0`
- 产品② 生成 → 「已生成 3 个标题 · 403 字正文 · 5 个标签」
- 产品③ 问答 → embed/retrieve 全通
- 产品① 日报 / 产品④ 抽取 → 正常返回

**队列消化**：恢复后连打 16 批 `/api/score`，**pending 558 → 1**，scored 230 → **703**、dead 0。

**精选多样性实测改善**：精选来源数 **3 → 7**（arxiv 4 / nvidia 2 / deepmind 2 / google-ai / openai-news / simonw / ithome 各 1）。
这正是「候选窗口修正 + 源扩充 + 评分提速」三处改动的联合效果 —— 修复前只有 arxiv/ithome/hn 三个源。

### 遗留待办

- **CPU 直接读数未取**：A9 仍标估算（需 Dashboard/observability）。

## 0.10 UI 令牌层重设计 + Markdown 渲染修复上线 · 2026-11-03

| 项 | 值 |
|---|---|
| 线上版本 | `9b69b06c-9de2-450f-a40b-a5ad53e42f3b`（部署 `2026-11-03T07:20:24Z`） |
| 上一版本 | `7088bef7-2c8d-40d8-a904-0d2310c0b54e`（2026-11-03T03:20:06Z，**白屏回归那版**） |
| 上线内容 | 设计令牌层重设计（`styles.css` 令牌 → `var(--color-*)`）+ Markdown 渲染修复 + 浏览器 E2E ④ 双凭据断言 |
| 迁移 | 无（`wrangler d1 migrations apply` → `No migrations to apply!`） |

**为什么必须上这一版**：`7088bef7` 仍是「暗色 class 版」（线上首页 HTML 含 `text-slate-100`，白底近白字），
重设计后的令牌层版本尚未部署——本次才真正把 **UI 令牌层 + Markdown 修复** 推上线。

**部署前验证**（全过才推）：
typecheck 0 error · 单测 107/107 · build 成功 · 本地 E2E 27/27 · 文档 0 断链。

**线上验证**：
- 部署脚本探针全过：`/api/health` 200 · `/` 200 · `/api/feed?src=hn&limit=3` 200（条目 3 · 351ms · 失败 0 源）
- 首页 HTML 已无 `text-slate-100` 残留，改为 `var(--color-surface)` / `var(--color-ink)` 等令牌类
- 样式资产切换为 `layout-DOtmxj4t.css`（旧版 `layout-D0bWFYxA.css`）
- `/api/top?threshold=0` → 12 条，单源配额生效（`perSourceMax=4`，`skippedByQuota=10`）
- **浏览器 E2E 带令牌 19/19 全过**（水合、页签、分数徽标 33 个、折叠展开、日报 Markdown 标题 8 个、
  外链 2 个、无 JS 错误、无失败请求）；关键回归断言 **④b 不白屏** ✔
- 证据：`e2e-evidence/deploy-2026-11-03.log`、`e2e-evidence/browser-e2e.log`（令牌值已脱敏）

**踩坑（本次新增）**：
1. **wrangler OAuth 凭据过期且 refresh token 失效**（`oauth_token` 于 2026-11-03T04:19Z 过期，
   调 `dash.cloudflare.com/oauth2/token` 返回 `invalid_client`）→ wrangler 无法自动续期，
   必须人工授权一次：`npx wrangler login --device` → 在**已登录的浏览器**里打开
   `https://dash.cloudflare.com/oauth2/device/verify` 输入验证码 → 授权后凭据写回 `default.toml`。
   踩坑细节：设备码 5 分钟过期；**ego-browser 是独立 profile，没有用户的 Cloudflare 登录态**，
   在那里操作会一直停在登录页 —— 正确做法是让用户在**自己的 Chrome**（已登录）里完成授权。
2. **浏览器 E2E 漏传 `TOKEN` 会被误读为回归**：脚本默认无令牌模式，6 项数据类断言必然不满足
   （无令牌拿不到数据是预期）。**跑带令牌模式必须显式传 `TOKEN`**，
   否则会得到 13/19 / 14/19 的假红。令牌从 `.secrets.json` 取，**不要写进命令行历史或日志**。

## 0.9 增量 5（UI 完善）· 2026-11-02

| 项 | 值 |
|---|---|
| 新接口 | `GET /api/sources?history=N&source=id`（源快照 + 抓取历史 + 连续失败次数） |
| 首页 | 重写为四页签：**日报 · 精选 · 历史 · 源健康** |
| 迁移 | 无（复用既有表） |

**新增能力**
- **源健康详情**：每源展示最近检查时间、条目数/基线、错误码、**连续失败次数**与最近 N 次抓取历史。
  为什么要有「连续失败次数」：feed 失效是常态；只给快照无法区分「昨天还好好的」与「烂了三个月」——
  后者说明该**换源**而不是重试。
- **历史回看**：已入库条目（跨请求去重后）按发布时间倒序，展示「发布 / 首见 / 最近见」三个时间。
- **日报阅读体验**：自研轻量 Markdown 渲染（不引 markdown 库）。
  安全取舍：**不用 dangerouslySetInnerHTML**，所有文本走 React 转义；链接 href 走 http/https 白名单校验。

**验证**：typecheck 0 · 单测 107/107（含审查回归 19 项）· 本地 E2E 27/27（含四页签 SSR 断言 + 源健康历史接口）。

## 0.7 增量 4（Cron + 日报 + 多样性配额）· 2026-11-02

| 项 | 值 |
|---|---|
| 迁移 | `db/migrations/0003_daily.sql`（daily 表 + 索引） |
| Cron | `5 * * * *` 抓取 · `20 * * * *` 评分（10 条/次）· `30 0 * * *` 日报（UTC） |
| 打包验证 | `dist/ssr/wrangler.json` 的 `triggers.crons` 已含三条（Void 从 `crons/` 自动注册） |

**为什么拆三个 Cron**：Free 套餐**每次 Cron 的 CPU 只有 10ms**、subrequest 上限 50/次。
「抓取+评分+日报」塞一次必然超预算；拆开后每步预算可控，且任一步失败不牵连其它步骤。

**架构去重**：抽 `lib/ingest.ts`（抓取链路，`/api/feed` 与 cron 共用）与
`lib/daily.ts`（日报生成，cron 与 `POST /api/digest` 共用）——
手动刷新与定时任务走同一实现，避免行为分叉。

**可验证性**：`POST /api/digest` 可立即重生成当日日报（令牌保护），验收不必等到次日。

## 0.5 增量 3（评分 + 评测标定）· 2026-11-02

| 项 | 值 |
|---|---|
| 迁移 | `db/migrations/0002_scores.sql`（scores 表 + 索引） |
| 线上版本 | `7db9cb3e-8fe2-4397-98bf-6892039ac953`（评分 API）→ 后续 UI 版本 |
| 真实网关 | magpie 已配置（复用 product4 凭据；**值不回显**） |

**线上实测（经代理）**：
- `POST /api/score?limit=10` × 6 批 → **60 条全部评分成功、0 失败**（每批 28–41s）
- 评分理由可读且判断准确（例：车企业绩 34 分「非前沿技术」；谷歌 AI 搜索监管 80 分）
- `GET /api/top?threshold=0` → 60 条，分数区间 18–92、中位 64

**阈值标定（eval/run.ts，50 条标签 × 60 条真实评分）**

| 阈值 | Precision | Recall | 漏选率 | F1 |
|---|---|---|---|---|
| 50 | 69.2% | 81.8% | 18.2% | 0.750 |
| 55 | 75.0% | 81.8% | 18.2% | 0.783 |
| 60 | 77.3% | 77.3% | 22.7% | 0.773 |
| 65 | 89.5% | 77.3% | 22.7% | 0.829 |
| **70** | **100.0%** | **77.3%** | **22.7%** | **0.872** ← 推荐 |
| 75 | 100.0% | 68.2% | 31.8% | 0.811 |
| 80 | 100.0% | 59.1% | 40.9% | 0.743 |

**结论**：默认阈值从拍脑袋的 60 改为**实测 70**（Precision 100% / Recall 77.3%）。
报告见 `product5/eval/report.md`，口径见 `product5/eval/README.md`。

**⚠️ 标签来源**：50 条为 **agent 初标**（非人工标注）。流程与数字可复核，但不宣称「已人工标定」。
用户复核 `eval/labels.json` 后重跑 `npm run eval` 即可更新阈值。

## 0. 增量 2（D1 持久化）· 2026-11-02

| 项 | 值 |
|---|---|
| D1 库 | `ai-hot-radar-db` · id `1e53e023-38f4-4afe-bc92-ade98e4b5a93` · binding `DB` |
| 迁移 | `db/migrations/0001_sources_items.sql`（sources / items / source_health + 索引） |
| 线上版本 | `14e8e4b5-77ba-479e-92a9-6b8fe7eb8410` |

**线上实测（经代理）**：连续两次 `/api/feed` → 第 1 次 `inserted=180`、第 2 次 `inserted=0 / duplicates=180`（**跨请求去重由唯一约束兜底**）；`/api/items` 只读库、秒回；6 源快照 `lastHealth=ok` 且 `baseline` 已建立（20/40/40/30/40/10）。证据 `e2e-evidence/live-increment2.log`。

**踩坑 2（已修，2026-11-02）**：部署脚本探针用 Node `fetch`，**不认系统代理** → 部署成功但探针全部失败、
脚本以 exit 1 退出，看起来像「部署失败」（连续两条后台任务被误判）。
修法：① 支持 `DEPLOY_PROXY` / `HTTPS_PROXY` 走 `curl -x`（并补上 curl 模式的 `content-type` 抓取）；
② 退出码语义修正——**部署成功但一个 HTTP 响应都没收到 → 记「未验证」，exit 0 + 警告**，只有真收到 HTTP 响应且校验失败才 exit 1。

**踩坑（已修）**：`wrangler d1 migrations apply` 按 **cwd** 解析 `migrations_dir`，在 `dist/ssr` 下执行会报
「No migrations folder found」→ 部署脚本改为先把 `db/migrations` 拷进 `dist/ssr/db/migrations` 再 apply。

## 1. 首次部署（2026-11-02 · 增量 1）

| 项 | 值 |
|---|---|
| Worker 名 | `ai-hot-radar` |
| 线上地址 | https://ai-hot-radar.ilikesaury.workers.dev |
| 版本 ID | `27d54cf4-8ccb-4c59-b5ed-2ed0ece093e2` |
| 部署方式 | `node scripts/deploy.mjs --skip-build`（`wrangler deploy --secrets-file`） |
| 绑定 | `env.ASSETS`（静态资产）、`MAGPIE_BASE_URL` / `MAGPIE_API_KEY` / `MAGPIE_MODEL` |
| D1 | **未创建**（增量 2 才需要；届时先 `npx wrangler d1 create ai-hot-radar-db`） |
| Cron | **未配置**（增量 4 才需要） |

**⚠️ secrets 当前是占位值**：增量 1 没有 LLM 调用，`MAGPIE_*` 填的是 placeholder；
**增量 3（评分）前必须替换为真实网关配置**，否则评分会 502。

## 2. M0（真环境抓取验证）：✅ 已通过（2026-11-02，经本机代理）

> 用户提示「本机开了代理，外网需走代理」——由此解开死结：之前的失败（Node fetch / curl / ego 全部超时）
> 不是网络策略白名单，而是**它们都不认系统代理**。实测 Clash 本地端口 `127.0.0.1:7890` 可达 workers.dev。

| 步骤 | 结果 |
|---|---|
| `/api/health` | ✅ `{"ok":true,"service":"ai-hot-radar"}` |
| 单源 `?src=hn&limit=5`（旧默认超时 8s） | ⚠️ 首次 `timeout`（hnrss.org 偶发慢）→ **默认超时改 12s**，复测正常 |
| 全源（6 源） | ✅ HTTP 200，2.7s：hn 20 / hf-blog 40 / arxiv 40 / simonw 30 / ithome 40 / sspai 10，**failures 无** |
| arXiv 端点迁移 | 旧 `export.arxiv.org/rss/cs.AI` 返回**无 item 空壳**（892B，实测）→ 改 `rss.arxiv.org/rss/cs.AI`，40 条真实论文 |

证据：`e2e-evidence/live-m0.log`（含原始 JSON 快照 `live-m0-snapshot.json`）。

**结论**：A1 ✅（真环境抓取闭环）；A2 初验 ✅（本轮无跨源重复，待入库后终验）；A6 ✅（坏源分类记录、好源不受影响）；
A9 部分 ✅（subrequest 6/50、墙钟 2.7–5s；**CPU 未直接读数**，需 dashboard/observability 复核）。

### 历史记录：为什么当时判定「无法在本机执行」（保留回溯价值）

本机实测（当时）：Node `fetch` 失败；`curl` 到 workers.dev/google HTTP 000；`curl` 到 registry.npmjs.org 200、
api.cloudflare.com 404（网络通）；`ego-browser` 二进制缺失。当时的结论「白名单 + ego 失效」对现象描述正确，
但对**根因**判断不全——真正根因是代理未配置，而非主机不可达。

## 3. M0 验证清单：✅ 已全部通过代理执行（见 §2）

- [x] 步骤 1 — 首页可渲染：`/api/health` 200
- [x] 步骤 2 — 抓取闭环（A1）：`/api/feed?src=arxiv-cs-ai` 200，health ok、40 条
- [x] 步骤 3 — 全源与失败隔离（A6）：6 源 200、failures 无

> 备用（人工浏览器验证，仅当代理也不可用时）：
> 1. 打开 https://ai-hot-radar.ilikesaury.workers.dev → 应见标题 + 源健康列表
> 2. 打开 `/api/feed?src=hn&limit=5` → `items` 非空、`health.level="ok"`
> 3. 打开 `/api/feed` → **200（非 500）**、`counts` 有数、失败源进 `failures[]`

## 4. 本增量产出的可验证证据（已在本机通过）

| 证据 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | 0 error |
| 单元/契约测试 | `npm test` | **43 通过 / 0 失败**（含 store 持久化语义） |
| 构建 | `npm run build` | 成功（`dist/ssr/index.js` + `dist/client` 资产） |
| **本地端到端（E2E）** | `npm run e2e:local` | **15/15 通过**（真实 build 产物 + 真实 HTTP + 真实 HN feed 夹具 + `node:sqlite` D1 替身跑**真实迁移 SQL**）—— 见 `e2e-evidence/local-e2e.log` |
| 部署 | `node scripts/deploy.mjs --skip-build` | 成功，版本 `27d54cf4`（首次）→ `c5dc0553`（arXiv 新端点 + 12s 超时），`env.ASSETS` 已绑定 |
| **真环境 M0** | `curl --proxy 127.0.0.1:7890 …` | **6/6 源 ok，180 条真实数据，无失败** —— `e2e-evidence/live-m0.log` |

### 4.1 本地 E2E 具体覆盖（为什么它算 E2E 而不是单测）

用 `e2e/bootstrap.mjs` 把 `cloudflare:workers` 换成 stub，在纯 Node 里加载**真要部署的 `dist/ssr/index.js`**，
起真实 HTTP server，用真实请求打进去；上游只用夹具替代（因为沙箱无外网）。覆盖：

| 项 | 验证内容 |
|---|---|
| A1 | `/api/feed?src=hn&limit=3` → 3 条；**用真实 HN feed**（CDATA + HTML 描述 + `dc:creator` + guid 真实怪癖）；标题去 CDATA、摘要去标签、pubDate 转 ISO |
| A2 | HN(3) + Atom(2) 共 5 条 → 去重后 4 条（夹具故意放一条与 HN 同链接），保留先出现者 |
| A6 | 4 个不可达源 → 整体仍 **200**，`failures[].error=network`，健康标记 `broken`，好源仍 `ok` |
| A5 | 首页 200 + SSR 出「AI 资讯雷达」+ HTML 含 `<script src="/assets/…">`（水合入口在） |

**E2E 自己踩的坑（已修断言/替身，不是产品 bug）**：
Void worker 读 `/.vite/manifest.json`，产物里就是 `dist/client/.vite/manifest.json`；
ASSETS 替身如果把 `.vite` 段剥掉就会 404 → 首页不输出客户端脚本（水合入口丢失）。
这一条对以后写 shim / 排查「页面无交互」都有用。

## 5. 已知问题与踩坑

1. **沙箱 Node 出网走白名单**（本次新发现）：`npm install` / `wrangler` 能通是因为命中白名单，
   不要据此推断「Node 能访问任意外网」。验证线上功能必须换通道（ego 或人工浏览器）。
2. **ego-browser 二进制失效**：`~/.local/share/ego/active_version_dir/ego-browser.exe` 不存在，
   依赖 ego 的线上 E2E（如产品③ 的脚本）在本机同样跑不了。已作为环境事实记录。
3. **部署脚本内置探针在本机会误报失败**：`scripts/deploy.mjs` 的探针用 Node fetch，
   在受限沙箱必然失败；判读时看 `wrangler` 的 `Success! Uploaded …` 与版本 ID，而不是探针结果。
   上游 CI（有真实出网）里探针才有意义。
