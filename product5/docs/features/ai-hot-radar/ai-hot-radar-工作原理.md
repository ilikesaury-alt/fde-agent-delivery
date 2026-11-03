# ai-hot-radar AI 资讯雷达 · 工作原理

> 面向开发会话。业务用法见同目录「交付文档」。

## 1. 架构总览

```
┌─ 浏览器 ──────────────────────────────────────────────┐
│  四页签：日报 · 精选 · 历史 · 源健康                     │
│  只读 /api/digest /api/top /api/items /api/sources      │
└────────────────────────┬───────────────────────────────┘
                         │ 同源 HTTP（无 CORS）
┌────────────────────────▼───────────────────────────────┐
│ Cloudflare Worker（Void + React SSR + Hono）            │
│                                                        │
│  Cron（3 个任务，按阶段拆分）                            │
│   :05 每小时  crons/fetch.ts   → lib/ingest.ts          │
│   :20 每小时  crons/score.ts   → lib/llm.ts → lib/score │
│   :30 00:00   crons/digest.ts  → lib/daily.ts           │
│                                                        │
│  手动接口（与 Cron 共用同一实现）                        │
│   GET  /api/feed      抓取 + 落库（lib/ingest.ts）      │
│   POST /api/score     批量评分（lib/llm.ts）            │
│   POST /api/digest    立即重生成日报（lib/daily.ts）     │
└────────────────────────┬───────────────────────────────┘
                         │
┌────────────────────────▼───────────────────────────────┐
│ D1（ai-hot-radar-db）                                   │
│  sources / items / scores / source_health / daily        │
└────────────────────────────────────────────────────────┘
                         │
        ┌────────────────┴────────────────┐
        │ 外部                            │ 外部
   6 个 RSS/Atom 源                  magpie 网关（OpenAI 兼容）
   hn / hf-blog / arxiv / simonw      仅用于打分
   ithome / sspai                    密钥仅在 Worker env
```

**为什么拆三个 Cron**：Cloudflare **Free 套餐每次 Cron 的 CPU 只有 10ms**、subrequest 上限 50/次。
「抓取 + 评分 + 生成日报」塞进一次调度必然超预算。拆开后每步预算可控，
且任一步失败不会牵连其它步骤（抓取失败不影响评分，评分失败不影响已生成的历史日报）。

**为什么手动接口与 Cron 共用实现**：`lib/ingest.ts`（抓取）与 `lib/daily.ts`（日报生成）被两边共用。
否则调完阈值手动刷新看到的日报，和次日自动生成的口径会不一致 —— 这类分叉在「一天只产出一份」的东西上极难发现。

## 2. 数据流

### 2.1 抓取（`lib/rss.ts` → `lib/ingest.ts`）

```
RSS/Atom URL
  → fetch（UA 标识 + Accept 头 + 12s 超时 + 2MB 响应上限）
  → parseFeedXml（零依赖解析器，纯函数）
  → RawItem[]（id / title / link / publishedAt / summary）
  → dedupeItems（同次抓取内去重：归一化 URL + 标题 hash）
  → store.saveItems（跨请求去重：DB 唯一约束 content_key）
  → store.recordRun（源健康快照 + 历史）
```

**解析器是自己写的**（`lib/rss.ts`），不引 XML 库：只支持 RSS 2.0 / Atom 的「取条目」子集，
换来更小的产物、更可控的行为，以及**纯函数可单测**（23 项测试覆盖实体/CDATA/坏日期/缺字段等真实怪癖）。

**踩过的两个真 bug**（写测试时抓出来的）：
1. **CDATA 先解包再剥标签**：若先剥标签，`<![CDATA[...]]>` 会被 `<[^>]+>` 整段吃掉 → 标题变空 → 条目被跳过。
2. **URL 尾斜杠未归一**：`https://a.com/p/` 与 `https://a.com/p` 被当成两条 → 去重漏判。

**日期不猜**：`pubDate` / `published` / `updated` 解析不出就是 `null`，绝不塞当前时间；
年份 < 1990 或超出当前 5 年视为坏日期（feed 里常见畸形值）。

### 2.2 去重（三层，职责不同）

| 层 | 键 | 作用域 | 防的问题 |
|---|---|---|---|
| 解析层 | guid > atom id > link > 内容 hash | 单条 | 同一条在 feed 里重复出现 |
| 请求层 | 归一化 URL + 标题 hash | 单次抓取 | 跨源转载同一篇（HN 与 HF 同时发） |
| 存储层 | `content_key` = 归一化 URL hash（**DB 唯一约束**） | 跨请求/跨进程 | 重启、多实例下的漏判 |

存储层是最终保证：内存 Set 在重启或多实例下会失效，而资讯去重恰恰是跨请求的。

### 2.3 评分（`lib/score.ts` → `lib/llm.ts`）

两阶段：

1. **本地预筛（确定性，不花 LLM 调用）**：标题过短 / 缺摘要 / 广告 / 招聘 / 促销 / 纯转发 → 丢弃。
   判据刻意保守 —— 只砍**明确**噪音，不确定的放行给 LLM。宁可多花一次调用，也不误杀好内容。
2. **LLM 四维打分**：相关性 0.4 / 新颖性 0.2 / 实用度 0.2 / 权威度 0.2 → 加权总分 0–100 + 一句理由。

**严格校验**：缺字段 / 越界 / 非 JSON → **该条失败，绝不塞默认分**。
默认分会静默拉低区分度，让阈值标定失去意义（这是从产品①「缺板块即失败重试」继承的硬纪律）。

**失败不写库**：失败的条目保持「未评分」，下一轮 cron 自动重试 —— 天然幂等补偿，不需要重试逻辑。

### 2.4 日报（`lib/digest.ts` → `lib/daily.ts`）

固定 6 板块：概览 / 头条 / 值得一看 / 分源视角 / 源健康 / 口径说明。

**阈值**：默认 70，来自评测集实测标定（见 §4），不是拍脑袋。
**头条门槛** = 阈值 + 15（联动，不写死）。
**多样性配额（D11）**：同一源最多占 topN 的 1/3，让位名额顺延给次高分的其它源条目。

> D11 的由来：线上实测 `top5` 全是 `arxiv-cs-ai` —— 该源日更 40 篇、权威度天然高，
> 只按分数排序会让日报退化成「arXiv 摘要列表」，失去「多源」的意义。

## 3. 存储设计

| 表 | 用途 | 关键设计 |
|---|---|---|
| `sources` | 源快照 | `baseline_count` 只在「正常且更多」时抬升 —— 坏源不能污染基线 |
| `items` | 资讯条目 | `content_key` 主键（去重）；`first_seen_at` 永不被覆盖（事实）；`published_at` 可空（不猜） |
| `scores` | 评分 | 同一条只留**最新一次**评分（重评分是常态，历史会让标定口径漂移）；未评分条目不写入 |
| `source_health` | 抓取历史 | 能回答「这个源什么时候开始坏的」→ 决定该重试还是换源 |
| `daily` | 日报 | `date` 为 UTC 日期主键；同一天重跑 = 覆盖（日报是「当日最新结论」不是追加日志） |

**绑定变量上限**：D1 单条 SQL 绑定上限 100（本地 SQLite 是 32766 → **本地测不出来**，产品③ 线上踩过 502）。
批量写入按**变量数**切批（items 10 行/批、scores 9 行/批）。

## 4. 阈值标定（`eval/`）

方法平移自产品③ 的 RAG 四指标标定，但标的物不同：③ 标「检索找到没」，⑤ 标「这条该不该进日报」。

```
50 条标签（应进 / 不该进）× 60 条真实模型评分 → 扫阈值 {50,55,60,65,70,75,80}
→ 每个阈值报 Precision / Recall / 漏选率 / F1
→ 推荐：F1 最高，并列时取 Recall 更高（本产品宁可多一条，不可漏一条）
```

**实测结果（2026-11-02）**

| 阈值 | Precision | Recall | 漏选率 | F1 |
|---|---|---|---|---|
| 50 | 69.2% | 81.8% | 18.2% | 0.750 |
| 55 | 75.0% | 81.8% | 18.2% | 0.783 |
| 60 | 77.3% | 77.3% | 22.7% | 0.773 |
| 65 | 89.5% | 77.3% | 22.7% | 0.829 |
| **70** | **100.0%** | **77.3%** | **22.7%** | **0.872** ← 默认 |
| 75 | 100.0% | 68.2% | 31.8% | 0.811 |
| 80 | 100.0% | 59.1% | 40.9% | 0.743 |

**⚠️ 标签来源**：50 条标签是 **AI 初标，非人工标注**。
流程与数字可复核，但不宣称「已人工标定」。用户复核 `eval/labels.json` 后重跑 `npm run eval` 即更新阈值
（**线上阈值还需同步改环境变量 `DIGEST_THRESHOLD`** 才会生效）。

## 5. 关键接口

| 接口 | 用途 | 触网 |
|---|---|---|
| `GET /api/health` | 存活探针 | 否 |
| `GET /api/feed` | 抓取 + 落库（手动刷新） | 是 |
| `GET /api/items` | 读已入库条目 | 否 |
| `GET /api/top` | 读精选（`?threshold=&limit=`） | 否 |
| `GET /api/digest` | 读日报（`?date=` / `?list=1`） | 否 |
| `GET /api/sources` | 源快照 + 历史（`?history=&source=`） | 否 |
| `POST /api/score` | 批量评分（`?limit=`，默认 10，上限 30） | 是（LLM） |
| `POST /api/digest` | 立即重生成当日日报 | 否 |

除 `/api/feed` 与 `/api/score` 外，其余接口都只读库 —— 页面刷新不会给源站压力，也不会烧 LLM 额度。

## 6. 前端

自研轻量 Markdown 渲染（`pages/index.tsx` 的 `renderMarkdown`），不引 markdown 库。

**安全取舍**：**不使用 `dangerouslySetInnerHTML`** —— 所有文本走 React 转义，
链接 href 过 http/https 白名单校验（`safeHref`）。少一个依赖、少一类 XSS 面、产物更小。

**渲染细节（2026-11-03 重设计）**：`renderInline` 先按 `**…**` 分段再解析链接 ——
日报概览里的 `**180**` 这类**纯粗体**与「粗体包裹的链接」（日报头条条目的形式）都能正确解析；
bullet 的缩进续行（`来源 · 时间`）并入上一条列表项，渲染为 `.doc-sub` 次行，不再另起段落。

SSR 由 Void 处理，页面首屏即出四个页签。

**视觉层（2026-11-03 重设计）**：`styles.css` 是与产品①–④ 同构的**设计令牌层**
（Tailwind 4 CSS-first `@theme`）：表面/描边/文字三层次 + 单一强调色（品牌）+ 语义色
（正常/降级/不可用、错误/警告）+ 圆角/阴影/字体，`prefers-color-scheme: dark` 只覆盖令牌值、
不写第二套 class。页面（`pages/index.tsx`）颜色**只从 `var(--color-*)` 取**。
上线首版教训：页面用了暗色系 class（`text-slate-100`）却没有深色底 → 白底近白字几乎不可见；
修法不是调色值，而是接入令牌层让颜色有唯一来源。日报排版走 `.doc` 组件层
（标题衬线、正文无衬线、链接/引用/代码块统一）。证据：`docs/e2e-evidence/ui-redesign-*.png`（拟真数据本地预览，亮/暗两套）。

## 7. 环境约束与坑

| 坑 | 根因 | 处置 |
|---|---|---|
| 本机 Node/curl 访问不了 workers.dev | **不认系统代理**（不是网络白名单） | 用 `curl --proxy` 或设 `DEPLOY_PROXY` |
| 部署脚本报「部署失败」但其实成功了 | 探针用 Node fetch，探不到就 exit 1 | 改为：收不到任何 HTTP 响应 → 记「未验证」exit 0；加 `DEPLOY_PROXY` 支持 |
| `curl: Unsupported proxy syntax` | Windows cmd `set X=Y && …` 把**尾空格**带进环境值 | 代理值强制 `.trim()` |
| `wrangler d1 migrations apply` 报「No migrations folder」 | wrangler 按 **cwd** 解析 `migrations_dir` | 部署脚本先把 `db/migrations` 拷进 `dist/ssr/db/migrations` |
| `arXiv` RSS 空壳 | 旧端点 `export.arxiv.org/rss/<cat>` 已迁移 | 改 `rss.arxiv.org/rss/<cat>` |
| 首页没有客户端脚本 | Void 读 `/.vite/manifest.json`，替身剥掉 `.vite` 就 404 | 替身只剥前导斜杠 |
| RSS 源会死 | 站点改版/停更 | 源健康三级 + 历史 + 连续失败次数；换源需人工判断 |
| 单源垄断精选 | 高权威高频源天然高分 | D11 单源配额（topN 的 1/3） |

## 8. 复现命令

```bash
cd product5
npm install --ignore-scripts        # 沙箱环境（CI 用 npm ci）
npm run typecheck && npm test && npm run build
npm run e2e:local                    # 端到端 27 项（真实构建产物 + SQLite 替身跑真实迁移 SQL）
npm run eval                        # 阈值标定（需 eval/scores.json）
node scripts/deploy.mjs --secrets .secrets.json
# 本机需代理：DEPLOY_PROXY=http://127.0.0.1:7890 node scripts/deploy.mjs --secrets .secrets.json
```
