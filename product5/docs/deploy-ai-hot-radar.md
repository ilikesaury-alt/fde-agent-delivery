# 产品⑤ 部署记录 · ai-hot-radar

> 本文档记录部署事实与线上验证状态（唯一真源在 `../CONTEXT.md` 的验收标准；此处只记「做过什么、结果如何」）。
> 凭据（复用关系）统一登记在 `docs/线上环境速查.md`，本文不回显任何密钥。

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
