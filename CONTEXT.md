# 本次需求 CONTEXT — 会议记录整理日报 Skill（Web 版）

> 流程：dev-task-flow（🟡 标准档）。本产品为个人 FDE 作品集的第 1 个产品（MVP）。
> 元信息：模型组合 = 规划/编码/审查均由本会话 DeepSeek Harness 完成；E2E 由用户手动跑（第 11 步）。

## 要解决的问题
- **核心问题**：职场人/个人开会时记笔记手忙脚乱，或会后面对冗长录音/乱文本没时间复盘提炼。
- **目标用户**：个人 / 职场人自用。
- **主场景**：开完会后，把现成的文本（粘贴或上传 .txt/.md）丢进网页，一键生成结构化「会议日报」。

## 范围（In / Out）
- **In**：
  - 网页 UI：粘贴文本 + 上传 .txt/.md 文件 + 一键复制/下载结果。
  - 后端：调用 LLM（经 magpie 中转）把原始文本整理为固定结构的会议日报。
  - 固定日报结构（6 板块，见术语表）。
  - 预留接口：语音转写（ASR）、超长文本分块摘要、历史记录。
- **Out（MVP 明确不做）**：
  - 音频/视频直接转写（ASR 仅留接口，不实现）。
  - .docx / .pdf 解析。
  - 超长文本自动分块合并（仅友好报错 + 预留接口）。
  - 账号体系、历史记录、D1/R2/Resend、登录。

## 数据规格（输入/输出）与边界、异常处理规则
- **输入**：纯文本字符串。来源二选一：① 文本框粘贴；② 上传 .txt/.md（浏览器 FileReader 读为字符串，零后端依赖）。
- **输出**：Markdown 结构化日报，固定 6 板块（见术语表）。
- **边界/异常**：
  - 空输入 → 前端禁用提交 + 提示「请先粘贴或上传文本」。
  - 上传非 .txt/.md → 前端拒绝并提示格式。
  - 文本超长（超模型上下文，约定阈值，如 > 约 30k 字符）→ 后端返回友好错误：「内容过长，请分段提交或精简后重试」，**不**自动分块（B 方案留接口）。
  - LLM 调用失败 / magpie 未配置 → 后端返回 5xx + 明确错误文案，前端提示「AI 服务暂不可用，请检查配置或稍后重试」。
  - LLM 返回非预期格式 → 后端兜底：原样返回 + 提示「未能结构化，请重试」。

## 关键决策与取舍
1. **技术栈走 Cloudflare 全家桶（Serverless 零账单）**：Pages（前端）+ Workers（后端，建议 Hono）+ 可选 D1/R2/Resend（MVP 不用）。理由：个人工具/MVP、免运维、免费额度充足。
2. **大模型经 magpie 中转（OpenAI 兼容）**：Worker 用 env 占位 `MAGPIE_BASE_URL` / `MAGPIE_API_KEY` / `MAGPIE_MODEL`，模型名后续填 `deepseek-chat` 或 `gpt-4o-mini`。**E2E 待用户在 Cloudflare Dashboard 配 env 后手动验证。**
3. **ASR 仅留接口**：Worker 内定义 `transcribe()` 抽象，MVP 抛 not-implemented。
4. **超长文本 MVP 仅报错**：约定阈值常量，超阈值即拒，预留 `summarizeChunks()` 接口。
5. **无状态优先**：不落库、不登录，最大化利用免费额度。

## 约束（技术栈 / 性能 / 安全）
- **技术栈**：前端 Cloudflare Pages（初始用单页静态 HTML+JS，后续可升级 React）；后端 Cloudflare Worker + Hono；LLM 接入走 OpenAI 兼容 SDK（如 `openai` 或 `ofetch` 直连）。
- **性能**：Workers 单次请求 CPU 有时间限制；MVP 单次 LLM 调用，超长即拒。前端无构建负担。
- **安全**：magpie Key 仅存 Worker env，不进前端、不进仓库；前端不暴露任何密钥。上传仅限文本、客户端读取。
- **浏览器/平台**：现代浏览器；部署目标 Cloudflare 全球边缘。

## 验收标准（写死）
1. 粘贴一段会议文本，点「生成日报」，返回包含全部 6 板块的 Markdown 日报。
2. 上传一个 .txt 或 .md 文件，内容与粘贴等效，生成结果一致。
3. 上传非 .txt/.md 文件，前端拒绝并提示格式。
4. 空输入时提交被禁用/提示，不会发起请求。
5. 文本超长阈值时，返回友好错误而非崩溃/无限等待。
6. 结果区有「一键复制」按钮，复制成功有反馈。
7. 未配置 magpie env 时，调用返回明确错误文案（非 500 堆栈泄露）。
8. 前端无密钥硬编码；Worker 仅从 env 读密钥。

## 术语表（Business Term → Unified Code Naming → Description）
| Business Term | Code Naming | Description |
|---------------|-------------|-------------|
| 会议日报 | `MeetingDigest` | 最终产出的结构化 Markdown 报告 |
| 核心结论 | `conclusions` | 日报板块：3–5 条关键结论 |
| 待办事项 | `actionItems` | 日报板块：事项/负责人/截止（表格） |
| 遗留问题/风险 | `openIssues` | 日报板块：未决事项与风险 |
| 一句话摘要 | `summary` | 日报板块：整体一句话总结 |
| 会议主题 | `topic` | 日报板块：会议主题 |
| 时间&参会人 | `meta` | 日报板块：时间、参会人 |
| 语音转写 | `transcribe()` | 预留 ASR 接口（MVP 未实现） |
| 分块摘要 | `summarizeChunks()` | 预留超长文本分块接口（MVP 未实现） |
| 长文本阈值 | `MAX_INPUT_CHARS` | 超此字符数即拒（如 30000） |

## 已知风险 / 踩过的坑

### 需求/产品风险
- magpie env 未配会导致 E2E 失败 → 已在验收标准 7 与 E2E 标注「待用户配置」。
- Workers 冷启动 / CPU 限制 → MVP 单次调用规避；若接入 ASR 重计算需转 Cloudflare Container。
- LLM 输出格式漂移 → 用结构化输出约束（严格 system prompt）+ 兜底原样返回并提示。

### 环境踩坑（本轮实测，2026-10-23）
1. **本机无 npm，仅 node + pnpm**：bundled node 只有 `node.exe`，需用 pnpm（`dsh-runtimes/.../pnpm/bin/pnpm.mjs`）。
2. **pnpm 的 isolated 布局导致 wrangler 依赖解析失败**：`miniflare` 等传递依赖在 `.pnpm` 里但无法从 wrangler 目录解析。改用 **npm flat 布局**（`--ignore-scripts`）后全部可解析。
3. **`spawn EPERM` 是硬边界**：DSH Windows 沙箱禁止 confined 进程用管道 stdio spawn 子进程。因此：
   - `node --test` 不可用（内部 spawn 测试文件）→ 改为进程内测试执行器 `test/run.ts`；
   - `wrangler dev` 不可用（esbuild 会 spawn 常驻 service）；
   - `miniflare` 直接起 worker 也不可用（spawn workerd）。
   - 验证结论：`workerd.exe`、`esbuild.exe` 均存在且可独立运行，依赖完整，TS 编译通过，11/11 测试通过——**仅本地运行时无法在此沙箱启动**。
4. **esbuild/workerd 的 postinstall 无法执行**（下载原生二进制需 spawn）→ 用 `npm install --ignore-scripts` + 平台包（`@cloudflare/workerd-windows-64`、`@esbuild/win32-x64`）自带二进制绕过。
5. **npm 默认缓存目录不可写**（`C:\Users\lichun\AppData\Local\npm-cache`）→ `.npmrc` 设 `cache=./.npm-cache`。
6. **tsc 的 `.ts` 扩展名 import 与 emit 冲突**：`allowImportingTsExtensions` 要求 `noEmit`。解法：源码 import 改为无扩展名，构建用独立 `tsconfig.build.json`（`noEmit:false` + `allowImportingTsExtensions:false`），`scripts/build.mjs` 输出到 `dist/`。

### 待用户在无受限环境执行
- 本地起服务：`cd worker && node scripts/dev.mjs` 或 `npx wrangler dev`
- 部署：配好 `MAGPIE_*` 后 `npx wrangler deploy`

## 验收证据
（第 5 步起补充）

| 验收标准 | 证据 | 类型 |
|----------|------|------|
| 标准 1 | `test/run.ts`：prompt 含全部 6 板块 + 防臆造约束；正常路径 trim 后返回 | 自动化 |
| 标准 3 | `test/run.ts`：.txt/.md 通过、.docx/.pdf/无扩展名/伪装后缀拒绝 | 自动化 |
| 标准 4 | `test/run.ts`：空输入与纯空白输入返回 invalid | 自动化 |
| 标准 5 | `test/run.ts`：超 30000 拒、等于 30000 过、阈值常量正确 | 自动化 |
| 标准 7 | `test/run.ts`：缺凭据抛 MissingConfigError；上游 5xx/非JSON/空content 收敛为 LLMError；Authorization 头正确；base 尾斜杠归一化 | 自动化 |
| 标准 8 | 代码审查：密钥仅经 `c.env` 读取，前端无硬编码 | 人工 |
| 标准 2/6/9 | 待 E2E（需 magpie 凭据 + 浏览器） | 人工 E2E |
| 编译 | `tsc --noEmit` exit 0；`scripts/build.mjs` 产出 dist/ 成功 | 自动化 |

## 第 5/6 步审查处置记录

### 第 6 步自查发现（均已修）
| 发现 | 处置 |
|------|------|
| `index.ts` 未知异常透传 `e.message`，有泄露内部细节风险 | **已修**：MissingConfigError→503 / LLMError→502 / 未知→通用文案 502 |
| `app.js` `data?.error` 可能是非字符串，会渲染成 `[object Object]` | **已修**：仅接受 `typeof === 'string'` 且非空 |
| `app.js` 成功路径未校验 `digest` 类型 | **已修**：要求 string 且非空，否则报「AI 返回结果异常」 |
| CORS `cors()` 未限来源，任意站点可调用 API | **已修**：运行时按 `c.env.ALLOWED_ORIGIN` 动态收紧，未配则 `*` |
| 前后端阈值两处硬编码会漂移 | **已修**：`/health` 暴露 `maxInputChars`，前端启动时拉取 |

### 第 5 步交叉对抗审查（5b=中档，子 Agent，4 方向全覆盖）结论：**无阻塞项**
#### 已修（本轮闭环）
| # | 发现 | 修法 |
|---|------|------|
| 1 | 空输入与超长都返回 413，语义错且与 Cloudflare 边缘超大 body 的 413 撞码 | `validateInput` 返回 `status`：空输入/非字符串→400，仅超长→413 |
| 2 | 未显式 `stream:false`，中转默认 SSE 时 `resp.json()` 失败被误报为服务不可用 | 请求体加 `stream:false` |
| 3 | 60s AbortController 超出 Worker 常见时长预算，平台先掐断导致前端只看到连接错误 | 降到 25s |
| 4 | 前端 fetch 无超时，挂起时按钮永久停在「生成中…」且 disabled | 加 `AbortController` + 40s 超时，`finally` 无条件恢复文案；AbortError 单独文案 |
| 5 | 未定义 `app.onError`，路由外异常返回 text/plain 500，破坏错误 JSON 契约 | 加 `app.onError` 统一返回 `{error}` JSON 500 |
| 6 | `MAX_INPUT_CHARS` env 是死配置（Dashboard 改值无效，代码用常量） | 从 `wrangler.toml [vars]` 删除；阈值改为代码常量，`/health` 仅回显用于前端同步 |
| 7 | `ALLOWED_ORIGIN` 未在 wrangler.toml 声明，加固开关形同虚设 | `[vars]` 增加 `ALLOWED_ORIGIN = ""` 占位并注明上线建议填写 |
| 8 | `MAGPIE_API_KEY = ""` 明文占位在入库文件，易诱使填真实 key 进 git | 删除该行，只留注释说明 `wrangler secret put` |
| 9 | 用户原文裸进 user content，无分隔符/无「视为数据」指令，提示注入风险 | `wrapTranscript()` 包进 `<<<TRANSCRIPT>>>` 区，system prompt 声明为数据不执行 |
| 10 | 生成后无 6 板块结构校验，模型漏板块时用户静默拿到残缺日报（与标准 1 有差距） | 新增 `src/sections.ts` 的 `hasAllSections`，缺板块重试一次，仍缺则 502 明确报错 |
| 11 | `isSupportedFile` 只验扩展名不验内容，二进制改名 .txt 会以乱码进模型 | 前端加 `looksBinary()`（NUL 字节检测）拒绝 |
| 12 | 复制功能无 `execCommand` 兜底；1600ms 定时器连续点击有竞争 | 加 execCommand 兜底 + `clearTimeout` 旧定时器 |
| 13 | `API_BASE` 兜底写死 `127.0.0.1:8787`，且 `window.__MEETING_DIGEST_API__` 无定义处；http 在 https 页面属下 mixed content | 解析顺序改为：注入变量 → 同源相对路径 → 本地兜底 |
| 14 | 401/403/429 与 5xx 用同一句文案，用户无法区分、排障困难 | 按状态码映射：401/403→凭据无效，429→请求过于频繁 |
| 15 | 测试全是纯函数级，HTTP 层（状态码/CORS/错误形状）无自动化覆盖 | 补 12 个 `app.request()` 同进程用例（不 spawn，符合沙箱约束） |

#### 判定为非阻塞、暂不处理（记录理由）
| 发现 | 理由 |
|------|------|
| CORS 默认 `origin:*` + 无鉴权无限流，任意站点可消耗 magpie 配额 | 个人工具且无凭证/Cookie；已提供 `ALLOWED_ORIGIN` 开关并在 README/交付文档标注上线建议。真正限流需引入 KV/DO 计数，超出 MVP 范围 |
| 结果区 `textContent` 不渲染 Markdown（`class="markdown"` 名不副实） | **安全取舍**：渲染必须引入带净化的渲染器，否则 XSS。MVP 刻意用纯文本，复制后由目标工具排版。已在交付文档「已知问题」说明 |
| 超长阈值仍可能让 30000 字符一次调用接近上下文上限 | MVP 由用户自行分段；`chunk.ts` 已预留分块接口 |
| 无 pre-commit 密钥扫描 | 建议后续加（如 gitleaks），本轮未引入 CI 设施 |
| `transcribe.ts` / `chunk.ts` 未被审查（受 10 文件上限） | 已由本 Agent 补读确认：仅导出预留函数，`index.ts` 未引用，无死代码误用 |

### 复验证据
- `tsc --noEmit` exit 0
- `node --experimental-strip-types test/run.ts` → **29/29 通过**（含 12 个 HTTP 层用例）
- `node scripts/build.mjs` → dist/ 产出成功

## 已确认方案（第 3 步 design-plan 输出）

### 问题本质
把用户提供的会议原始文本，通过一次 LLM 调用（magpie 中转）转化为固定 6 板块 Markdown 日报，以零运维 Cloudflare Pages+Workers 交付为网页工具。

### 模块划分（greenfield，全部待建；仅 research/ 已存在）
```
fde-agent-delivery/
├── CONTEXT.md                 # 需求活文档
├── research/                  # 已克隆参考仓库（学习用，非本产品代码；已核实存在）
├── frontend/                  # Cloudflare Pages 源（MVP：静态 index.html + app.js + style.css）
│   ├── index.html             # 文本框 / 上传(.txt,.md) / 生成按钮 / 结果区 / 复制按钮
│   ├── app.js                 # FileReader 读文本、调 /api/digest、复制反馈、格式校验
│   └── style.css
└── worker/                    # Cloudflare Worker（Hono + TypeScript）
    ├── src/index.ts           # 路由 /api/digest + 健康检查；CORS；MAX_INPUT_CHARS 入口校验
    ├── src/llm.ts             # callLLM()：magpie 中转（env 占位 MAGPIE_*），OpenAI 兼容
    ├── src/prompt.ts          # 系统提示词：固定 6 板块结构 + 输出约束
    ├── src/transcribe.ts      # transcribe()：ASR 预留接口（MVP throw not-implemented）
    ├── src/chunk.ts           # summarizeChunks()：超长分块预留接口（MVP 未用）
    ├── wrangler.toml          # Workers 配置 + env 占位声明
    └── package.json
```
- **MAX_INPUT_CHARS = 30000**：超阈值入口即拒，返回 413 友好文案（不自动分块，B 方案留 chunk.ts）。
- **密钥**：仅 Worker env（wrangler.toml `[vars]` 占位或 Dashboard 配置），不进前端、不进仓库明文。
- **现状标注**：research/ 已核实存在（4 个克隆仓库）；frontend/、worker/ 全部待建，不引用任何现有代码模块。

### 关键决策（方案级）
1. 前端初始用原生 HTML+JS（方案 α，奥卡姆剃刀，零构建）。
2. Worker 用 TypeScript + Hono（主流、类型安全、易部署）。
3. LLM 经 magpie 中转，OpenAI 兼容 SDK；模型名 env 变量（后续填 deepseek-chat / gpt-4o-mini）。
4. 三处预留接口：transcribe() / summarizeChunks() / 未来 D1 历史，均 MVP 不实现。

### 待决问题（已最小化）
1. 前端 α（原生 HTML/JS）确认 → 默认是。
2. MAX_INPUT_CHARS=30000 是否合适 → 默认是，可调。
3. Worker 用 TS+Hono（需 wrangler 构建）还是纯 JS → 默认 TS+Hono。

### 对抗性审查结论
- magpie 不稳 → 明确错误文案（验收7）+ E2E 待配标注。
- LLM 输出漂移 → system prompt 强约束 + 兜底原样返回并提示。
- 长录音场景 → MVP 明确 Out，接口预留，不阻断。

## 流程状态
- [x] 第 0 步 定档：🟡 标准
- [x] 第 1 步 准备：CONTEXT.md 初始化
- [x] 第 2 步 需求对齐：grill-with-docs 完成（四层无未决歧义）
- [x] 第 3 步 方案设计：design-plan（第一性原理/对抗/奥卡姆），greenfield 无现状基线问题
- [x] 第 3.5 步 方案复核：六项过 + 5 行模板输出 + 已获授权
- [x] 第 4 步 M0：pnpm + npm registry 连通 ✓
- [x] 第 4 步 实现：worker（Hono+TS）+ frontend（原生 HTML/JS）落地
- [~] 第 4 步 收尾：本地起服务受沙箱 spawn EPERM 限制（已定位为环境边界，非代码缺陷），交付时在无限制环境跑
- [x] 第 5 步 交叉对抗审查：5b=中档，子 Agent 4 方向全覆盖，**无阻塞项**；15 项发现已修、5 项判定非阻塞并记录理由
- [x] 第 6 步 人工 Review：验收标准逐条对账 + 业务路径 + 高风险点（安全/契约/逻辑）已过
- [x] 第 7 步 交付文档：`docs/features/meeting-digest/meeting-digest-交付文档.md`（六段齐全，测试可独立执行）
- [ ] 第 8 步 提交：git 已 init 并暂存，commit 标注 E2E pending
- [ ] 第 9 步 交接：`docs/HANDOFF-meeting-digest.md` 已写（需随 commit 更新 revision）
- [ ] 第 11 步 E2E（你手动跑）
