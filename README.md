# FDE 作品集（fde-agent-delivery）

> 个人 FDE（Forward Deployed Engineer）作品集 — 三个已上线的个人 AI 工具产品，共享同一套已验证的技术栈与交付流程。
> 统一技术栈：**Void**（Cloudflare × VoidZero 开源的全栈 Vite 工具链）+ React SSR + Cloudflare Workers + magpie 中转。

## 产品一览

| # | 产品 | 线上地址 | 一句话 |
|---|------|----------|--------|
| ① | **会议日报生成器**（meeting-digest） | https://meeting-digest.ilikesaury.workers.dev | 粘贴会议记录 → 一键生成固定 6 板块结构化日报 |
| ② | **内容工作台**（content-studio） | https://content-studio.ilikesaury.workers.dev | 贴文章链接或粘贴素材 → 流式生成小红书图文笔记 + 历史/重新生成 |
| ③ | **知识库问答**（kb-ask） | https://kb-ask.ilikesaury.workers.dev | 导入私有文档 → 带引用的问答；依据不足明确拒答 |

**三个产品均已上线且线上验证通过**：① 8/8 验收、② T1–T16 全过、③ 线上接口 E2E **35/35** + 线上评测 **21 例**（真 bge-m3 嵌入 + 真 Vectorize 检索 + 真 magpie 生成 + 引用可核验）。证据见各自 `productN/docs/e2e-evidence/` 与 `product3/docs/deploy-kb-ask.md`。

> **线上地址 / 版本 / 资源 ID / 凭据位置**：统一登记在 [线上环境速查](./docs/线上环境速查.md)（唯一真源，其它文档不重复硬编码）。

> **首次阅读建议**：[作品集总览](./docs/作品集-总览.md) —— 交付方法论、能力↔证据对应、踩坑沉淀、已知边界（本文件只做索引）。

## 目录结构（文档按「产品自包含」约定归位）

```
├── README.md                          # 本文件：作品集索引
├── docs/                              # 仅跨产品 / 项目级文档
│   ├── FDE作品调研与模仿起步方案.md     # 调研阶段的方案文档
│   ├── 个人AI智能体交付技术框架与流程.md # dev-task-flow 交付流程
│   ├── pi-skills-setup.md             # pi Skill 配置重建说明
│   └── assets/                        # 调研期截图等
├── product1/                          # ★ 产品① 主目录（Void 项目，自包含）
│   ├── CONTEXT.md                     # 需求活文档 / 验收标准 / 证据
│   └── docs/
│       ├── features/meeting-digest/   # 交付文档 + 工作原理文档
│       ├── HANDOFF-meeting-digest.md  # 技术交接
│       ├── deploy-live-record.md      # 部署记录
│       ├── deploy-network-topology.md # 部署网络拓扑
│       └── e2e-evidence/              # 真实 E2E 产物（含 focus-hang 完整复盘）
├── product2/                          # ★ 产品② 主目录（Void 项目，自包含）
│   ├── CONTEXT.md                     # 需求活文档 / 验收标准 / 证据
│   └── docs/
│       ├── features/content-studio/   # 交付文档 + 工作原理文档
│       ├── HANDOFF-content-studio.md  # 技术交接
│       ├── deploy-content-studio.md   # 部署记录（含 D1 建库链路）
│       └── e2e-evidence/              # 线上 E2E 证据（live / smoke）
├── product3/                          # ★ 产品③ 主目录（Void 项目，自包含，RAG 知识库问答）
│   ├── CONTEXT.md                     # 需求活文档 / 验收标准 / 证据（含二期 D18–D23）
│   ├── db/migrations/                 # D1 迁移（0001–0004）
│   ├── eval/                          # 评测集（21 例 + 语料）+ 四指标口径
│   └── docs/
│       ├── features/kb-ask/           # 交付文档 + 工作原理文档
│       ├── HANDOFF-kb-ask.md          # 技术交接
│       ├── deploy-kb-ask.md           # 部署记录 + 线上排障复盘
│       └── e2e-evidence/              # 浏览器冒烟日志
├── legacy/                            # 产品① v1 手写栈备份（仅对照，不提交）
├── research/                          # 调研克隆的参考仓库（不提交）
└── tools/                             # 隧道/运维脚本（二进制不入库）
```

## 文档地图（按需取用）

| 想看什么 | 产品① | 产品② | 产品③ |
|---|---|---|---|
| 需求 / 验收标准 / 全部证据 | `product1/CONTEXT.md` | `product2/CONTEXT.md` | `product3/CONTEXT.md` |
| 交付文档（测试/业务方） | `product1/docs/features/meeting-digest/meeting-digest-交付文档.md` | `product2/docs/features/content-studio/内容工作台-交付文档.md` | `product3/docs/features/kb-ask/kb-ask-交付文档.md` |
| 工作原理（开发会话） | `product1/docs/features/meeting-digest/meeting-digest-工作原理.md` | `product2/docs/features/content-studio/内容工作台-工作原理.md` | `product3/docs/features/kb-ask/kb-ask-工作原理.md` |
| 技术交接（冷启动） | `product1/docs/HANDOFF-meeting-digest.md` | `product2/docs/HANDOFF-content-studio.md` | `product3/docs/HANDOFF-kb-ask.md` |
| 部署记录 / 运维 | `product1/docs/deploy-live-record.md` | `product2/docs/deploy-content-studio.md` | `product3/docs/deploy-kb-ask.md` |

跨产品文档：`docs/个人AI智能体交付技术框架与流程.md`（交付流程）、`docs/pi-skills-setup.md`（Skill 重建）。

## 共享技术栈与关键约定

三个产品复用同一套已验证的平台层，关键约定（详见各产品工作原理文档）：

- **layout 必须返回 fragment**：返回 `<html>/<head>/<body>` 会导致 SSR 水合错位（产品① focus-hang 教训，15–31s 主线程阻塞）
- **密钥仅存 Worker env**（Void `defineEnv` 声明）：前端零密钥、不进仓库；访问令牌保护可选
- **错误文案全部面向用户**：自定义错误直接上屏，未知异常统一兜底，不泄露堆栈/上游响应体
- **部署铁律**：`npm run deploy -- --secrets <path>`（脚本内 `wrangler deploy --secrets-file` 直连，`void deploy` 需 API Token）；部署后自动双探针 + 查 `versions view` 资产绑定（防 1101，`assetUploadFileCount > 0`）
- **沙箱约束**：`vite dev` / workerd 不可 spawn → 本地验证用 Node shim（`e2e/server.mjs` 模式）；`npm install --ignore-scripts` + 平台包自带二进制

## 工程质量与 CI

| 护栏 | 命令 / 位置 |
|---|---|
| 类型检查 + 单测 + 构建（三产品矩阵） | `.github/workflows/ci.yml` 的 `quality` job |
| 构建产物校验（SSR bundle / client 资产 / 无明文凭据） | 同上 |
| 文档引用校验（防断链） | `node .github/scripts/check-doc-links.mjs` |
| dev server 真启动探活（advisory） | CI `dev-smoke` job（本地沙箱跑不了 workerd，故移入 CI） |
| 部署后线上双探针 | `node productN/scripts/deploy.mjs` 内置 |

> 当前仓库为本地 `master`、无 remote；配置 GitHub 远程后 CI 即自动生效。

---

## 产品① 会议日报生成器（Meeting Digest）

### 线上地址
**https://meeting-digest.ilikesaury.workers.dev**（secrets 已配真实值，真实可用）

粘贴会议录音转写稿或笔记，一键生成包含「主题 / 时间与参会人 / 核心结论 / 待办事项 / 遗留问题 / 一句话摘要」6 个板块的 Markdown 日报。

### 技术栈
| 层 | 选型 | 说明 |
|----|------|------|
| 工具链 | **Void 1.2.1**（Vite 8 + Rolldown） | Vite 插件 + CLI，MIT 开源 |
| 前端 | React 19（Void Pages） | `pages/index.tsx`，SSR + 客户端水合 |
| 后端 | Hono 路由（Void `defineHandler`） | `routes/api/*.ts`，文件即路由 |
| LLM | magpie 中转（OpenAI 兼容） | 模型可切 `auto/hy3` / `auto/deepseek-v4.1-flash` |
| 测试 | Node 原生执行器（进程内） | 规避沙箱对 `node --test` 的 spawn 限制 |

### 快速开始
```bash
cd product1
npm install --ignore-scripts     # 见下方「环境注意事项」
npm test                         # 47 项测试
npm run typecheck                # TS 类型检查
npm run build                    # vite build
```

### 配置模型服务
凭据只进服务端 env，**不进前端、不进仓库**：
```bash
# 本地：创建 product1/.env（已被 gitignore）
MAGPIE_BASE_URL=https://your-magpie-endpoint/v1
MAGPIE_API_KEY=your-key
MAGPIE_MODEL=auto/hy3

# 生产：wrangler versions secret put <name> / wrangler deploy --secrets-file
```
> ⚠️ **Void 只允许一个本地 env 文件**：项目里只能有 `.env`，放 `.env.example` 会导致
> `void/env supports one local file: .env` 构建失败。

### 部署
```bash
cd product1
npm run deploy -- --secrets <path-to-secrets>
```
> `npm run deploy` = 构建 → `wrangler deploy --secrets-file` → 线上双探针（`/api/health` + 首页）。
> 首次部署必须带 `--secrets-file`（Worker 尚不存在时无法预先 `wrangler secret put`）；
> 不带会清空 secrets，资产绑定缺失会导致 1101。详见 `product1/docs/deploy-live-record.md`。

### 验收标准（8/8 达成）
| # | 标准 | 验证状态 |
|---|------|----------|
| 1 | 粘贴文本生成含全部 6 板块的 Markdown 日报 | ✅ 自动化 + 真实 E2E 证据（`product1/docs/e2e-evidence/T01-digest-output.json`） |
| 2 | 上传 .txt/.md 与粘贴等效 | ✅ 真实浏览器 E2E |
| 3 | 上传 .docx/.pdf 被拒绝并提示 | ✅ 自动化 + 浏览器 E2E |
| 4 | 空输入禁用提交 | ✅ 自动化 + 线上验证 |
| 5 | 超长阈值友好报错 | ✅ 自动化 + 线上验证 |
| 6 | 一键复制成功有反馈 | ✅ 真实浏览器 E2E（剪贴板内容比对） |
| 7 | 未配置凭据返回明确错误，不泄露堆栈 | ✅ 自动化 + 线上验证 |
| 8 | 前端无密钥硬编码 | ✅ 人工审查 |

### 环境注意事项（DSH Windows 沙箱）
- **`vite build` 可用，`vite dev` 不可用**：dev 模式下 miniflare 需要 spawn `workerd` 子进程，沙箱禁止。
- **`npm install` 必须加 `--ignore-scripts`**：esbuild/workerd 的 postinstall 要 spawn 下载原生二进制。
- `.npmrc` 已设 `cache=./.npm-cache`（默认缓存目录不可写）。

---

## 产品② 内容工作台（Content Studio）

贴一条文章链接（或粘贴文本）→ 三步流水线（抓取 → 素材准备 → 生成）→ 流式生成小红书图文笔记（主标题 + 2 备选 + 正文 + 话题标签）→ 结果落 D1 历史，可回看 / 删除 / 重新生成。

- 本地端到端 33/33、线上 E2E T1–T16 全过（证据：`product2/docs/e2e-evidence/live/README.md`）；单测 101 项
- 快速开始：`cd product2 && npm install --ignore-scripts && npm test && npm run build`
- 部署：`npm run deploy -- --secrets .secrets.json`
- 测试 / 验收指引见 `product2/docs/features/content-studio/内容工作台-交付文档.md`
- 部署记录（含 D1 建库链路）：`product2/docs/deploy-content-studio.md`

---

## 产品③ 知识库问答（kb-ask）

把私有文档变成可问、答得有据可查的知识库：粘贴 / .md·.txt / PDF（浏览器端抽文本）/ 网页链接 / **扫描件 OCR** 导入 → 自动切分与向量索引（Workers AI bge-m3 + Vectorize）→ 流式问答 + 引用溯源；依据不足时明确拒答而不编造。

**一期**（已上线）：文档导入 → 切分 → 向量检索 → 带引用回答 + 阈值拒答。

**二期**（已上线）：多轮对话（会话持久化 + 上下文改写）· 会话侧栏 · **混合检索**（向量 + BM25 关键词双通道，RRF 融合）· **扫描件 OCR**（视觉模型识别后回填可编辑文本框，人工校对再入库）· **索引延迟提示**（三级徽标 + 可检索探针）。

- 本地全绿：单测 **206**、接口 E2E **63/63**、浏览器冒烟 **33/33**、评测 21 例（Recall 100% / 拒答 100% / 误拒 17.6% / 引用准确 100%）
- 线上：**接口 E2E 35/35** + **线上评测 21 例**（真 bge-m3 + 真 Vectorize + 真 magpie）→ Recall **100%** / 拒答 **100%** / 误拒 **0%** / 引用准确 **100%**；阈值 0.45 经真环境标定**无需调整**
- 线上人工用例 **M1–M5 全部结项**：扫描件 OCR 端到端跑通（识别 152 字全中、2 处可校对误差）· 线上 eval 标定 · 索引可见性实测 **72s** · 三轮追问全部答对 · 阈值标定
- 状态：**已上线**。版本号与部署时间见 [线上环境速查](./docs/线上环境速查.md)
- 上线排障复盘：`product3/docs/deploy-kb-ask.md` §5（首次上线暴露的只在线下测不到的真实缺陷）+ §6.5–6.6（二期线上验证与库清理）
- 需求与验收：`product3/CONTEXT.md`（一期 §5–§9 / 二期 §10–§14 / 复盘沉淀 §15）
- 快速开始：`cd product3 && npm install --ignore-scripts && npm test && npm run build`
- 本地全量验证：`npm run verify:local`（一键起假上游+shim、跑 E2E 与评测、自动清理）
- 线上验证：`ego-browser nodejs < e2e/live-e2e.mjs`（35 项）/ `ego-browser nodejs < e2e/live-eval.mjs`（21 例评测）
- 部署：`npm run deploy -- --secrets .secrets.json`（部署后必查 ASSETS/DB/AI/VEC 四个绑定；**迁移必须先 apply**）
- 交付文档（测试/业务）：`product3/docs/features/kb-ask/kb-ask-交付文档.md`
- 工作原理（开发会话）：`product3/docs/features/kb-ask/kb-ask-工作原理.md`
- 技术交接：`product3/docs/HANDOFF-kb-ask.md`

---
