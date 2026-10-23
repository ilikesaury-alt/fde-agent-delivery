# 会议日报生成器（Meeting Digest）

> 个人 FDE 作品集 · 产品 ① — 把会议原始文本一键整理成结构化日报的网页工具。
> 技术栈：**Void**（Cloudflare × VoidZero 开源的全栈 Vite 工具链）+ React + Hono 路由 + magpie 中转。

粘贴会议录音转写稿或笔记，一键生成包含「主题 / 时间与参会人 / 核心结论 / 待办事项 / 遗留问题 / 一句话摘要」6 个板块的 Markdown 日报。

## 为什么用 Void

手写 Cloudflare 栈（Hono + wrangler.toml + 自建构建脚本）能跑，但复杂度高：构建要绕开 esbuild、env 要手写类型、前后端分离还要处理 CORS。Void 原生解决这些——一个 Vite 项目同时写 `pages/` 和 `routes/`，`void deploy` 自动开通 D1/KV/R2 等资源，同源无 CORS。

## 技术栈

| 层 | 选型 | 说明 |
|----|------|------|
| 工具链 | **Void 1.2.1**（Vite 8 + Rolldown） | Vite 插件 + CLI，MIT 开源 |
| 前端 | React 19（Void Pages） | `pages/index.tsx`，SSR + 客户端水合 |
| 后端 | Hono 路由（Void `defineHandler`） | `routes/api/*.ts`，文件即路由 |
| LLM | magpie 中转（OpenAI 兼容） | 模型可切 `deepseek-chat` / `gpt-4o-mini` |
| 测试 | Node 原生执行器（进程内） | 规避沙箱对 `node --test` 的 spawn 限制 |

## 目录结构

```
product1/
├── routes/api/health.ts       # GET /api/health（含 maxInputChars）
├── routes/api/digest.ts       # POST /api/digest
├── pages/index.tsx            # 主页面（粘贴/上传/生成/复制）
├── lib/prompt.ts              # 6 板块 prompt + MAX_INPUT_CHARS + 注入防护
├── lib/validate.ts            # 输入校验（空/超长/格式/二进制）
├── lib/sections.ts            # 6 板块结构校验
├── lib/llm.ts                 # magpie 客户端 + 错误收敛
├── env.ts                     # Void 声明式环境变量
├── test/                      # 29 项测试
├── vite.config.ts             # voidPlugin() + voidReact()
└── styles.css
```

## 快速开始

```bash
cd product1
npm install --ignore-scripts     # 见下方「环境注意事项」
npm test                         # 29 项测试
npm run typecheck                # TS 类型检查
npm run build                    # vite build
npm run dev                      # vite dev（需无沙箱限制的环境）
```

### 配置模型服务

凭据只进服务端 env，**不进前端、不进仓库**：

```bash
# 本地：创建 product1/.env（已被 gitignore）
MAGPIE_BASE_URL=https://your-magpie-endpoint/v1
MAGPIE_API_KEY=your-key
MAGPIE_MODEL=deepseek-chat

# 生产：void secret put MAGPIE_API_KEY
```

> ⚠️ **Void 只允许一个本地 env 文件**：项目里只能有 `.env`，放 `.env.example` 会导致
> `void/env supports one local file: .env` 构建失败。配置项见 `env.ts` 声明。

### 部署

```bash
cd product1
void deploy --backend cloudflare --provision   # 部署到你自己的 Cloudflare 账号
```

## 验收标准（8 项）

| # | 标准 | 验证状态 |
|---|------|----------|
| 1 | 粘贴文本生成含全部 6 板块的 Markdown 日报 | ✅ 自动化 + **真实 E2E 证据**（`docs/e2e-evidence/T01-digest-output.json`） |
| 2 | 上传 .txt/.md 与粘贴等效 | ⏳ 待 E2E |
| 3 | 上传 .docx/.pdf 被拒绝并提示 | ✅ 自动化 |
| 4 | 空输入禁用提交 | ✅ 自动化 |
| 5 | 超长阈值友好报错 | ✅ 自动化 |
| 6 | 一键复制成功有反馈 | ⏳ 待 E2E |
| 7 | 未配置凭据返回明确错误，不泄露堆栈 | ✅ 自动化 |
| 8 | 前端无密钥硬编码 | ✅ 人工审查 |

## 错误处理约定

| 场景 | HTTP | 文案 |
|------|------|------|
| 请求体非 JSON / text 非字符串 | 400 | 请求体必须是 JSON… / 字段 text 必须是字符串。 |
| 空输入 / 纯空白 | 400 | 内容不能为空，请先粘贴会议文本或上传 .txt / .md 文件。 |
| 超长（>30000） | 413 | 内容过长（上限 30000 字符，当前 N），请分段提交或精简后重试。 |
| 未配置凭据 | 503 | AI 服务暂不可用：未配置模型服务凭据，请检查配置后重试。 |
| 凭据无效（401/403） | 502 | AI 服务凭据无效，请检查配置后重试。 |
| 请求过于频繁（429） | 502 | 请求过于频繁，请稍后再试。 |
| 其他 LLM 失败 | 502 | AI 服务暂不可用，请检查配置或稍后重试。 |
| 6 板块不完整（重试后仍缺） | 502 | 日报生成不完整，请重试或调整输入内容。 |

## 环境注意事项（DSH Windows 沙箱）

- **`vite build` 可用，`vite dev` 不可用**：dev 模式下 `@cloudflare/vite-plugin` 内部用 miniflare，
  需要 spawn `workerd` 子进程，在禁止 confined spawn 的沙箱里报 `ERR_RUNTIME_FAILURE`。
- **`npm install` 必须加 `--ignore-scripts`**：esbuild/workerd 的 postinstall 要 spawn 下载原生二进制。
- `.npmrc` 已设 `cache=./.npm-cache`（默认缓存目录不可写）。
- 换到普通终端后 `npm run dev` 应可正常启动（未验证）。

## 状态

实现与测试完成（29/29 通过、typecheck 通过、build 成功）；
T01/T09 已有 v1 期真实 LLM 输出证据；T02/T06 待手动 E2E。
