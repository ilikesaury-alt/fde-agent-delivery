# 产品⑤ · CONTEXT（需求活文档 / Spec / 状态机）

> **流程**：`ai-dev-flow` 7 阶段（见 `E:/Obsidian/lic-notebook/AI-Workflow/skills/ai-dev-flow/SKILL.md`）。
> **本文档规则**：需求口径只增不改；决策写进「决策记录」，方案演进保留轨迹，被推翻的结论标注而非删除。
> **产品代号（暂定）**：`ai-hot-radar`（AI 资讯雷达）。

## 流程状态（状态机，读此即知卡在哪）

| 阶段 | 状态 | 产物 |
|---|---|---|
| 0 接单 | ✅ | 目标 / 范围一句话（§1–§2） |
| 1 需求对齐 | ✅（多轮 grill + 用户纠偏，详见 §3 演进） | §3 决策记录 D1–D10 + §4 验收标准 A1–A9 |
| 2 沉淀 Spec | ✅（2026-11-02 第三版定稿：RSS 多源） | 本文档 |
| 3 拆增量 | ✅（草案） | §8 增量清单（6 个，M0 在增量 1） |
| 3.5 方案复核 | ✅（2026-11-02 授权「开始实现」） | §9 五行模板；复核报告 `docs/方案复核-2026-11-02.md` |
| 4 实现 · 增量 1 | ✅ **完成**（M0 真环境 6/6 源通过，180 条真实数据） | 骨架 + `lib/rss.ts` + `/api/feed` + 首页；30 单测 + 11 E2E 过；已部署 `c5dc0553` |
| 4 实现 · 增量 2 | ⏳ 下一步：D1 存储层 + 持久化去重 + 源健康历史 | — |
| 4 实现 · 增量 3~6 | ⏳ 评分评测 / Cron+日报 / UI 完善 / 部署收口 | — |
| 5~7 审查/E2E/验收 | ⏳ | — |

## 作品集定位（能力增量轴）

①②③④ 全是「人触发 → 响应」；产品⑤ 补一条全新能力轴——**定时 + 主动 + 多源聚合**：

| 能力 | 现有产品 | ⑤ 新增 |
|---|---|---|
| 抓取 | ② 单 URL 网页 | **多源 RSS/Atom 聚合**（结构化契约，非爬页面） |
| 触发模型 | 全被动 | **Cron 定时触发 + 后台主动扫描**（首次） |
| 筛选 | ③ 检索相关性 | **两阶段评分精选，且用评测集标定**（precision/recall 可报数） |
| 持久化 | D1 | 复用（sources/items/scores/daily） |
| 向量检索 | ③ Vectorize | **不引入**（奥卡姆） |

## 1. 问题（为什么做）

- **核心问题**：4 个产品全是被动响应；AI 资讯分散在多个站点/博客/arXiv，人工逐个看成本高。需要一个「定时聚合 → 筛选 → 沉淀成日报」的主动型产品。
- **目标用户**：个人自用 / 作品集演示（纯演示定位，不做多租户）。
- **主场景**：系统定时从多个 AI 资讯 RSS 源拉取新条目 → 去重 → LLM 两阶段评分精选 → 每日聚合成固定板块日报 → 网页可浏览今日精选 + 日报 + 历史。

## 2. 范围（In / Out）

**In**
- 多源 **RSS/Atom** 订阅聚合（Worker `fetch` + XML 解析），Cron 定时触发（主动扫描）。
- 默认源列表（中英混合，D4）：HackerNews、OpenAI/Anthropic/Google DeepMind/HuggingFace 官博、arXiv cs.AI、Simon Willison、IT之家、少数派 —— **每个 feed URL 在 M0 实测可用后才进源列表**。
- 两阶段评分（预筛 → 多维评分取 top N），**阈值/权重用评测集标定**（D5）。
- 跨源去重（URL / 标题 hash）、源健康监测（feed 死链 / 条目骤降报警，D10）。
- 固定板块日报生成 + 网页浏览（今日精选 / 日报 / 历史）。
- D1 落库。

**Out（明确不做）**
- **抓取 x.com / Twitter**：经三轮调研被证伪（session 墙 / 免费 API 无 search / 付费 API 被否）——见 §3 D2 演进与 `docs/方案复核-2026-11-02.md`。
- **任意网页 HTML 爬取**：无契约、脆弱；RSS 之外不开放（与②「粘贴文本兜底」同理，明确边界）。
- 付费 API（官方 X / twitterapi.io / xclaw 等）、ego 浏览器、登录态 cookie（H 方案）—— 均被用户否决或无需。
- 多租户 / 权限 / 商业化；自主多步 Agent；向量检索；一期推送（Webhook/邮件，留二期）。

## 3. 决策记录（对齐结论 + 方案演进，只增不改）

- **D1 方向选定**：`A · AI 资讯雷达`，定位**纯作品集演示**；「自动扫描」定位不可变（用户明确）。
- **D2 数据源（演进，四轮）**：
  - ① 用户原要求 `x.com/home` → 三道硬墙（登录态 / Workers 无浏览器内核 / API $200 月）否决。
  - ② X 公开源 + 第三方付费 API（twitterapi.io）→ 用户坚持零成本，否决。
  - ③ X 免费接口（guest/syndication/fxtwitter）→ **实测证伪**：XActions/x-cli 文档证明 search/home 属 session 层（零登录拿不到）；fxtwitter 实测 `/2/search` 返回 404 空、无 timeline 端点（`docs/方案复核-2026-11-02.md` 附录三）；xclaw.info 拆解证明其为商业服务（SSR 内嵌数据 + 30 分钟管线 + 付费 API），非零登录样板。
  - ④ **定稿（2026-11-02，用户拍板「改」）**：**多源 RSS/Atom**。X 三道墙 RSS 一条都不撞；AI 领域 RSS 源现成且高质量；「自动扫描」在 RSS 上真正可落地。
- **D3 技术选型（定稿）**：Void + React SSR + Hono 文件路由 + Cloudflare Workers + D1 + magpie LLM 网关 + **RSS/Atom 解析**（不引第三方抓取服务）；Cron Trigger 定时。**不引入** Vectorize / 付费 API / ego / 登录 cookie。
- **D4 默认源列表（中英混合，用户未另行指定）**：HackerNews、OpenAI / Anthropic / Google DeepMind / HuggingFace 官博、arXiv cs.AI、Simon Willison、IT之家、少数派。**约束：每个 feed 必须 M0 实测可用才进列表**（feed URL 不凭记忆硬编码，失效源可配置替换）。
- **D5 评分机制（强化）**：两阶段（短 prompt 预筛 → 多维评分：相关性/新颖性/实用度/权威度，情绪不评——资讯场景无意义）。**核心差异化：人工标注评测集（≥50 条「该进 / 不该进日报」）标定阈值与权重，报出 precision / recall / 漏选率**——方法论平移自产品③ 的四指标标定，①②③④ 均未做过「筛选标定」。
- **D6 呈现形态**：固定板块日报（参考① 6 板块）+ 今日精选列表 + 历史回看。
- **D7 一期交付**：纯网页，推送留二期。
- **D8 存储与频率**：D1 落库（sources/items/scores/daily）；Cron 频率默认 **每 1–2 小时抓取 + 每日 1 次生成日报**（受 Free 套餐与 feed 礼貌间隔约束，可配）。
- **D9 零成本约束**：不引入付费服务、不引入独立运行时；Workers Free 的 **CPU 10ms / subrequest 50** 为硬预算（A9 护栏）。
- **D10 源健康与降级（新增）**：feed 失效是常态而非异常——按「HTTP 非 200 / 解析失败 / 条目数骤降」三级登记源状态并在 UI 可见；单源失败不影响其它源（降级不放大）；错误文案面向用户（沿用③ 401 与失败分开的教训）。

## 4. 验收标准（写死）

| # | 验收标准 | 判定方式 |
|---|---|---|
| A1 | Worker 在真环境拉取 **≥3 个 RSS/Atom 源**并解析出条目（标题/链接/时间/摘要），feed URL 全部来自可配置源列表 | 真环境探针（M0）+ 集成测试 |
| A2 | 跨源去重：同 URL / 同内容 hash 不重复入库 | 单测 + 重复拉取验证 |
| A3 | 两阶段评分产出多维分 + 综合分，top N 进精选；**阈值/权重由评测集标定，报告 precision / recall / 漏选率** | 评测集脚本 + 单测（评分纯函数） |
| A4 | Cron 分批完成「抓取 → 评分 → 生成日报」，日报为固定板块 Markdown 写入 D1 | Cron 触发后查 daily 行 + 单测聚合 |
| A5 | 网页可浏览：今日精选 + 日报板块 + 历史 | 浏览器/接口 E2E |
| A6 | 单源失败（死链/解析失败/超时）**不影响其它源**，源状态三级可见，文案面向用户 | 注入故障的单测 + 真环境坏源用例 |
| A7 | magpie key 仅存 Worker env，不进前端/仓库 | 构建产物 grep + 代码审查 |
| A8 | Cron 按配置频率触发（抓取 1–2 小时级 / 日报每日 1 次） | Cron 日志 + 真环境观察 |
| A9 | 单次 Cron 在 Workers Free 下不超 **CPU 10ms / subrequest 50**（实测计数；超了降批量或承认需 Paid） | 真环境实测 CPU 与 subrequest 计数 |

## 5. 关键决策（索引）

- 数据源走 RSS/Atom 结构化契约（D2-④/D4）——「自动扫描」唯一零成本可落地的形态；任意 HTML 爬取明确排除。
- 评测集标定精选（D5）——把「筛选」从玄学变成可报数的指标，作品集核心差异化。
- 源健康三级状态 + 降级不放大（D10）——feed 失效当常态设计，沿用③ 错误分类教训。
- Free 套餐硬预算（D9/A9）——小批量 Cron 设计，实测计数兜底。

## 6. 假设与待确认

**已验证**
- X 数据获取的墙（session 层 / 免费 API 无 search / CF 拦截实证）——`docs/方案复核-2026-11-02.md` B1–B3 + 附录一~三，逐条实测。
- Workers 无浏览器内核（HTML SPA 抓不到）；**RSS 是结构化契约，不受此限**。
- Workers Free 限额：CPU 10ms（含 Cron）、subrequest 50/次、Cron 5 个/账号、requests 10 万/天（官方 Limits 2026-10-29 版）。

**假设（未经证实）**
- D4 默认源列表中的 feed URL 全部真实可用 —— **M0 逐个实测**，失效即替换（列表可配置）。
- Workers Free 的 CPU/subrequest 预算支撑「单次抓 3–5 个 feed + 小批评分」—— A9 实测。
- D1 免费日额度、D1 是否计入 subrequest —— 实现前查官方文档核实。

**待确认（需人工回答）**
- [x] M0 真机验证 → 已通过代理通道完成（`docs/deploy-ai-hot-radar.md` §2）：6/6 源 200、180 条真实数据、无失败
- [x] 源列表范围：6 源全部实测可用（hn/hf-blog/arxiv/simonw/ithome/sspai），`verified` 已回填
- [ ] Cron 频率确认（默认每 1–2 小时抓取 + 每日日报；增量 4 配置时定）（负责人：用户）
- [ ] 评测集标注（≥50 条「该进/不该进」）（负责人：用户；增量 3 先出标注表格）
- [ ] A9 的 CPU 直接读数（dashboard/observability；subrequest 与墙钟已实测）（负责人：下个会话）

## 7. 影响面

- **涉及文件/模块**：新 Void 项目骨架、`lib/rss.ts`（fetch+XML 解析+规范化）、`lib/score.ts`、`lib/digest.ts`、`lib/store.ts`+`db/migrations`、`routes/cron.ts`、`routes/api/*`、`pages/*`、`eval/`（评测集+标定脚本）、`scripts/deploy.mjs`。
- **数据/接口**：D1 表 `sources`（含 health 状态）/ `items` / `scores` / `daily`；env `MAGPIE_*`（RSS 无需 key）；路由 `/api/feed` `/api/daily` `/api/history` `/api/sources`。
- **风险点**：Cron 并发写 daily（D1 唯一约束兜底）；评分阈值漂移（评测集复扫）；迁移走 `migrations apply`（已知坑）；单次 Cron 限额（A9）；feed 失效（D10 常态化设计）。

## 8. 增量清单（阶段 3，草案）

| # | 增量 | 涉及文件/模块 | 验收方式 | 风险点 | 依赖 |
|---|---|---|---|---|---|
| 1 | **M0（真 Worker 抓 3 个 feed→解析→去重）+ 骨架** | 骨架 + `lib/rss.ts` + 源配置 | 真环境 A1 最小闭环 + A9 首次计数 | feed URL 失效即换；**M0 不过即停回方案** | — |
| 2 | D1 存储层 + 跨源去重 + 源健康 | migrations、`lib/store.ts`、health 三级 | 单测去重/健康 + 重复拉取验证（A2/A6） | 迁移走 `migrations apply` | 1 |
| 3 | 两阶段评分 + 评测集标定 | `lib/score.ts`、`eval/`（标注集+脚本） | A3：precision/recall/漏选率 报数 | 标注质量；阈值漂移 | 1（magpie） |
| 4 | 日报聚合 + Cron | `lib/digest.ts`、cron 配置、`routes/cron.ts` | A4/A8 + A9 实测 | 并发写 daily；限额 | 2/3 |
| 5 | 网页 UI（精选+日报+历史+源健康） | `pages/*`、`routes/api/*` | A5 E2E | layout 返回 fragment（①教训） | 2/4 |
| 6 | 错误处理 + 安全 + 部署 | 错误映射、env 校验、`scripts/deploy.mjs` | A6/A7 + 构建产物 grep + 部署探针 | 密钥入前端产物 | 1–5 |

## 9. 阶段 3.5 方案复核（写码前，人审放行点）

> 第三版定稿（RSS 多源）后的复核模板。**需人授权「开始实现」。**

① **技术选型**：Void + React SSR + Hono + Workers（Free）+ D1 + magpie + **RSS/Atom 原生解析**（`fast-xml-parser` 一类轻依赖，奥卡姆评估后定）；Cron 两级（抓取小时级 / 日报每日）；不引 Vectorize / 付费 API / ego / cookie。

② **模块边界**：`lib/rss`（抓取+解析+规范化，feed 失效不放大）/ `lib/score`（纯函数）/ `lib/digest`（聚合）/ `lib/store`+`db`（D1）/ `routes/cron` / `routes/api/*` / `pages/*` / `eval`（标注集+标定脚本）。评分与聚合可单测，RSS 客户端可注入 fetchImpl 测试。

③ **高风险点及应对**：feed URL 失效（M0 逐个实测 + 列表可配置 + health 三级）；Free CPU 10ms/subrequest 50（A9 实测 + 小批量设计）；评分标注质量（用户参与标注，先 50 条）；并发写 daily（唯一约束）。

④ **是否拆增量**：是，6 个（§8），M0 在增量 1（真环境 feed 闭环 + 限额实测）。

⑤ **复核结论**：方案就绪（数据源经四轮演进、三轮实测收敛到 RSS；X 路线已证伪留档）。**请授权「开始实现」（阶段 4）**；授权后从增量 1 起步，先测后码，M0 不过即停。

## 10. 调研记录

完整调研与复核证据链见 `docs/方案复核-2026-11-02.md`（B1–B3 阻塞、附录一 xclaw 拆解、附录二 零成本三选 F/G/H、附录三 fxtwitter 实测矩阵）。要点：

- X 路线证伪：零登录拿不到热门/搜索（session 层）；fxtwitter 实测无 search/时间线；直连 api.x.com 有 CF 拦截实证。
- `xclaw.info` 为商业服务（SSR 内嵌数据 + 30 分钟管线 + 需鉴权 API + 同名产品订阅），非零登录样板。
- RSS/Atom 是「自动扫描」唯一零成本可落地的形态：结构化契约、站点主动提供、Worker 可直接 fetch、失效可探测。
- 本会话前期调研曾两次误判（「必须付费/ego」「免费接口全通」），均由实测与一手文档修正——教训：**能力断言必须 M0 实测，文档声明不算数**。
