# 会议日报生成器 — 交付文档

> 对应 revision：`product1/` 最新 commit `a710d29`；**已上线** https://meeting-digest.ilikesaury.workers.dev（工作版本 `a62f2e7f`，2026-10-26）
> 技术栈：Void 1.2.1（Vite 8）+ React 19 SSR + Hono 路由 + magpie 中转
> 面向：测试同学与业务方。看这份即可开始测试，无需开发者口头补充。
> 关联：需求与验收标准见 [CONTEXT.md](../../../CONTEXT.md)；技术原理见 [meeting-digest-工作原理.md](meeting-digest-工作原理.md)；技术交接见 [HANDOFF](../../HANDOFF-meeting-digest.md)

---

## 1. 功能概述

「会议日报生成器」把一段会议原始文本（录音转写稿或笔记）整理成**固定 6 板块的结构化 Markdown 日报**：

1. 会议主题
2. 时间与参会人
3. 核心结论
4. 待办事项（事项 / 负责人 / 截止）
5. 遗留问题与风险
6. 一句话摘要

- **面向谁**：个人 / 职场人自用（会后复盘、纪要整理）。
- **形态**：网页工具（工作台式 UI）。粘贴文本或上传 `.txt` / `.md` → 一键生成 → 结构化展示 + 一键复制。
- **当前状态**：**已上线且 8/8 验收标准达成**（含真实浏览器 E2E 与真实 LLM 输出证据）。
- **本版本不包含**：音频/视频语音转写（ASR）、`.docx` / `.pdf` 解析、超长文本自动分段摘要、历史记录与数据持久化。

## 2. 使用说明

### 入口
- **线上（当前可用）**：https://meeting-digest.ilikesaury.workers.dev
- 本地：`e2e/server.mjs` Node shim（沙箱内 `vite dev` 不可用，见 §6）

> **同源说明**：Void 把前端与 `/api/*` 放在同一个 Worker 上，**不存在跨域问题**，无需配置 API 地址。

### 操作步骤
1. （若线上已开启访问保护）在右侧「访问令牌」面板填写令牌（向部署者索取），会记住到当前浏览器。
2. 左侧文本框粘贴会议文本；或点「上传文件」选择 `.txt` / `.md`（内容在浏览器本地读取，不上传原文件）。
3. 点「生成日报」（或 `Ctrl/⌘ + Enter`）。等待数秒，右侧结果区以结构化形式展示日报（标题、表格、列表、加粗均正常渲染）。
4. 点「复制」把日报 Markdown 原文复制到剪贴板，按钮变「已复制 ✓」。

### 字段说明
| 界面元素 | 含义 |
|----------|------|
| 字符计数 | 当前文本长度 `N / 30,000`；超限变红并禁止生成 |
| 状态徽章 | 「就绪 / 生成中 / 出错了」三态 |
| 生成日报按钮 | 无内容或超长时禁用；生成中显示「生成中…」；支持 `Ctrl↵` 快捷键 |
| 结果区 | **受限 Markdown 渲染**（表格/列表/加粗/代码，React 元素构建，无 XSS） |
| 复制 | 复制 Markdown 原文，成功时按钮变「已复制 ✓」 |
| 访问令牌 | 仅线上开启保护时显示；令牌只存当前浏览器 localStorage，不上传 |

## 3. 权限 / 配置变更

| 变量 | 说明 | 是否敏感 |
|------|------|----------|
| `MAGPIE_BASE_URL` | magpie 中转的 OpenAI 兼容端点（当前为 cloudflared 临时隧道 + `/v1`）。**隧道域名会变，换域名只改 secret 不用重新部署** | 否 |
| `MAGPIE_MODEL` | 模型名，当前 `auto/hy3` | 否 |
| `MAGPIE_API_KEY` | 中转服务密钥 | **是** |
| `ACCESS_TOKEN` | 可选访问令牌。配置后 `/api/digest` 要求 `Authorization: Bearer <token>`；**留空则不校验**。用于上游网关无认证时防白嫖 | **是** |

配置方式（生产）：
- 首次部署必须 `wrangler deploy --secrets-file <path>`（Worker 不存在时无法预先 `secret put`）
- 后续更新：`wrangler versions secret put <name>`（建新版本不部署）→ `wrangler deploy --secrets-file`

> 阈值 `MAX_INPUT_CHARS = 30000` 是**代码常量**（`lib/prompt.ts`），**不是**环境变量——改阈值需改代码并跑测试；`/api/health` 会把该值回显给前端，前后端单一事实源。

## 4. 测试指引

### 环境与前置
- Node.js 24+（Void 要求）
- **必须**先配好 `MAGPIE_*`，否则所有生成用例都会返回「AI 服务暂不可用」（这是预期行为，见 T07）
- 启动（沙箱内唯一可行路径，绕开 workerd）：
  ```bash
  cd product1
  node node_modules/vite/bin/vite.js build
  node e2e/server.mjs        # Node shim 跑 SSR bundle
  ```

### 用例清单（编号与 CONTEXT.md 验收标准对应）

| 编号 | 操作 | 预期结果 | 对应验收标准 | 证据状态 |
|------|------|----------|--------------|----------|
| T01 | 粘贴一段含明确结论/待办的会议文本 → 生成 | 返回包含全部 6 个板块的 Markdown；内容忠于原文 | 标准 1 | ✅ 真实输出 `product1/docs/e2e-evidence/T01-digest-output.json`（6 板块齐全，表格正确） |
| T02 | 上传 `meeting-sample.txt`（`product1/docs/e2e-evidence/`）→ 生成 | 结果与 T01 一致；上传后文本框显示文件内容 | 标准 2 | ✅ 真实浏览器 E2E（2026-10-23，含 2 个负例：`.pdf` 被拒、二进制伪装 `.txt` 被拒） |
| T03 | 上传 `a.docx` 或 `a.pdf` | 前端拒绝，提示「不支持的文件格式…」；不发起请求 | 标准 3 | ✅ 自动化 + 浏览器 E2E |
| T04 | 不输入任何内容，看「生成日报」按钮 | 按钮禁用；无法提交 | 标准 4 | ✅ 自动化 + 线上验证 |
| T05 | 粘贴超过 30000 字符文本 → 生成 | 返回友好错误「内容过长…请分段提交」；页面不卡死 | 标准 5 | ✅ 自动化 + 线上验证（30001 字符 → 413） |
| T06 | 生成成功后点「复制」 | 剪贴板得到 Markdown 原文；按钮变「已复制 ✓」 | 标准 6 | ✅ 真实浏览器 E2E（剪贴板内容与日报一致，523 chars） |
| T07 | 不配置 `MAGPIE_*` 直接生成 | 返回「AI 服务暂不可用：未配置模型服务凭据…」；无 500 堆栈 | 标准 7 | ✅ 自动化 + 线上验证（502/503 友好文案） |
| T08 | 检查前端打包产物 | 无任何 API Key 硬编码 | 标准 8 | ✅ 人工审查（密钥仅经 `c.env` 读取） |
| T09 | 输入几乎无信息的文本（`T09-input.json`：「嗯嗯啊啊测试」） | 仍按 6 板块输出，各板块如实说明「原文未提供相关信息」 | 边界规则 | ✅ 证据归档 |
| T10 | 未填/错填令牌调用 | 401 `{"error":"未授权：缺少或错误的访问令牌。"}`；前端令牌门禁拦截 | 标准（新增） | ✅ 自动化 + 线上核验 |

### 自动化覆盖 vs 人工
- **已自动化**（`product1/test/run.ts`，**29 项**，不 spawn 符合沙箱约束）：prompt 板块完整性、防臆造约束、空/空白输入、超长阈值、
  文件格式（含伪装后缀）、二进制检测、未配置凭据、上游 5xx/非 JSON/空 content 收敛、
  Authorization 头与 base 归一化、路由层状态码映射（401/400/413/502/503）、结构不完整重试一次、12 个路由层用例。
  运行：`cd product1 && node --experimental-strip-types test/run.ts`
- **线上验证矩阵**：`/api/health` 200、空输入 400、超长 413、非 JSON 400、text 非字符串 400、占位凭据 502 —— 6/6 PASS（CONTEXT.md 部署记录）。

### 错误行为约定（供测试参考）
| 场景 | HTTP | 返回 |
|------|------|------|
| 令牌缺失/错误（配置了 ACCESS_TOKEN 时） | 401 | `{"error":"未授权：缺少或错误的访问令牌。"}` |
| 请求体非 JSON / text 非字符串 | 400 | `{"error":"..."}` |
| 空输入 / 纯空白 | 400 | `{"error":"内容不能为空，请先粘贴会议文本或上传 .txt / .md 文件。"}` |
| 超长（>30000） | 413 | `{"error":"内容过长（上限 30000 字符，当前 N），请分段提交或精简后重试。"}` |
| 未配置 magpie 凭据 | 503 | `{"error":"AI 服务暂不可用：未配置模型服务凭据，请检查配置后重试。"}` |
| LLM 调用失败 / 上游异常 / 超时 / 空结果 | 502 | `{"error":"AI 服务暂不可用，请检查配置或稍后重试。"}` 或 `{"error":"AI 返回结果为空，请重试或调整输入内容。"}` |
| 结构不完整（重试一次后仍缺板块） | 502 | `{"error":"日报生成不完整，请重试或调整输入内容。"}` |
| 成功 | 200 | `{"digest":"## 会议主题\n..."}` |

> 所有错误均为**面向终端用户的文案**，不会返回堆栈或上游响应细节。

## 5. 已知问题与注意事项

1. **Markdown 渲染为受限渲染器**：仅支持表格/列表/加粗/代码/标题（固定 6 板块刚好够用）；React 元素构建、无 `dangerouslySetInnerHTML`，零 XSS 面渲染。**禁止改为 innerHTML 直插**。
2. **无自动重试（用户侧）**：LLM 超时 **85 秒**（实测完整生成 26–36s，25s 会误杀）后报错，需用户手动重试。结构不完整时服务端会自动重试一次。
3. **日报质量依赖模型**：`auto/hy3` 与 `auto/deepseek-v4.1-flash` 效果有差异（hy3 慢但输出更细致）；温度固定 0.3 偏保守。
4. **长文本直接拒绝而非分段**：MVP 策略，超 30000 字符即拒（产品②改成了自动压缩，按场景定）。
5. **上游依赖临时隧道**：`MAGPIE_BASE_URL` 是 cloudflared 临时隧道，本机 magpie 离线 / 隧道断开时生成功能 503；换域名只需 `wrangler versions secret put MAGPIE_BASE_URL`（详见 §3）。长期方案：换公网模型 API。
6. **同源部署无 CORS 问题**：Void 把前端与 API 放同一 Worker（`env.ts` 仍保留 `ALLOWED_ORIGIN` 以备跨域场景）。
7. **防刷未做**：无速率限制，依赖 Cloudflare 免费额度；被滥用时会消耗 magpie 配额。
8. **`vite dev` 在受限沙箱不可用**：miniflare 需 spawn `workerd`。构建与部署不受影响；本地验证用 `e2e/server.mjs` Node shim。

## 6. 部署与回滚要点

> **当前部署记录**：完整版见 CONTEXT.md「部署记录」；1101/focus-hang 复盘见 `product1/docs/e2e-evidence/focus-hang/`。

- **部署**：构建 `node node_modules/vite/bin/vite.js build` → `cd dist/ssr && npx wrangler deploy --secrets-file <path>`
  （**wrangler 直连**，本机只有 wrangler OAuth；`void deploy` 需要 `CLOUDFLARE_API_TOKEN`）
- **⚠️ 勿用** `wrangler deploy --config dist/ssr/wrangler.json` 且不验证资产：曾因此**跳过静态资产上传**（`assetUploadFileCount: 0`），本 Worker `run_worker_first: ["/**"]`，资产没绑对 → 每次请求读 `env.ASSETS` 抛异常 → **全站 Error 1101**
- **部署后必查（铁律）**：
  - `wrangler versions view <version-id>` 确认静态资产绑定正确（8 个文件约 289KB）
  - 部署日志中 `assetUploadFileCount > 0`
  - 探活**勿用** `evaluate(()=>1+1)`（1101 错误页上也能跑通，会误判为正常）；要看真实页面标题/内容与 `/api/health` 返回
- **回滚**：`wrangler deployments list` → `wrangler rollback <完整 version-id>`（必须完整 ID；确认目标是「最近已知好版本」而非「当天第一个版本」——踩过两次：一次回滚过头回到旧 UI `0d991259`，后又回正到 `d204bb4e`）
- **日志**：`wrangler tail` / Dashboard logs
- **无数据库**：不落库、无状态，无迁移与数据回滚风险
- **成本**：Cloudflare 免费额度覆盖个人使用；模型调用成本取决于 magpie 中转计费
