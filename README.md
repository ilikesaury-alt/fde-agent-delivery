# 会议日报生成器（Meeting Digest）

> 个人 FDE 作品集 · 产品 ① — 把会议原始文本一键整理成结构化日报的网页工具。

粘贴会议录音转写稿或笔记，一键生成包含「主题 / 时间与参会人 / 核心结论 / 待办事项 / 遗留问题 / 一句话摘要」6 个板块的 Markdown 日报。

## 技术栈

| 层 | 选型 | 理由 |
|----|------|------|
| 前端 | Cloudflare Pages + 原生 HTML/JS/CSS | 零构建、零依赖，MVP 极致轻量 |
| 后端 | Cloudflare Workers + Hono + TypeScript | 边缘运行、冷启动毫秒级、免费 10 万次/天 |
| LLM | magpie 中转（OpenAI 兼容协议） | 模型无关，`deepseek-chat` / `gpt-4o-mini` 可切换 |
| 测试 | Node 原生测试执行器（进程内） | 规避沙箱对 `node --test` 子进程的限制 |

## 目录结构

```
fde-agent-delivery/
├── CONTEXT.md                       # 需求活文档（对齐→方案→验收）
├── worker/                          # Cloudflare Worker（Hono + TS）
│   ├── src/index.ts                 # 路由 /api/digest、/health；入口校验
│   ├── src/prompt.ts                # 6 板块系统提示词 + MAX_INPUT_CHARS
│   ├── src/validate.ts              # 空输入 / 超长 / 文件格式校验（前后端同源）
│   ├── src/llm.ts                   # magpie 中转客户端（env 读取，错误收敛）
│   ├── src/transcribe.ts            # ASR 预留接口（MVP 未实现）
│   ├── src/chunk.ts                 # 超长分块摘要预留接口（MVP 未使用）
│   ├── test/                        # 11 项测试（对应验收标准）
│   └── wrangler.toml                # Workers 配置 + env 占位
├── frontend/                        # Cloudflare Pages 静态前端
│   ├── index.html
│   ├── app.js                       # 上传/生成/复制逻辑
│   └── style.css
├── docs/features/meeting-digest/    # 交付文档（面向测试/业务方）
└── research/                        # 调研阶段克隆的 4 个对标开源仓库
```

## 快速开始

```bash
cd worker
npm install --ignore-scripts   # 必须 flat 布局；见下方「环境注意事项」
node scripts/build.mjs         # 构建 dist/
npm test                       # 17 项测试
npm run typecheck              # TS 类型检查
node scripts/dev.mjs           # 本地起服务 http://127.0.0.1:8787
```

### 环境注意事项（Windows + 受限沙箱）
- **必须用 npm 装依赖**：`npm install --ignore-scripts`。pnpm 的 isolated 布局会让 wrangler 的传递依赖（miniflare）无法解析。
- `--ignore-scripts` 跳过 esbuild/workerd 的 postinstall（下载原生二进制需 spawn 子进程）；平台包 `@cloudflare/workerd-windows-64`、`@esbuild/win32-x64` 自带二进制，功能不受影响。
- `.npmrc` 已设 `cache=./.npm-cache`，避免默认缓存目录不可写。
- 受限沙箱内 `wrangler dev` / miniflare 均无法启动（`spawn EPERM`）；在普通终端运行 `node scripts/dev.mjs` 或 `npx wrangler dev` 即可。
- 部署不受影响：`npx wrangler deploy`。

### 配置模型服务

凭据只进 Worker 环境变量，**不进前端、不进仓库**：

```bash
cd worker
npx wrangler secret put MAGPIE_API_KEY
```

| 变量 | 说明 |
|------|------|
| `MAGPIE_BASE_URL` | magpie 中转 OpenAI 兼容端点 |
| `MAGPIE_API_KEY` | 中转密钥（secret） |
| `MAGPIE_MODEL` | 模型名，如 `deepseek-chat` |
| `MAX_INPUT_CHARS` | 长文本阈值，默认 `30000` |
| `ALLOWED_ORIGIN` | 可选，收紧 CORS 到单一来源 |

## 验收标准（8 项）

| # | 标准 | 验证 |
|---|------|------|
| 1 | 粘贴文本生成含全部 6 板块的 Markdown 日报 | 自动化(prompt) + 人工 E2E |
| 2 | 上传 .txt/.md 与粘贴等效 | 人工 E2E |
| 3 | 上传 .docx/.pdf 被拒绝并提示 | 自动化 + 人工 |
| 4 | 空输入禁用提交 | 自动化 |
| 5 | 超长阈值友好报错 | 自动化 |
| 6 | 一键复制成功有反馈 | 人工 E2E |
| 7 | 未配置凭据返回明确错误，不泄露堆栈 | 自动化 + 人工 |
| 8 | 前端无密钥硬编码 | 人工 |

## 错误处理约定

| 场景 | HTTP | 文案 |
|------|------|------|
| 请求体非 JSON / text 非字符串 | 400 | 请求体必须是 JSON，且包含 text 字段。/ 字段 text 必须是字符串。 |
| 空输入 / 纯空白 | 413 | 内容不能为空，请先粘贴会议文本或上传 .txt / .md 文件。 |
| 超长（>30000） | 413 | 内容过长（上限 30000 字符，当前 N），请分段提交或精简后重试。 |
| 未配置凭据 | 503 | AI 服务暂不可用：未配置模型服务凭据，请检查配置后重试。 |
| LLM 失败/上游异常/超时/空结果 | 502 | AI 服务暂不可用，请检查配置或稍后重试。 |

所有错误均为面向用户的文案，不返回堆栈或上游细节。

## 预留但未实现（MVP 有意为之）

- `src/transcribe.ts` — 语音转写（ASR）接口，接 Whisper/通义/飞书
- `src/chunk.ts` — 超长文本分块摘要接口
- 账号体系 / 历史记录 / D1 / R2

## 状态

实现与测试完成（11/11 通过、typecheck 通过）；**E2E 待配置 magpie 凭据后由本人手动跑**。
