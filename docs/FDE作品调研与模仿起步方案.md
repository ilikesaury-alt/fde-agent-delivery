# FDE 作品调研与技术架构分析 + 模仿起步路线

> 目标背景：搭建一套**个人 FDE 工作流**，做几个线上产品。
> 目的有二：① 系统学习 FDE 开发涉及的知识点；② 面试时充实简历（有可上线的真实作品）。
> 本文基于截图里的发布作品清单（作者 / 类型 / 简介 / 体验地址 / 介绍文档域）做归类，并结合同类公开开源项目与教程，归纳出可模仿的技术架构。

---

## 1. 截图作品归类（来自发布看板）

按交付形态，约 26 条作品可归为 4 类：

| 类别 | 代表作者 / 作品 | 类型标签 | 形态 |
|------|----------------|----------|------|
| **① 垂直行业 Skill / Agent** | 老K「WantBuilt」、Albert老石「企业 AI 机会猎人」、制造业分轮对话采集、装修小白决策体检表、会议记录整理日报、专利交底书、文秘转写纪要、财务数字员工、销售新人沉浸陪练、Google Trends 解读 | Skill（蓝） | 轻量、单场景、强 Prompt+工具 |
| **② 带 UI 的工具网站** | 自媒体帖子转化、AI 短剧分镜工作台（storyboard-studio）、视频号内容生产工作台、人物多来源搜图工具、电商经营管理、亚马逊广告数据诊断（boss.ai-zy.cc / mspai.cn） | 网站（橙） | 前端页面 + 后端 API + 部署 |
| **③ 行业情报 / 知识问答平台** | 汽车座舱创新情报站、企业知识治理问答平台、云端 AI Agent、长期随访体检指标追踪 | 网站（橙） | RAG / 多源抓取 + 检索问答 |
| **④ 多 Agent / Runtime 协同** | 多 Agent Runtime 协同、WantBuilt（面向 FDE 团队的协作） | Skill/网站 | 编排 + 状态 + 工具编排 |

**观察**：高赞/高价值作品集中在「①单场景 Skill」和「②③带数据的网站」两类——前者交付快、最能体现 FDE 访谈→需求→交付闭环；后者有 UI/有数据，简历分量最重。

---

## 2. FDE 线上产品的 4 种典型技术架构

### A. 轻量 Skill / Agent（无自建后端）
- **栈**：Coze / Dify / 飞书智能体 / 扣子；Prompt + 插件/工具 + 知识库
- **覆盖知识点**：需求拆解、Prompt 工程、工具调用、知识库配置、评测回归
- **适合**：①②类里最轻的部分；最快跑通「FDE 交付闭环」
- **简历写法**：「独立交付 X 个垂直场景 AI Agent，覆盖 Prompt 设计 / 工具编排 / 评测」

### B. 带 UI 的效率工具网站（全栈）
- **栈**：Next.js/React + TypeScript + LLM API（OpenAI/DeepSeek/通义）+ 部署 Vercel/云服务器
- **后端可选**：Next.js Route Handlers / FastAPI
- **覆盖知识点**：前端、API 设计、LLM 调用与流式输出、鉴权、部署/CI、成本控制
- **适合**：②类（帖子转化、内容生产工作台、数据诊断）
- **简历写法**：「从 0 上线 AI 工具网站，日活/调用量 X，技术栈 Next.js+TS+LLM」——**最加分**

### C. RAG 知识型 / 情报平台
- **栈**：前端（React/Vue）+ 后端（FastAPI/Next API）+ 向量库（Chroma/Qdrant/Milvus）+ LLM + 定时抓取
- **覆盖知识点**：RAG 全链路（切分/嵌入/检索/重排）、数据管道、定时任务、可观测
- **适合**：③类（情报站、知识治理问答、指标追踪）
- **简历写法**：「构建 RAG 问答平台，支持多源数据接入与检索增强，准确率/召回指标 X」

### D. 多 Agent 编排（进阶）
- **栈**：LangGraph / LangChain + 状态机 + MCP 工具 + 持久化（Redis/Postgres）
- **覆盖知识点**：Agent 编排、状态持久化、长任务、工具标准（MCP）、可观测/审计
- **适合**：④类；建议作为第 3 个产品再上
- **简历写法**：「基于 LangGraph 实现多 Agent 协作框架，支持长任务与状态持久化」

---

## 3. 推荐模仿的 2–3 个（结合你的两个目标）

### ✅ 起步产品 1（学 FDE 闭环，最快出活）：垂直场景 Skill
- **模仿对象**：截图里「会议记录整理日报」「装修小白决策体检表」「销售新人沉浸陪练」这类**单场景强交付** Skill。
- **为什么先做它**：FDE 的核心是「访谈需求→抽象场景→配置/编排→评测→交付」，Skill 形态把这条链路压缩到最小可验证单元，1–2 周就能交付第 1 个作品。
- **技术路线（二选一）**：
  - 快速验证：Coze/扣子 或 Dify 拖一个，配知识库 + 工具，导出体验链接 → 写进简历「交付 N 个 Agent」。
  - 深度版（推荐，更利于学习）：用 **Python + LangGraph** 自己写 Agent 循环（LLM 调用 + 工具函数 + 记忆），部署成 API/飞书机器人。*这能真正学到 FDE 开发的知识点，而不只是用平台。*

### ✅ 主线产品 2（简历最加分，全栈可见）：带 UI 的 AI 工具网站
- **模仿对象**：截图里「自媒体帖子转化」「视频号内容生产工作台」「亚马逊广告数据诊断」这类**有界面、有输入输出、能演示**的工具站。
- **为什么它是简历核心**：面试官能当场打开链接、看到 UI、理解价值——「上线产品」远胜「做过练习」。
- **技术路线（默认推荐 Node/TS 栈，前后端一体）**：
  - 前端：Next.js (App Router) + React + Tailwind
  - 后端：Next.js Route Handlers 或 FastAPI
  - AI：LLM API + 流式输出（SSE）
  - 部署：Vercel（免费、最快）或 云服务器 + Docker
  - 加分项：用户系统（NextAuth / Clerk）、用量统计、成本看板

### ◯ 进阶产品 3（架构深度，可选）：行业 RAG / 情报平台
- **模仿对象**：「汽车座舱创新情报站」「企业知识治理问答平台」。
- **技术路线**：前端 + FastAPI + 向量库（Chroma）+ 定时抓取 + RAG 检索增强。
- **价值**：补齐「数据管道 + RAG + 检索质量评测」知识点，让简历从「会用 LLM」升级到「能做知识系统」。

---

## 4. 技术栈选择对照（供你拍板）

| 你的背景 | 推荐栈 | 起步产品组合 |
|----------|--------|--------------|
| 偏后端/算法 | Python 为主：LangGraph + FastAPI + 前端轻量 | 产品1(深度版) → 产品3 |
| 偏全栈/前端 | Node/TS 为主：Next.js + LLM API + Vercel | 产品2 → 产品1 → 产品3 |
| 想均衡 | 编排用 Python，前端用 TS | 产品1(深度) + 产品2 |

> 个人建议：**以 Node/TS（Next.js）做产品 2 为主线**，因为它一个项目就能覆盖「前端+后端+部署+LLM」最多简历知识点；同时用 **Python + LangGraph 做产品 1 深度版**，补齐 Agent 编排与 FDE 交付深度。两个叠加，简历基本覆盖主流 JD 要求。

---

## 5. 第一阶段 4 周计划（边学边交付）

- **Week 1 — FDE 基础 + 第 1 个 Skill**
  - 学：LLM API 调用、Prompt 工程、工具/函数调用、知识库概念
  - 做：交付产品 1（深度版或 Coze 版），写介绍文档 + 体验链接
- **Week 2–3 — 全栈上线产品 2**
  - 学：Next.js 基础、API 路由、流式输出、Vercel 部署、基础鉴权
  - 做：上线一个 AI 工具网站（如「帖子/文章转化器」），配用量/成本统计
- **Week 4 — 沉淀 + 简历化**
  - 写技术文档（架构图、知识点清单、踩坑记录）
  - 把 2 个作品整理成简历项目条目 + GitHub README

---

## 6. 参考资源（公开同类开源 / 教程，非截图作品本体）

- AI Agent 速成与实战路径（覆盖 LangChain/LangGraph/MCP/RAG/面试）：https://github.com/XingJi-love/ai-agents-from-zero
- AI 短剧一站式（前后端分离 + 用户服务）参考：https://github.com/sorker/ai-shotlive
- Yihen-Drama AI 短剧生成平台：https://github.com/CszYihen/Yihen-Drama
- 飞书 + FastGPT 知识库集成：https://github.com/answerlink/feishu_fastgpt
- Vercel 上构建带 RAG 与引用的 AI 聊天应用：https://examples.vercel.com/kb/guide/building-ai-chat-app-with-rag-and-citations-on-vercel
- LangChain 部署 Next.js：https://docs.langchain.com/langsmith/deploy-nextjs
- 基于 Vite + React 的 AI 工作流生产平台参考：https://atomgit.com/gh_mirrors/ta/Tapnow-Studio-PP
- Agent Skills 多平台实战：https://cloud.tencent.com.cn/developer/article/2740872

> 说明：以上为「同类形态」的公开参考，用于模仿实现，并非截图作品的源码。截图里各作品的真实架构需以其介绍文档/体验地址为准（如你愿意把具体链接贴出来，我可逐站做更精准的逆向分析）。

---

## 7. GitHub 真仓实测（已 `git clone`，README 已逐字读，非猜测）

> 修正：本环境 `web_fetch` 对 GitHub/Wikipedia 失败，但 **`git` 可正常克隆**。4 个 P0/P1 仓库已 clone 到 `research/` 目录，下列架构均来自实际 README。

### ② 自媒体 / 内容转化 —— ✅ 已克隆实测
**hl897tech/xhs_content_agent**（小红书 AI 内容助手）——「内容生产工作台」最佳样板
- **技术栈**：FastAPI + Uvicorn + LangChain + OpenAI(gpt-4o-mini / gpt-image-1) + Playwright + FastMCP + Pydantic v2 + jieba
- **架构分层**：`app/api`(路由) → `app/services`(业务) → `app/prompts`(Prompt 模板) → `app/models`(Pydantic) → `app/core`(配置)；`mcp_server.py` 把整条流水线封装成 MCP 工具
- **完整链路 API**：爬取(search) → 分析(analyze) → 话题(topics) → 文案(content) → 配图(image) → 发布(publish) → 飞书同步(feishu)
- **亮点**：同一套逻辑既跑 Web UI 又跑 MCP Server（Claude Desktop/Cursor 可直接调用）

**BelleKou/mcp-viral-transformer**（爆款文案 MCP Server）——「帖子/链接转化」样板
- **技术栈**：FastMCP + Httpx(async) + BeautifulSoup4 + Pydantic；需 `ANTHROPIC_API_KEY`
- **核心价值**：把「给一个 URL → 输出 LinkedIn 深度稿 + X/小红书情绪爆款双版本」封装成 MCP 工具；`server.py` 单文件实现，极简
- **适合学**：MCP server 最小实现、工具标准化、Claude Desktop 集成配置

### ③ 情报 / 知识平台 —— ✅ 已克隆实测
**zenitlab/ai-hot-radar**（AI 热点雷达，已上线 aihotradar.com）——「行业情报站」全栈样板
- **技术栈**：后端 NestJS 11 + Express + Prisma + SQLite + Socket.io；前端 Next.js 15 + React 19 + Tailwind；AI 兼容 OpenAI 协议（DeepSeek/百炼/硅基流动）；数据源 RSS/Bing/HN/twitterapi.io/Bilibili
- **架构亮点**：20+ 信源每 10 分钟抓取 → 两阶段 AI 评分（便宜模型预筛→5 维评分）→ 去重 → 精选/日报/关注三视图；WebSocket 推送；封装为 Skill/RSS/REST 三种 Agent 接入；Docker + nginx 反代生产部署（文档含发版踩坑）
- **适合学**：全栈 TS、定时任务、AI 评分降成本、上线部署全流程

**seaninggit/zhiyu-enterprise-kb**（知域·企业知识中台，已上线 zhiyu-kb.xyz）——「企业知识治理问答」对标实现，**架构深度最高**
- **技术栈**：React 19 + Cloudflare Workers（边缘）+ D1(SQLite) + R2 + DeepSeek + DashScope 向量 + Tesseract.js(本地OCR) + MiniLM(本地向量)
- **架构亮点**：浏览器端做 OCR/向量化（零 API 成本）；三级 RBAC + 部门隔离 + 行级 ACL；RAG 检索→权限过滤→引用溯源；Agent 7 工具 tool-use loop + 定时治理
- **认知深度（简历金矿）**：文档用 8 节复盘了 Agent 护栏（意图前置/迭代硬截断）、上下文窗口治理（追问检测/引用过滤/滑动窗口）、Token 成本预算、幻觉治理三层防线、检索 IDF 降噪、工具调用协议细节——**可直接当作面试素材**
- **适合学**：RAG 全链路、权限模型、成本与上下文治理、PromptOps/评测门禁

### ④ 多 Agent / Runtime（未克隆，搜索结论）
- **xiejianjun000/taiji-agent（OpenTaiji）**：基于 Actor 模型的分布式多智能体引擎，支持多模型。进阶研究用。

### ① FDE 平台 / Skill（未克隆，搜索结论）
- **skills.rest/skill/wannabuild-design-phase（WannaBuild）**：把需求翻译成「架构+数据模型+API 契约」的设计蓝图 Skill，最贴近你的 FDE 工作流主线。

---

## 8. 推荐「先克隆研究 + 再模仿」的清单（按优先级，已实测标注）

| 优先级 | 仓库 | 实测状态 | 学什么 | 对应你的产品 |
|--------|------|----------|--------|--------------|
| P0 | **hl897tech/xhs_content_agent** | ✅ 已克隆读 README | FastAPI+LangChain+Playwright 全链路内容 Agent | 产品2（内容生产网站） |
| P0 | **BelleKou/mcp-viral-transformer** | ✅ 已克隆读 README | MCP server 写法、工具标准化 | 产品1（帖子转化 Skill） |
| P1 | **zenitlab/ai-hot-radar** | ✅ 已克隆读 README | React19+NestJS 情报站全栈+部署 | 产品3（情报/RAG 网站） |
| P1 | **seaninggit/zhiyu-enterprise-kb** | ✅ 已克隆读 README | 企业知识治理+RAG+成本治理 | 产品3（知识问答） |
| P2 | **xiejianjun000/taiji-agent** | 未克隆 | 分布式多 Agent 编排（Actor） | 进阶：产品4 |
| P2 | **wanghoufan/p044-ai-storyboard-studio** | 未克隆 | 单页 AI 生成工具形态 | 备选产品 |
| P2 | **wanghoufan/p044-ai-storyboard-studio** | 单页 AI 生成工具形态 | 备选产品 |

> 建议动作：先 `git clone` 前 3 个 P0 仓库，各跑一遍 README 的本地启动，把「目录结构 + 调用链 + 部署方式」拆成笔记——这本身就是 FDE 学习的一部分。

---

## 9. 主题组合与优先级（你选定的 19 个主题）

> 目标对齐：学习 FDE 全流程 + 充实地简历。原则是「先 Skill 快速验证闭环 → 再网站做简历核心 → 最后 RAG/多 Agent 做架构深度」。

### A. 垂直行业 Skill（轻量、交付快、最能体现 FDE 闭环）

| 主题 | 推荐模板 / 技术 | 难度 | 简历价值 | 备注 |
|------|----------------|------|----------|------|
| **会议记录整理日报** | 通用 LLM + 结构化输出（可参考 zhiyu 的格式约束） | ★ | 高（最常见需求、易演示） | **首选第 1 个 Skill**，1–2 周可交付 |
| **自媒体帖子转化** | `mcp-viral-transformer`（MCP Server） | ★ | 高 | 直接复用已克隆模板，学 MCP 标准化 |
| **文秘转写纪要** | 同会议记录（转录+结构化） | ★ | 中 | 与会议记录可合并为一个「会议纪要」产品 |
| **装修小白决策体检表** | 结构化问卷 + 评分 Prompt | ★ | 中 | 输入固定、输出标准，适合练结构化 |
| **制造业分轮对话采集** | LangGraph 状态机（多轮槽位填充） | ★★ | 高 | 学「有状态 Agent」的最佳入口 |
| **专利交底书** | 领域模板 + 多轮澄清（LangGraph） | ★★ | 高（专业壁垒） | 需补专利领域知识，价值高 |
| **销售新人沉浸陪练** | 多轮角色扮演 Agent（system prompt + 评分） | ★★ | 高 | 学 Agent 循环与评判，演示性强 |
| **Google Trends 解读** | 数据抓取（API/爬） + LLM 分析 | ★★ | 中 | 学数据管道 + 外部 API 接入 |
| **财务数字员工** | 需先界定边界（风险高） | ★★★ | 中 | 范围易膨胀，建议后期或缩到单一场景 |
| **多 Agent Runtime 协同** | `xiejianjun000/taiji-agent`（Actor） | ★★★ | 高（架构深度） | 进阶，放第 4 个产品 |

### B. 行业网站 / 平台（带 UI、有数据、简历最加分）

| 主题 | 推荐模板 / 技术 | 难度 | 简历价值 | 备注 |
|------|----------------|------|----------|------|
| **汽车座舱情报站** | `ai-hot-radar`（Next.js15+NestJS+Prisma） | ★★ | 高（已有同类上线） | **网站主线候选 1** |
| **视频号内容生产工作台** | `xhs_content_agent`（FastAPI+LangChain+Playwright） | ★★ | 高 | **网站主线候选 2**（Python 栈） |
| **企业知识治理问答平台** | `zhiyu-enterprise-kb`（React19+CF Workers+RAG） | ★★★ | **最高**（RAG+治理深度） | **架构深度代表作** |
| **AI 短剧分镜工作台** | `wanghoufan/p044-ai-storyboard-studio` | ★★ | 高 | 单页 AI 生成，形态清晰 |
| **长期随访体检指标追踪** | 数据看板 + RAG（参考 zhiyu 检索） | ★★ | 中 | 数据可视化 + 时序，易演示 |
| **人物多来源搜图工具** | 工具型（需图源 API） | ★★ | 中 | 依赖外部图源，需评估合规 |
| **电商经营管理** | 数据型（需数据源） | ★★★ | 中 | 缺真实数据源时难落地 |
| **亚马逊广告数据诊断** | 数据诊断（需广告 API） | ★★★ | 中 | 同上，依赖平台授权 |
| **云端 AI Agent** | 概念模糊 | — | 低 | 不建议作为起步产品 |

### 推荐「个人 FDE 作品集」组合（3 个，覆盖主流知识点 + 简历关键词）

- **组合路线（TS 主轴）**：① 会议记录整理日报（Skill） → ② 汽车座舱情报站（TS 全栈网站） → ③ 企业知识治理问答平台（RAG 深度）
- **组合路线（Python 主轴）**：① 会议记录整理日报（Skill） → ② 视频号内容生产工作台（Python 全链路网站） → ③ 企业知识治理问答平台（RAG 深度）
- 两条路线都收尾在 **企业知识治理问答平台**，因为它是简历里「RAG + 权限治理 + 成本/上下文治理」含金量最高的那块（zhiyu 的 README 复盘可直接当面试素材）。

> 难度说明：★ 约 1–2 周、★★ 约 3–5 周、★★★ 约 6 周+（单人节奏）。

---

## 10. 待你确认的两件事（决定下一步产出）

1. **技术栈**：偏 Python 还是 Node/TS？或直接让我按「Next.js 主线 + Python/LangGraph 补深度」来定。
2. **先动手哪个**：建议顺序 = 产品 1（Skill，快速验证 FDE 闭环）→ 产品 2（网站，简历核心）。是否同意？

确认后，我可以直接产出：**具体目录结构 + 模块划分 + 第一阶段要实现的接口清单 + 可运行的脚手架**。
