# HANDOFF · kb-ask（产品③ 企业知识库问答）

> **面向**：接手这个功能的下一个开发会话（冷启动入口）。回答「从哪接着干」，不重复讲实现细节。
> **当前 revision**：工作区未提交（2026-10-28）。`git status` 中 `product3/` 全部为新增/未跟踪。
> **需求与验收**：[`product3/CONTEXT.md`](../CONTEXT.md)（§5 验收标准、§8 交叉审查处置、§9 验收证据）
> **交付文档**：[`product3/docs/features/kb-ask/kb-ask-交付文档.md`](./features/kb-ask/kb-ask-交付文档.md)

---

## 1. 一句话现状

本地全链路已跑通并全绿（单测 93、接口 E2E 32、浏览器冒烟 18、评测四项达标），**尚未线上部署**——缺 D1 库与 Vectorize 索引两个云端资源（需用户凭据）。

## 2. 关键文件地图

| 路径 | 职责 | 改它会影响 |
|---|---|---|
| `lib/ingest.ts` | 导入管道：切分→容量→嵌入→写库→回读校验→替换收尾 | 幂等、替换语义、失败补偿（**改动前先读文件头的「顺序铁律」**） |
| `lib/chunk.ts` | 结构化切分（headingPath） | 检索质量、引用位置可读性 |
| `lib/embed.ts` | Workers AI `bge-m3`，分批（8/批）+ 配额错误识别 | 嵌入预算、失败文案 |
| `lib/retrieve.ts` | 向量 top-k + 阈值分流 + **只认 status=ready 的文档** | 拒答率、是否能引用到失败文档 |
| `lib/answer.ts` | grounded prompt（注入防护 + 依据不足标记）、引用编号解析 | 防幻觉、引用准确性 |
| `lib/repo.ts` | `Repo` + `VectorIndex` 双接口，D1 / Vectorize / 内存三种后端 | 线上与本地一致性 |
| `lib/fetch-article.ts` | URL 抓取 + SSRF 三道闸（含尾点规范化） | 安全边界 |
| `lib/pdf.ts` | 浏览器端 PDF 抽文本 | PDF 导入体验 |
| `routes/api/{documents,ask,history,health}.ts` | 四类接口 | 契约与错误码 |
| `pages/index.tsx` | 双栏工作台 UI（含 `data-testid`） | 冒烟脚本依赖这些 testid |
| `e2e/{server,ai-shim,vec-shim,d1-shim,fake-llm}.mjs` | 本地替身：Node shim + 假 AI + 内存向量 + 假 LLM | 本地验证能力 |
| `e2e/flow-check.mjs` / `e2e/smoke-ui.mjs` | 接口级 E2E / 浏览器冒烟 | 回归门禁 |
| `eval/{run.ts,cases.json,corpus/}` | 评测集与指标脚本 | 阈值标定依据 |
| `db/migrations/0001,0002` | 表结构 + `content_hash` 唯一索引 | 部署时必须先应用 |

## 3. 复现验证命令

```bash
cd product3

# 静态与单测
npm run typecheck          # 期望 exit 0
npm test                   # 期望 通过 93 · 失败 0
npm run build              # 期望成功，且 dist/ssr/wrangler.json 含 ai 与 vectorize

# 本地接口 E2E（两个终端）
node e2e/fake-llm.mjs 3506                                    # 假上游模型
MAGPIE_BASE_URL=http://127.0.0.1:3506/v1 MAGPIE_API_KEY=fake \
  RETRIEVE_MIN_SCORE=0.05 node --import ./e2e/bootstrap.mjs e2e/server.mjs 8913
node e2e/flow-check.mjs http://127.0.0.1:8913                  # 期望 通过 32 · 失败 0

# 评测（同一 shim 实例即可）
BASE_URL=http://127.0.0.1:8913 npm run eval                    # 四项指标达标

# 浏览器冒烟（需 ego-browser；注意脚本里的 BASE 端口要与 shim 一致）
ego-browser nodejs < e2e/smoke-ui.mjs
```

> 沙箱注意：`vite dev` 不可用（workerd 不能 spawn），本地一律走 `e2e/server.mjs`；
> `npm install` 需 `--ignore-scripts`。截图偶发 CDP 超时属环境问题，不影响断言。

## 4. 未解决问题（按优先级）

1. **线上部署未做**：`wrangler d1 create kb-ask-db` + `wrangler vectorize create kb-ask --dimensions 1024 --metric cosine` + 回填 `void.config.ts` 的 database_id/（index 名已写死为 `kb-ask`）。之后 `npm run deploy -- --secrets .secrets.json`，**逐项核验四个绑定**（ASSETS/DB/AI/VEC）。
2. **阈值未标定**：`RETRIEVE_MIN_SCORE` 基线 0.35 来自假嵌入，必须用线上真 `bge-m3` 跑 `npm run eval` 扫曲线后写死（CONTEXT D16）。
3. **PDF 未用真实文件验证**：只覆盖了代码路径与错误分支；扫描件分支未经真实文件验证。
4. **问答历史无 UI**：`GET /api/history` 已可用，`pages/index.tsx` 未展示。
5. **令牌默认放行（fail-open）**：未配 `ACCESS_TOKEN` 时接口对公网完全开放。本产品会暴露文档全文列表与删除操作，**上线前必须配**；若要做成默认安全，需要改 `lib/auth.ts` 的默认语义（会影响产品①② 的既有口径，属跨产品决策）。
6. **`eval` 会污染知识库**：评测脚本会把 4 篇示例文档写入目标库，跑完需手工删除或改用独立实例。

## 5. 猜测 vs 已验证（明确分开）

**已验证（有证据）**：
- Void 1.2.1 会把 `cloudflare.ai` 与 `cloudflare.vectorize` 透传进 `dist/ssr/wrangler.json`（M0 实测）。
- 本地全链路：导入→幂等→替换→检索→引用→拒答→删除全部打通（flow-check 32/32）。
- 失败补偿：嵌入失败 / 回读校验失败都不会留下「可被检索的失败文档」（单测覆盖）。
- SSRF 尾点绕过已修（`169.254.169.254.` 被拒，单测覆盖）。

**未验证（属于推测，动它前先证伪）**：
- **线上 Vectorize 的写入可见性延迟**：本地内存实现立即一致；线上可能有秒级延迟，回读校验若在延迟窗口内会误判失败。若线上出现「导入失败但实际成功」，优先怀疑这里 → 处置方向：给回读加短重试（3 次 × 300ms）。
- **线上 `bge-m3` 的相似度尺度**：本地词袋余弦约 0.05~0.2，真模型通常更高；阈值必须重标，不能沿用本地数字。
- **`node:sqlite` shim 与 D1 的行为差异**：`INSERT OR IGNORE` 语义、`RETURNING` 支持未在真 D1 上验过。
- **浏览器内 pdf.js 的 bundle 体积与首屏影响**：已做动态 import 代码分割（430KB 独立 chunk），但真实弱网下的加载体验未测。

## 6. 下一步建议

1. 部署 + 四绑定核验（半小时）。
2. 用真模型跑 `npm run eval`，标定阈值并写回 `CONTEXT.md` 决策记录（1 小时）。
3. 若要做二期，优先顺序：多轮对话 → 历史 UI → 混合检索（关键词兜底）→ rerank（评测驱动）→ 扫描件 OCR。
