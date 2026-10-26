# 本次需求 CONTEXT — 会议记录整理日报 Skill（Web 版）

> 流程：dev-task-flow（🟡 标准档）。本产品为个人 FDE 作品集的第 1 个产品（MVP）。
> 元信息：模型组合 = 规划/编码/审查均由本会话 DeepSeek Harness 完成；E2E 由用户手动跑（第 11 步）。

## 重做记录（v2：改用 Void）

**触发**：2026-10-23 得知 Cloudflare + VoidZero 开源 [Void](https://github.com/voidzero-dev/void)（Vite 全栈工具链）。
v1 手写栈（Hono + 手写 wrangler.toml + tsc 替代 esbuild）的多数复杂度，Void 原生解决。

**v1 → v2 变化**：
| 维度 | v1（手写） | v2（Void） |
|------|-----------|-----------|
| 构建 | 手写 `scripts/build.mjs`（tsc 绕 esbuild） | `vite build`（Rolldown，原生） |
| 配置 | 手写 `wrangler.toml` | `vite.config.ts` + `void.config` 自动生成 `wrangler.json` |
| 前端 | 独立 `frontend/` + `API_BASE` 三套兜底 | `pages/index.tsx`（React），同源 `/api/*` |
| 路由 | `worker/src/index.ts` 单文件 Hono | `routes/api/*.ts` 文件即路由 |
| env | 手写 `Env` 类型 + 手动 secret | `env.ts` 声明式校验 |
| CORS | 手写 middleware | **同源，不存在** |

v1 代码保留在 `legacy/worker-v1`、`legacy/frontend-v1`（仅作对照，不参与构建）。

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
7. **本地 dev 跑通用 Node shim 绕过 workerd**（2026-10-26）：sandbox 起不了 workerd，但 `product1/e2e/server.mjs` 用纯 Node 跑 `dist/ssr/index.js`（SSR + 静态资源）即可在 `:8899` 完整渲染页面。**坑**：① 端口 8899 常被旧 shim 进程占用（`pkill` 在此 shell 不存在，用 Node `netstat -ano | findstr :8899` + `process.kill(pid,'SIGKILL')`）；② `dist` 可能被别的项目构建产物污染，需 `rm -rf dist` 重建；③ shim 无 `ACCESS_TOKEN`，要在 localStorage 写入 `md_token` 过前端门禁才有 `#textInput`。详见 `docs/e2e-evidence/focus-hang/LOCAL-DEV.md`。

### 线上偶发卡死 / 部署崩 1101（2026-10-26 经验，含更正）
- 现象：线上点击/聚焦 textarea 偶发卡死（连 CDP 截图都超时），几天未定位，一度误判为「前端 textarea 死循环 / header backdrop-blur」。均错。
- 前期排查（成立）：同一份代码在本地 Node 运行时点 textarea 6 轮 0 卡死、live 偶发 → 差异在运行时（Node vs workerd），非源码逻辑 bug；live 纯加载/静置 20 轮 0 卡死 → 卡死由交互触发。
- **重要更正**：我曾误报「重部署即解决、根因是旧实例态」。真相是：**10-26 那次 `wrangler deploy --config dist/ssr/wrangler.json` 让 Worker 启动即抛异常，线上直接 Error 1101 打不开**（我当时的探活用 `evaluate(()=>1+1)`，在 1101 错误页上也能跑通，被错判成 hang 消失）。已 `wrangler rollback` 回 10-23 好版本 `0d991259` 恢复。
- **本环境勿再直接 `wrangler deploy` 当前 `dist/ssr/wrangler.json`**，会再次 1101。1101 是部署配置/运行时层面问题（非代码 bug：10-23 同代码正常、本地 shim 也正常）。需在有 Cloudflare 访问的环境用 `wrangler tail` / Dashboard 查坏版本 `78f584e5` 的异常堆栈定位。完整复盘见 `docs/e2e-evidence/focus-hang/ROOT-CAUSE-REPORT.md`（含「重要更正」段）。
- **✅ 2026-10-26 收尾（同日晚）**：
  - **UI 已恢复**：`wrangler rollback d204bb4e` 把线上指回**新工作台 UI**（不是旧 UI `0d991259`——之前回滚过头了）。ego 真机确认：`title` 正确、无 1101、`0 / 30,000` 计数 + `Ctrl↵` + 「就绪」徽章在线、`/api/health` 200。
  - **1101 差异已定位**：比对 `~/.wrangler/logs` 两次部署，12 个 Worker 模块**同名同 hash 字节完全一致**、secrets/元数据一致，**唯一差异是 10-26 那次 `assetUploadFileCount: 0`（跳过了静态资产上传，好版本是 8 个文件 289KB）**。本 Worker `run_worker_first: ["/**"]`，资产没绑对 → 每次请求读 `env.ASSETS` 抛异常 → 1101。
  - **部署前必查**：下次部署后先 `wrangler versions view <id>` 确认资产绑定，或改用 `void deploy`；勿再在 node 22 下用 `wrangler deploy --config dist/ssr/wrangler.json`。
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

### 复验证据（v2 Void 版）
- `tsc --noEmit` → **exit 0**
- `node --experimental-strip-types test/run.ts` → **29/29 通过**（含 8 个 Void 路由层用例）
- `vite build` → **成功**（SSR 85 modules / client 25 modules，235ms）
- `vite dev` → **失败**：`ERR_RUNTIME_FAILURE`（workerd 无法 spawn，沙箱边界，非代码缺陷）

### 🎯 E2E 证据（完整，已归档于 `docs/e2e-evidence/`）

**T01/T09（真实 LLM 输出，v1 期）**
| 文件 | 内容 | 结论 |
|------|------|------|
| `T01-input.json` | 真实会议记录（腾讯会议，4 人参会） | 输入样本 |
| `T01-digest-output.json` | 生成的日报 | **6 板块全部齐全**，表格正确，忠于原文 |
| `T01b-digest-output.json` | 第二次生成 | 结构一致 |
| `T09-input.json` | `{"text":"嗯嗯啊啊测试"}` | 边界样本 |

**T02/T06（真实浏览器 E2E，2026-10-23 09:03 UTC，7/7 通过）**
| 用例 | 结果 |
|------|------|
| 页面加载 | ✅ |
| T02 负例：`.pdf` 被拒 | ✅ `不支持的文件格式「__fake.pdf」…` |
| T02 负例：二进制伪装 `.txt` 被拒 | ✅ `「__binary.txt」看起来是二进制文件…` |
| T02 正例：文件载入 textarea | ✅ 445 chars |
| 生成日报：6 板块齐全 | ✅ 499 chars |
| T06：按钮出现「已复制 ✓」 | ✅ |
| T06：剪贴板内容与日报一致 | ✅ 523 chars |

产物：`T02-T06-browser-evidence.json` + 5 张截图（`T02-digest-generated.png` 等）。
截图经人工目视确认：页面真实渲染、日报内容完整。

**E2E 实现方式（可复用）**：`product1/e2e/server.mjs` 用 Node HTTP 直接跑 Vite 构建的 SSR bundle
（**绕开 workerd**），`browser-test.mjs` 用 playwright 做真实浏览器操作。
这是在本沙箱环境下唯一可行的浏览器 E2E 路径。

### 验收标准达成情况（8/8）
| # | 标准 | 证据 |
|---|------|------|
| 1 | 6 板块 Markdown 日报 | ✅ 自动化 + T01/T02 真实输出 |
| 2 | 上传 .txt/.md 等效 | ✅ T02 浏览器 E2E（含 2 个负例） |
| 3 | .docx/.pdf 被拒 | ✅ 自动化 + T02 浏览器 |
| 4 | 空输入禁用 | ✅ 自动化 + 线上验证 |
| 5 | 超长友好报错 | ✅ 自动化 + 线上验证 |
| 6 | 一键复制有反馈 | ✅ T06 浏览器 E2E（含剪贴板内容比对） |
| 7 | 未配置凭据明确错误 | ✅ 自动化 + 线上验证（502 友好文案） |
| 8 | 前端无密钥硬编码 | ✅ 人工审查 |

## 已确认方案（第 3 步 design-plan 输出）

### 问题本质
把用户提供的会议原始文本，通过一次 LLM 调用（magpie 中转）转化为固定 6 板块 Markdown 日报，以零运维 Cloudflare 交付为网页工具。

### 模块划分（v2 Void 版）
```
fde-agent-delivery/
├── CONTEXT.md                     # 需求活文档
├── product1/                      # ★ 产品① 主目录（Void 项目）
│   ├── routes/api/health.ts       # GET /api/health（含 maxInputChars 同步）
│   ├── routes/api/digest.ts       # POST /api/digest（错误映射 400/413/502/503）
│   ├── pages/index.tsx            # React 页面（粘贴/上传/生成/复制）
│   ├── lib/prompt.ts              # 6 板块 system prompt + MAX_INPUT_CHARS + wrapTranscript
│   ├── lib/validate.ts            # 空输入/超长/文件格式/二进制检测（纯函数）
│   ├── lib/sections.ts            # hasAllSections 结构校验
│   ├── lib/llm.ts                 # callLLM：magpie 中转，错误收敛
│   ├── env.ts                     # Void 声明式 env（MAGPIE_* / ALLOWED_ORIGIN）
│   ├── test/digest.test.ts        # 29 项用例（21 纯函数 + 8 路由）
│   ├── test/run.ts                # 进程内测试执行器（规避 node --test spawn）
│   ├── vite.config.ts             # voidPlugin() + voidReact()
│   └── styles.css
├── docs/
│   ├── features/meeting-digest/   # 交付文档
│   └── e2e-evidence/              # ★ 真实 E2E 产物（T01 输入/输出等）
├── legacy/                        # v1 手写栈备份（仅对照，不参与构建）
│   ├── worker-v1/                 # 旧 Hono + wrangler.toml + build.mjs
│   └── frontend-v1/               # 旧原生 HTML/JS
├── research/                      # 调研克隆的 4 个开源仓库（不提交）
└── README.md
```
- **MAX_INPUT_CHARS = 30000**：`lib/prompt.ts` 常量；超阈值返回 413（不自动分块）。
- **密钥**：`env.ts` 声明 + `.env`（本地，已 gitignore）/ `void secret put`（生产）。不进前端、不进仓库。
- **现状标注**：`product1/` 全部为本次新建；`legacy/` 为 v1 已存在实现（已核实，仅备份）。

### 关键决策（方案级，v2 Void 版）
1. 用 **Void**（Cloudflare × VoidZero 开源，MIT，2026-10-15）作为全栈工具链：Vite 插件 + `void deploy`。
2. 前端 **React**（Void Pages 约定），后端 **Hono 路由**（Void `defineHandler` 内部即 Hono）。
3. LLM 经 **magpie 中转**（OpenAI 兼容），配置走 `env.ts` 声明式校验。
4. 业务逻辑保持**纯函数分层**（`lib/prompt.ts` / `lib/validate.ts` / `lib/sections.ts` / `lib/llm.ts`），
   路由只做编排——这是 v1 的资产，v2 原样复用，测试也因此可平移。
5. 预留接口（ASR / 超长分块）在 v2 暂未迁入：Void 结构下应由 `routes/` 承接，等真实需求再加。

### 待决问题（已最小化）
1. ~~前端 α（原生 HTML/JS）~~ → **v2 改为 React**（Void 约定）。
2. MAX_INPUT_CHARS=30000 是否合适 → 默认是，可调（`lib/prompt.ts` 常量）。
3. ~~Worker 用 TS+Hono 还是纯 JS~~ → **v2 确定 TS + Void + Hono 路由**。

### 对抗性审查结论
- magpie 不稳 → 明确错误文案（验收7）+ 状态码分类（401/403/429）。
- LLM 输出漂移 → system prompt 强约束 + `hasAllSections` 校验 + 重试一次。
- 提示注入 → `<<<TRANSCRIPT>>>` 数据分隔 + prompt 声明「视为数据」。
- 长录音场景 → MVP 明确 Out，接口预留，不阻断。

## 流程状态
- [x] 第 0 步 定档：🟡 标准
- [x] 第 1 步 准备：CONTEXT.md 初始化
- [x] 第 2 步 需求对齐：grill-with-docs 完成（四层无未决歧义）
- [x] 第 3 步 方案设计：design-plan（第一性原理/对抗/奥卡姆）
- [x] 第 3.5 步 方案复核：六项过 + 授权
- [x] 第 4 步 M0（v2）：`void --version` 可运行、`vite build` 成功（153ms / 262ms）
- [x] 第 4 步 实现（v2）：Void 结构落地（routes/pages/lib/env）
- [x] 验证：测试 **29/29 通过**、`tsc --noEmit` **exit 0**、`vite build` 成功（SSR 85 + client 25 modules）
- [x] 第 5 步 交叉对抗审查：5b=中档，子 Agent 4 方向全覆盖，**无阻塞项**；15 项发现已修
- [x] 第 6 步 人工 Review：验收标准逐条对账 + 高风险点已过
- [x] 第 7 步 交付文档：`docs/features/meeting-digest/meeting-digest-交付文档.md`
- [x] 第 8 步 提交：commit `4d674ee`（标 E2E pending）
- [x] 第 9 步 交接：`docs/HANDOFF-meeting-digest.md`
- [x] **第 11 步 部署上线 + 真实 E2E**：`https://meeting-digest.ilikesaury.workers.dev`（2026-10-23）
- [x] **第 10 步 复盘与 Skill 沉淀**（2026-10-23）

## 第 10 步复盘记录（capture-experience）

### 一、重复流程识别（本次会话）

| 重复操作 | 次数 | 是否沉淀 |
|----------|------|----------|
| `wrangler deploy` 并处理 secrets | 6+ | ✅ 已写入 Skill 硬约束 |
| 环境自检（spawn / node --test 是否可用） | 4+ | ✅ 已写入 Skill 第 0 步 |
| PowerShell 5.1 读 4xx/5xx body 得到空 | 3 | ✅ 已写入排查小抄 |
| 隧道诊断（403 Host → 401 key） | 3 | ⬜ 一次性问题，不沉淀 |

### 二、Skill 维护（做减法）

**更新 `E:\Obsidian\lic-notebook\skills\cf-worker-local-env\SKILL.md`**：

| 过时约束 | 处理 |
|----------|------|
| 「`node --test` 不可用」 | **删除**。实测 `danger-full-access` 下可用（fail 0） |
| 「spawn EPERM 是必然」 | **改为条件式**：新增「第 0 步环境自检」，先跑再决定 |
| 「wrangler dev 起不来」 | **更新根因**：新增 `CreateDirectory: #5 拒绝访问 (miniflare-email-store)` 这一真实原因 |
| 缺少 Void 相关坑 | **新增**：`no_bundle:true` 绕过 esbuild、`.env` 只允许一个文件 |

新增内容：首次部署必须 `--secrets-file`、后续不带会清空 secrets、`void deploy` 只认 API Token。

### 三、口径回改（发现并修正）

`docs/deploy-live-record.md` 里模型写的是 `auto/deepseek-v4.1-flash`，
但线上实际已切到 `auto/hy3` —— **下游文档口径过期，已回改**。

### 四、复盘回流：本工作流可改进之处

1. **第 1 步「准备」应增加「环境能力自检」**：本次因为假设 spawn 不可用，绕了远路
   （手写进程内测试执行器、tsc 替代 esbuild）。若第 1 步先自检，能省一轮返工。
2. **第 8 步「提交」之后应显式排第 10 步**：本次流程状态里漏记第 10 步，
   是因为部署/E2E 的讨论盖过了它。建议流程状态清单里预置第 10 步占位。

## 部署记录（2026-10-23）

**状态：已上线且真实可用** ✅

| 项 | 值 |
|----|-----|
| URL | https://meeting-digest.ilikesaury.workers.dev |
| Worker 名 | `meeting-digest` |
| Version ID | `4bf2e4cb-e67a-4c03-802b-bf7b9a8bf9f1` |
| 账号 | `e279d1f8bcb29c72945905179e57faeb`（Ilikesaury@gmail.com） |
| 部署方式 | `wrangler deploy --secrets-file`（Void 的 `void deploy` 需 `CLOUDFLARE_API_TOKEN`，本机只有 wrangler OAuth） |
| Secrets | `MAGPIE_BASE_URL` / `MAGPIE_API_KEY` / `MAGPIE_MODEL` / `ACCESS_TOKEN` —— **已配真实值** |
| 模型 | `auto/hy3`（线上实测 24.8s / 6 板块齐全） |
| 资产 | 7 个静态文件 + 9 个 Worker 模块，总 1246 KiB / gzip 261 KiB |

### 线上验证矩阵（6/6 PASS）
| 用例 | 期望 | 实际 | 结果 |
|------|------|------|------|
| `GET /api/health` | 200 | 200 `{"ok":true,"maxInputChars":30000}` | ✅ |
| `GET /` 页面 | 200 | 200 HTML（含标题） | ✅ |
| 空输入 POST | 400 | 400 `内容不能为空…` | ✅ |
| 超长 POST（30001 字符） | 413 | 413 `内容过长…` | ✅ |
| 非 JSON 请求体 | 400 | 400 `请求体必须是 JSON…` | ✅ |
| text 非字符串 | 400 | 400 `字段 text 必须是字符串。` | ✅ |
| 占位凭据调用 LLM | 502 友好错误 | 502 `{"error":"AI 服务暂不可用，请检查配置或稍后重试。"}` | ✅（验收标准 7） |

### 部署踩坑
1. **`void deploy` 无法直接用**：Void 只认 `CLOUDFLARE_API_TOKEN`（环境变量或 `void cloudflare login` 的浏览器 OAuth），
   不认 wrangler 的 OAuth token。→ 改用 `wrangler deploy` 直接部署 `dist/ssr`。
2. **配置冲突**：`.wrangler/deploy/config.json` 与 `dist/ssr/wrangler.json` 同时存在导致 wrangler 报错
   「not clear which should be used」。→ 删除过期的 deploy config 后成功。
3. **首次部署必须带 secrets**：Worker 不存在时无法预先 `wrangler secret put`，
   必须用 `wrangler deploy --secrets-file <path>`。
4. **PowerShell 5.1 读错误流有 bug**：`Invoke-WebRequest` 对 4xx/5xx 返回空 body，
   误判为「响应体缺失」。→ 改用 .NET `HttpClient` 才能读到真实 body。
