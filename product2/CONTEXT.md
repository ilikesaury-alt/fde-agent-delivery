# 产品② CONTEXT — 内容生产工作台（Web 版）

> 流程：dev-task-flow（🟡 标准档）。本产品为个人 FDE 作品集的第 2 个产品。
> 元信息：模型组合 = 规划/编码/审查均由本会话 DeepSeek Harness 完成；E2E 由用户手动跑（第 11 步）。
> 定档说明：虽为从零项目，但用户显式指定走 dev-task-flow，且平台层（Void+CF 栈、部署管线、magpie 接入、令牌保护）复用产品①已验证资产，从零部分仅业务层；实现中若规模/风险膨胀触发阻塞 #4 再重定档。

## 要解决的问题
- **核心问题**：自媒体创作者有素材（文章链接或原始想法/文本）后，把它改写成符合小红书风格（标题吸睛、正文口语化、带话题标签）的笔记时，手动改写耗时且风格难拿捏。
- **目标用户**：个人 / 自媒体创作者自用（单用户，访问令牌保护）。
- **主场景**：贴一条文章 URL（或粘贴文本）→ 流式看到「抓取→分析→生成」各步进度 → 得到小红书图文笔记（标题+正文+话题标签）→ 复制使用，结果自动存入历史可回看/重新生成。

## 范围（In / Out）
- **In**：
  - URL 抓取：贴链接自动取正文作为素材（范围与回退待澄清）。
  - 粘贴/上传纯文本作为素材（保底输入方式）。
  - 小红书单平台：图文笔记生成（标题 + 正文 + 话题标签，结构细节待澄清）。
  - 流式进度：多步流水线（抓取→分析→生成）逐步反馈（粒度待澄清）。
  - 历史记录：生成结果落库，可回看（存储选型与粒度待澄清）。
  - 重新生成：对同一素材再生成（语义待澄清）。
- **Out（MVP 明确不做）**：
  - 其他平台（公众号 / 抖音口播稿 / 微博 / X 等）。
  - 自动发布到小红书。
  - AI 配图 / 图片生成。
  - 账号体系（单用户访问令牌沿用产品①方案）。
  - 定时/批量任务。

## 数据规格（输入/输出）与边界、异常处理规则
- **输入**（二选一，前端切换）：① URL（http/https，自动抓取正文）；② 纯文本粘贴（保底）。
- **流水线**（3 步，SSE 推进度）：
  1. **抓取**（仅 URL 输入）：Workers fetch + HTML 正文抽取（去导航/广告/脚本）。
  2. **素材准备**：素材 > 阈值（约定 6,000 字）→ 自动调 LLM 压缩为要点（保留关键事实/数据/金句）；否则直通。
  3. **生成笔记**：LLM 生成小红书笔记，**token 级流式输出**。
- **输出**（小红书图文笔记 `XhsNote`）：主标题（≤20 字）+ 备选标题 ×2 + 正文（目标 300–600 字，emoji 装饰，口语化）+ 话题标签 3–6 个（# 开头）。前端分块展示、可独立复制。
- **进度事件**（SSE）：step 状态（started/done/failed + 摘要信息）+ 生成步骤 token 增量。
- **历史记录**：每次生成落库一条（id / 时间 / 来源类型+摘要 / 素材要点 / 笔记 JSON / 状态），列表倒序。操作：回看全文、复制（标题/正文/标签/整篇）、删除、从此条重新生成（用原素材重跑流水线 → 新记录，旧记录保留）。
- **边界/异常**：
  - URL 抓取失败/非正文页（404、登录墙、纯动态渲染）→ 明确错误 + 引导切换「粘贴文本」模式，不崩溃。
  - 空输入 → 禁用提交。
  - 超长素材 → 自动压缩（见上）；压缩后仍超硬上限（约 3 万字符）→ 友好报错「请精简后重试」。
  - LLM 失败 / magpie 未配置 → 5xx + 明确错误文案（不泄露堆栈）。
  - LLM 输出非预期格式 → 兕底：提示重试，不展示破碎内容。
  - 无令牌/令牌错误 → 401 拒绝（沿用产品①机制）。

## 关键决策与取舍
1. **技术栈复用产品①的 Void（Vite + React SSR + Cloudflare Workers）**：用户已拍板。理由：部署管线、skill 沉淀、magpie 接入、令牌保护全部已验证，最快出活；栈深度优先于广度（产品③再考虑换栈）。
2. **LLM 仍经 magpie 中转（OpenAI 兼容）**：复用产品① `lib/llm.ts` 模式。
3. **单平台（小红书）MVP**：多平台改造留给后续版本；流水线分步架构（step 状态机）按可扩展设计，加平台 = 加 prompt 模板。
4. **引入存储（产品①是无状态的，本产品首次引入）**：历史记录需持久层；候选 D1（SQLite，支持列表/删除查询）vs KV（简单键值），方案设计阶段定（倾向 D1）。
5. **URL 抓取为 CF Workers 内 fetch + HTML 解析**：无 headless 浏览器（Workers 环境限制），动态渲染页/强反爬站抓不到 → 粘贴文本为一级输入方式（非隐藏兕底）。
6. **超长素材自动压缩**（产品①是仅报错，本产品升级）：多一次 LLM 调用换体验，URL 场景下几乎必需；仍保留硬上限友好报错。
7. **进度 = SSE**：步骤状态 + 生成 token 流。Worker 流式响应 + magpie `stream:true` 透传是本产品最大技术不确定性（M0 验证点）。
8. 参考实现（已克隆）：`research/xhs_content_agent`（抓取→分析→文案流水线分步思想）、`research/mcp-viral-transformer`（URL→爆款文案）。

## 约束（技术栈 / 性能 / 安全）
- **技术栈**：Void（Vite + Rolldown + React SSR）+ Cloudflare Workers，同源 `/api/*` 文件即路由。
- **环境限制（产品①已验证）**：沙箱内 `npm install` 须 `--ignore-scripts`；`vite dev` 因 workerd spawn 受限不可用，本地验证用 Node shim（`e2e/server.mjs` 模式）；构建 `vite build` 可用。
- **安全**：API Key 仅存 Worker env；前端零密钥；访问令牌保护复用产品①方案。
- **部署**：Cloudflare Workers；部署后必查 `versions view` 资产绑定（防 1101 复发）。

## 已确认方案（design-plan 产出，第 3 步）

### 方法触发表
| 症状 | 是否命中 | 处置 |
|---|---|---|
| 第一性原理（沿用/改造现有方案） | 命中 | 问题本质 = 「URL→小红书笔记的转换流水线」，不是「多平台内容平台」；复用产品①模式是快路径而非伪路径，已确认无伪问题 |
| 对抗性审查（无条件必跑） | ✅ 已跑 | 反例与结论见下「对抗性审查」 |
| 消融实验 | 未触发 | 无拿不准收益的优化机制；LLM temperature 等参数非机制 |
| 奥卡姆剃刀（新增抽象） | ✅ 已跑 | 砍掉：消息队列/异步 Job（同步 SSE 流内完成流水线即可）、独立 Job 表（单表单状态列够用）、通用平台抽象层（MVP 单平台，pipeline 函数直接写死三步，加平台时再抽象） |
| 高内聚低耦合（拆模块） | ✅ 已跑 | 按「流水线阶段」分层（抓取/压缩/生成/存储互不依赖，经数据结构衔接）；LLM/抓取/存储均接口化可注入，便于测试 |

### 对抗性审查（能推翻核心假设的反例）
| 反例 | 判定 |
|---|---|
| 「SSE 在 Workers+Void 走不通，只能轮询」 | 被推翻：`void/sse` 一级支持（已核实 dist/runtime/sse.d.mts 有 `eventStream()`/`connectEventStream()`），magpie 上游 `stream:true` 透传为 M0 验证点 |
| 「D1 在沙箱/本地测不了，存储层会拖慄交付」 | 部分成立：沙箱内 workerd 不可 spawn，D1 只能真机验证 → **repository 接口化 + 内存实现**，单测跑内存实现，D1 真实链路留给用户 E2E |
| 「URL 抓取不可靠导致核心体验崩坏」 | 成立但已有设计：粘贴文本为一级输入、抓取失败明确报错引导切换，验收标准 4 已写死 |
| 「流式响应中途失败，历史里残留半截记录」 | 成立：落库时机改为**完成时**（含 failed 状态记录原因），流中不写库 |
| 「压缩要点丢失关键细节导致笔记偏离原文」 | 接受风险：prompt 要求保留事实/数据/金句；E2E 检验，不达标再调 prompt |

### 落选候选清单（库/依赖级，design-plan 第 4 条；2026-10-27 补充复活结论）
| 候选 | 筛掉原因 | 复活条件 |
|---|---|---|
| **HTMLRewriter**（边缘原生流式解析） | 「本地可测性」约束（Node shim/单测里没有该 API）；2026-10-27 曾实现后回退：①它**不解决抓取质量问题**（质量在启发式不在解析器，X 是 SPA 无 article 容器，换解析器同样抽到混合文本）；②流式/内存优势在 2MB cap + 128MB 内存下无感；③双实现引入「行为一致性只能线上验证」的新成本 | 出现大页面（>2MB cap 不够 / DOM 树吃紧）需要流式解析时；或需要对 Response 做边抓边改时 |
| cheerio | 与 linkedom 同类（DOM 树解析），无决定性优势 | linkedom 出现兼容问题时 |
| 站点规则表（知乎/公众号/博客园选择器） | 范围膨胀（MVP 奥卡姆砍掉） | **抓取质量要真正提升时的正道**：对高频来源写选择器规则；或改进启发式（文本密度/链接密度判据替代「p 聚合 vs body 取长」） |
| 改用 EventSource | POST + Authorization 场景不支持 | 无 |

### 现状标注（code-reality-check，2026-10-26 核实）
| 实体 | 结论 | 现状 |
|---|---|---|
| `void/sse`（`eventStream`/`connectEventStream`） | 已存在 | `void@1.2.1` dist/runtime/sse.d.mts + sse-client.d.mts，一级导出 |
| `void/db`（Drizzle+D1，`DB` 绑定自动推断） | 已存在 | dist/runtime/db.d.mts：`db` 默认实例 + `createDb(d1)`；import `void/db` 即触发 needsD1 自动开通；迁移从 `db/migrations/*.sql` 收集 |
| 产品① `lib/llm.ts` 调用模式（callLLM + 错误分类） | 已存在 | product1/lib/llm.ts；**产品②不跨目录引用**，新建 product2/lib/llm.ts 按同模式实现并增加流式变体（复制改造，非 import） |
| 产品① 令牌校验 `checkAccessToken` | 已存在 | product1/routes/api/digest.ts；同上，复制改造到 product2/lib/auth.ts |
| 产品① Node shim（e2e/server.mjs） | 已存在 | product1/e2e/server.mjs；产品②自建 shim 参考，注入内存 repository |
| 产品②全部业务代码 | 待建 | product2/ 新目录，结构见下 |

### 技术选型
- **框架**：Void（vite build / routes/api/ 文件即路由 / defineHandler），与产品①同版本（void ^1.2.1, react ^19, tailwind ^4）。
- **流式**：`POST /api/generate` 返回 `eventStream()`；上游 magpie `stream:true`（生成步）逐 token 转发。事件协议：`step`（抓取/准备状态）→ `token`（正文增量）→ `done`（完整笔记 JSON + jobId）/ `error`。
- **存储**：D1（`void/db` 自动绑定）+ Drizzle；单表 `jobs`（id/created_at/source_type/source_url/source_excerpt/material_brief/note_json/status/error）。迁移 SQL 放 `db/migrations/`。
- **HTML 正文抽取**：`linkedom`（Workers 兼容，无 native 依赖）+ 手写正文启发式（取最大文本块），失败即报错。
- **前端**：React SSR 页面 + `connectEventStream` 消费；两个视图（生成工作台 / 历史列表）。

### 模块边界（product2/）
```
env.ts                    # MAGPIE_* + ACCESS_TOKEN（同产品①口径）
void.config.ts            # head 配置（layout 返回 fragment！）
routes/api/generate.ts    # POST SSE 流水线入口（令牌→抓取→准备→生成→落库）
routes/api/jobs.ts        # GET 列表 / GET :id / DELETE :id
lib/llm.ts                # callLLM（非流式，压缩用）+ streamLLM（生成用）
lib/fetch-article.ts      # URL→正文抽取
lib/pipeline.ts           # 三步编排（依赖注入：llm/fetcher/store）
lib/store.ts              # JobStore 接口 + D1 实现 + 内存实现（测试/shim 用）
lib/prompt.ts             # 压缩 prompt + 小红书笔记 prompt（结构化输出约定）
lib/note.ts               # XhsNote 解析/校验/兕底
lib/auth.ts               # 令牌校验（同产品①模式）
pages/index.tsx 等        # 工作台 UI + 历史视图
test/                     # 纯函数 + 路由层测试（内存 store，不依赖 D1）
e2e/server.mjs            # Node shim（内存 store，无 workerd）
db/migrations/0001_init.sql
```

### 高风险点及应对
1. **SSE 端到端（M0）**：先写最小路由验证 eventStream + streamLLM 贯通（mock fetch 流），不过则回第 3 步改方案（降级为轮询）。
2. **D1 沙箱不可测**：store 接口化，单测全走内存实现；D1 真实链路列入第 11 步用户 E2E 清单。
3. **部署绑定变更**：首次部署 D1 自动开通后必须 `versions view` 核验 DB 绑定 + 资产绑定（防 1101 复发）。
4. **抓取不可靠**：超时 10s + UA 伪装 + 失败明确报错引导；不做重试（奥卡姆）。
5. **流式中断残留**：完成时才落库；中断=无记录（前端已有 token 已渲染内容提示重试）。

### 是否拆 Issue
不拆。规模单产品单人可控，走单任务清单（Phase 0 = M0 SSE 贯通）。

## 验收标准（写死）
1. 贴一条普通文章 URL 点「生成」：可见「抓取→准备→生成」步骤进度，生成正文**逐字流式**出现，最终笔记含主标题 + 2 备选 + 正文 + 标签。
2. 正文长度约 300–600 字（LLM 波动容差 ±15%），含 emoji 装饰，标签 3–6 个。
3. 粘贴纯文本（短于阈值）生成等效成功。
4. 抓取失败的 URL（如 404/登录墙）→ 明确错误提示 + 引导切换粘贴模式，不崩溃不无限等待。
5. 超长文本（>6,000 字）自动压缩后正常生成，万级长文不崩；压缩后仍超硬上限（约 3 万字符）→ 友好报错。
6. 历史列表按时间倒序展示每次生成，点开可回看全文；删除后列表消失。
7. 从历史条目「重新生成」→ 产生新记录，旧记录保留，两者可对比。
8. 主标题/备选/正文/标签均可独立复制且有成功反馈。
9. 未配置 magpie env → 调用返回明确错误文案（非 500 堆栈泄露）。
10. 无令牌/错误令牌访问 → 拒绝（沿用产品①机制）。
11. 前端无密钥硬编码；Worker 仅从 env 读密钥。
12. 空输入时提交禁用，不发请求。

## 术语表（Business Term → Unified Code Naming → Description）
| Business Term | Code Naming | Description |
|---------------|-------------|-------------|
| 素材 | `SourceMaterial` | 输入的文章正文（URL 抓取）或粘贴文本 |
| 抓取 | `fetchArticle` | URL → 正文抽取（流水线步骤 1） |
| 素材要点 | `materialBrief` | 超长素材经 LLM 压缩的要点产物（流水线步骤 2） |
| 小红书笔记 | `XhsNote` | 输出结构：`titles[3]`（主+2备选）/ `body` / `tags[]` |
| 生成任务 | `GenerationJob` | 一次流水线运行 = 一条历史记录 |
| 流水线 | `pipeline` | 抓取 → 准备 → 生成 三步状态机 |

## 已知风险 / 踩过的坑
- 产品①沉淀：layout 必须返回 fragment（勿返回完整 html，防 SSR 水合错位 → focus-hang）；部署勿用 `wrangler deploy --config dist/ssr/wrangler.json`（跳过资产上传 → 1101）。
- **URL 抓取成功率不可控**（本产品最大新风险）：Workers 无 headless 浏览器，动态渲染页（部分公众号文章、登录墙内容）抓不到正文；粘贴文本为一级输入路径（非隐藏兕底），抓取失败明确报错引导。
- **首次引入持久层**：产品①无状态，本产品历史记录需 D1/KV + 绑定配置，部署链路多一步（bindings 变更须 versions view 核验）。
- **SSE 流式**在 CF Workers + Void 栈的端到端可行性未经产品①验证，列为 M0 验证点。
- **LLM 输出结构稳定性**：标题/标签结构化输出需 prompt 约束 + 解析兕底（产品① sections/validate 模式可复用）。

## 流程状态
- [x] 第 0 步：定档 🟡
- [x] 第 1 步：准备（CONTEXT.md 已初始化）
- [x] 第 2 步：需求对齐（第 3 轮收口，验收标准已写死）
- [x] 第 3 步：方案设计（含现状标注 + 对抗性审查）
- [x] 第 3.5 步：文档复核 + 用户授权（2026-10-26「开始实现」）
- [x] 第 4 步：实现（自测 82 单测 + 33 端到端）
- [x] 第 5 步：交叉对抗审查（15 项：4 阻塞 + 11 非阻塞，已全部处置）
- [x] 第 6 步：人工 Review（验收标准 → 业务路径 → 新增抽象，二次奥卡姆：删临时 M0 探针）
- [x] 第 7 步：交付文档（product2/docs/features/content-studio/）
- [x] 第 8 步：提交 5cb55af（已标 E2E pending）
- [x] 第 9 步：HANDOFF（`product2/docs/HANDOFF-content-studio.md`）
- [x] 第 10 步：复盘与 Skill 沉淀（补写 cf-worker-local-env 两节）
- [x] 第 11 步前置：部署（2026-10-27，version 2ea32819，绑定与资产上传已核验）
      > 当前线上版本以 `docs/线上环境速查.md` 为准（本行是当时的部署快照）。
- [x] 第 11 步前置：接口级 E2E（线上 401/200、真 D1 连通）
- [x] 第 11 步：线上端到端（首字 8.4s、16.2s 完成、真 D1 落库 1 条）
- [x] 第 11 步：线上 E2E 全量（T4/T5/T6/T8/T9/T10/T11/T12/T16 全过，证据见 docs/e2e-evidence/live/README.md）

## 第 10 步复盘（2026-10-26）

### 重复次数统计（判定是否该沉淀）
| 重复出现的流程/坑 | 次数 | 是否沉淀 |
|---|---|---|
| SSE 流式在本栈的验证方式与坑（shim 缓冲假绿 / 同 tick 合并误判 / keepAlive interval 泄漏 / 有帧无 content 当成功） | 4 个独立坑 | ✅ 补写进 `cf-worker-local-env`「流式（SSE）在 Void/CF 栈的验证与坑」 |
| D1 本地不可启动的替代验证（内存假数据 vs node:sqlite 跑真 migration） | 2 种做法对比 | ✅ 补写进同一 Skill「D1 本地验证」 |
| SSRF 加固清单（IPv6 十六进制写法 / DoH / 逐跳重定向） | 1 次（但被审查判阻塞） | ❌ 不单独成 Skill（一次性）；结论留在 `lib/fetch-article.ts` 注释 + 本文件风险表 |
| 「测试必须消费完响应流，否则进程挂住」 | 1 次 | ❌ 已并入 SSE 一节 |

### 做减法
- 与 `perf-hang-triage` 是否重叠：前者是「页面卡死分层诊断」，本次是「服务端流式验证」，领域不同，不合并。
- 未发现因模型能力升级而过时的约束。
- Skill 体量：163 → 222 行（+59）。仍在可接受范围；若继续膨胀，把「部署/1101」与「本地验证」拆成两个 Skill。

### 本次流程自身的漏点（回流到 dev-task-flow 的判断）
1. **后端实现先写、测试后补**：测试确实抓到 3 个真实缺陷（DONE 早退、remove 判定、预览吞行），说明补测也有效，但测试先行能更早暴露。
2. **M0 的判据要写死「多事件之间留间隔」**：第一版 M0 探针因同 tick 连发，把自己的流判成「非流式」，白跑一轮。已写入 Skill。
3. **交付文档里的「需人工」项要集中成清单**：本次在交付文档 §7 做了验收对照表，第 11 步可直接照拄执行。

## 验收证据

### 第 5 步交叉对抗审查（2026-10-26）

**5a 去重**：已核实事实（void/sse 可用、magpie 支持 stream、33 项端到端通过、测试/构建绿）已写入派单，禁止重查。
**5b 定档**：**大档**（碰 DB/迁移、删除语义、权限点）。完整对抗审查，读 12 文件上限。
**结果**：返回 15 项（4 阻塞 + 11 非阻塞）。逐条处置如下。

#### 阻塞项（已全部修复并加测试）
| # | 问题 | 处置 | 验证 |
|---|---|---|---|
| B1 | `pages/index.tsx` 的 stripMarkers 用「已过滤数组」的下标去切「未过滤数组」→ 流式期间吞掉正文前 N 行，验收 1 实际不可见 | 抽出 `lib/note.ts previewBody()`，与 `parseNote` 共用同一套标记正则；同时修标签段混入正文 | 新增 5 项测试（含「三行正文一行不能丢」） |
| B2 | `run()` 无终态保证：流正常结束但无 done/error 时长驻「生成中」；`cancelled` 是死代码；无空闲超时 | try/finally 里统一 `setRunning(false)`；`consumeGenerateStream` 增加 AbortSignal + 90s 空闲超时 + 「未见 done 即异常结束」；新增「取消」按钮 | 类型+逻辑已验证；需人工点验 |
| B3 | 压缩后不再校硬上限 → 模型返回超长要点时，验收 5 后半段分支不存在 | `pipeline.ts` 压缩后重校 HARD_CAP 并报友好文案；路由层再加请求体前置闸 | 新增 2 项测试 |
| B4 | SSRF 可绕过：DNS 解析到内网（nip.io）、IPv6 十六进制写法（`::ffff:7f00:1`）、`redirect:follow` 先打到内网再拦 | 重写 `fetch-article.ts`：IPv6 按 8 组展开判定（含 mapped/compat/NAT64/6to4/ULA/link-local）+ DoH 解析后校验全部 A/AAAA + 手动逐跳重定向 + 拒 userinfo/异常端口/超长 URL | 新增 7 项测试（包括「绝不能真的请求内网地址」） |

残余风险（已登记在「已知风险」）：DoH 校验与真实 fetch 之间仍有 DNS rebinding 的 TOCTOU 窗口；但接口需令牌，非令牌持有者无法触发抓取。

#### 非阻塞项处置
| # | 问题 | 处置 |
|---|---|---|
| N1 | 并发重生成无守卫 → 两流 token 交错 | `run()` 首行用 `abortRef` 做并发闸；`onReuse` 再加 `running` 守卫 |
| N2 | `onOpen` 不更新 lastSource → 「换一版」用错素材 | `onOpen` 同步 `lastSource` |
| N3 | 上游 error 帧被忽略 → 截断笔记当成功落库 | 新增 `UPSTREAM_ERROR` 哨兵，流结束后报「生成被上游中断」 |
| N4 | 非 SSE 非 JSON 的 HTML 错误页被当正文 | 仅 `text/plain` 允许降级，其余报错 |
| N5 | `list` 用 `SELECT *` 搬运 50×3 万字原文 | 改显式列（不含 source_text/material_brief），新增 `GenerationJobSlim` |
| N6 | `ORDER BY created_at DESC` 无 tiebreaker，同毫秒顺序不稳 | 加 `, id DESC`；内存实现同步 |
| N7 | `remove` 先查再删（两次 round-trip + TOCTOU） | 改 `DELETE ... RETURNING id` 单次判定 |
| N8 | 未知 status 静默归为 succeeded | 改为仅 `succeeded` 算成功，其余算失败 |
| N9 | `pipeline` 三处 catch 把原始 `err.message` 上屏 | 只对自定义错误用其文案，其余统一兜底 |
| N10 | 验收 2 的正文长度/标签数/emoji **完全无后置校验** | pipeline 产出 `warnings`（非致命），经 `done.warnings` 上屏提示 |
| N11 | 请求体无大小上限 | 路由层 `text.length > HARD_CAP` 前置 400 |
| N12 | `readCapped`/linkedom 异常未归一 → 英文 DOMException 上屏 | 包成 `FetchArticleError`；`content-type` 缺失仍允许但靠长度门槛兜底 |

**审查后回归**：单测 **82 → 101**（+19），`tsc --noEmit` 0 错误，`vite build` 成功，本地端到端 **33/33** 重跑通过。

### 第 4 步实现自测（2026-10-26）

| 验证 | 命令 | 结果 |
|---|---|---|
| 类型 | `node node_modules/typescript/bin/tsc --noEmit` | ✅ 0 错误 |
| 单测 | `node --experimental-strip-types test/run.ts` | ✅ 82/82，4.9s 干净退出 |
| 构建 | `node node_modules/vite/bin/vite.js build` | ✅ 成功；生成 `wrangler.json` 含 `d1_databases[DB]` + `assets[ASSETS]` 绑定 |
| 本地端到端 | `node e2e/flow-check.mjs`（真 magpie + node:sqlite 跑真 migration） | ✅ **33/33** |

**关键 E2E 证据（真实证据，非 mock）**：
- 流式时间线：`step:fetch/skipped@78ms → step:prepare/skipped@78ms → step:generate/started@78ms → token@14794ms → …(22 个 token)… → step:generate/done@15481ms → done@15481ms`
  → 首 token **14.8s**，步骤进度全程覆盖等待期（验证方案对步骤级进度的判断正确）。
- 生成质量：主标题「内部工具重写三次后，我们终于不再瞎做产品」/ 3 个标题 / 正文 327 字 / 5 个标签 / 含 emoji / 无标记残留。
- 历史：倒序列表、列表不带原文、详情带原文、删除 200 且列表消失。
- 重新生成：新 id（bfdcc6a6 → 8df2f99b），旧记录保留，两版正文不同（variation 生效）。
- 长文：7280 字自动压缩为 477 字要点后正常生成。
- 错误：404 链接 →「链接返回 404（页面不存在）…」+ 引导切粘贴模式；空输入 400；无令牌 401。

**单测/集成层发现的真实缺陷（已修）**：
1. `streamLLM` 收到 `[DONE]` 后提前 return，跳过了「无内容则报错」检查 → 模型只回空 delta（实测 glm 类）时会「成功但空结果」。已改为收到 DONE 后仍校验产出。
2. `store.remove` 原先「先删再查」→ 永远返回 true（把「本来不存在」误报为删除成功）。已改为先查再删。
3. 测试自身缺陷：断言了 SSE status 却没消费响应体 → void/sse 的 keepAlive interval 悬着，测试进程挂住（已修复，并在 generate.ts 加 `finally { stream.close() }` 防御）。

### M0（第 4 步前置，2026-10-26）—— 全部通过

| 验证点 | 证据 | 结论 |
|---|---|---|
| `void/sse` 真流式（非缓冲） | `e2e/m0-probe.mjs` mode=sse：`step@116 → step@137 → token@167 → token@199 → done@235ms` | ✅ 逐段到达，间隔 20ms 可观测 |
| `streamLLM` 解析跨 chunk 切帧 | mode=mock：`step@13 → token@26 → token@42 → token@76 → token@112 → done@122ms`，拼接通过 `"你好，世界！"` | ✅ 含半行切断、keep-alive 注释、`[DONE]` 哨兵 |
| Node shim 不缓冲响应体 | 自建 `e2e/server.mjs` 按 chunk 泵送（产品① shim 用 `arrayBuffer()` 会假绿，已知差异） | ✅ |
| **magpie 上游支持 `stream:true`**（方案最大未实测假设） | `e2e/m0-upstream-stream.mjs` 本地网关 127.0.0.1:3425：`content-type=text/event-stream`，83 帧/13 增量帧，首 token 22.9s / 总 28.6s | ✅ 真增量，**M0-real PASS** |

**M0 副产物（影响后续决策的事实）**：
1. 模型延迟差异极大：`auto/minimax-m3.1-flash` 首 token 1.8s / 总 2.2s；`auto/deepseek-v4.1-flash` 首 token 22.9s / 总 28.6s；`auto/glm-5.3-flash` 90s 内无 delta。
   → 验证了**步骤级进度不是锦上添花而是必需**（首 token 等待期需要可见反馈）；本地 E2E 默认用快模型。
2. 部分模型 delta 可能无 `content` 字段（只回空帧/推理字段）→ `streamLLM` 必须保留「无内容则报错」兜底，不能静默成功。
3. `product1/.env` 的 `MAGPIE_BASE_URL` 是 cloudflared 临时隧道（当前未开），可用本地网关 `http://127.0.0.1:3425/v1` 验证；**E2E 时需用户确认用哪个**。
