# HANDOFF · kb-ask（产品③ 企业知识库问答）

> **面向**：接手这个功能的下一个开发会话（冷启动入口）。回答「从哪接着干」，不重复讲实现细节。
> **当前 revision**：`0a4f08e`（工作区干净）。**二期已上线**：线上版本 `6eb0b19a`，线上接口 E2E **35/35 通过**。
> **需求与验收**：[`product3/CONTEXT.md`](../CONTEXT.md)（§10–§12 是二期口径与证据，§1–§9 是一期）
> **交付文档**：[`product3/docs/features/kb-ask/kb-ask-交付文档.md`](./features/kb-ask/kb-ask-交付文档.md)（§7 起为二期）
> **工作原理**：[`product3/docs/features/kb-ask/kb-ask-工作原理.md`](./features/kb-ask/kb-ask-工作原理.md)（§10 为二期）

---

## 1. 一句话现状

一期已上线（version `74ca217b`）。二期（多轮对话 / 会话侧栏 / 混合检索 / 扫描件 OCR / 索引延迟提示）
**已上线**（version `6eb0b19a`，线上 E2E 35/35）：

- `npm run typecheck` 0 error · `npm test` **199 通过 0 失败**
- `npm run build` 成功（产物仍含 `ai` / `vectorize` / `d1_databases`）
- `npm run verify:local` 通过：接口 E2E **63/63** + 评测达标（21 例，Recall 100% / 拒答 100% / 误拒 17.6% / 引用准确 100%，评测跑在独立 shim 上）
- 浏览器冒烟 **33/33**（`product3/docs/e2e-evidence/ui-smoke.log`）

⚠️ 已应用 `0004` 迁移（线上 `d1_migrations` 4/4）。

## 2. 关键文件地图（二期新增/改造标 ★）

| 路径 | 职责 | 改它会影响 |
|---|---|---|
| `lib/ingest.ts` ★ | 导入管道：切分→容量→嵌入→写库（**含倒排**）→回读校验→替换收尾 | 幂等、替换语义、失败补偿（**改动前先读文件头的「顺序铁律」**） |
| `lib/chunk.ts` | 结构化切分（headingPath） | 检索质量、引用位置可读性 |
| `lib/embed.ts` ★ | Workers AI `bge-m3`，分批（8/批）+ 配额错误识别；`AILike` 入参放宽以支持视觉模型 | 嵌入预算、OCR 复用同一绑定 |
| `lib/hybrid.ts` ★新增 | 分词/停用表/TF 截断（code-like 必留）/BM25/idf 覆盖率/罕见词判定/RRF | 关键词通道的全部行为；改动需重跑 eval 消融 |
| `lib/retrieve.ts` ★ | 向量 + 关键词双通道、加权 RRF、过闸分流、只认 `status=ready` | 拒答率、引用排序 |
| `lib/conversation.ts` ★新增 | 指代判定、规则拼接改写、会话标题、历史上下文块 | 多轮检索质量与「跨轮幻觉继承」防线 |
| `lib/ocr.ts` ★新增 | 视觉模型调用、返回体容错解析、配额映射、dataURL 校验 | 扫描件识别与错误文案 |
| `lib/pdf.ts` ★ | 前端 PDF 抽文本 + **页图渲染**（OCR 用） | PDF 导入体验、OCR 入口 |
| `lib/repo.ts` ★ | `Repo` 双接口 + D1 实现（新增 conversations/messages/chunk_terms + `listRecentMessages`） | 线上与本地一致性 |
| `lib/memory.ts` ★ | 内存实现（同套契约测试的另一侧） | 单测与 shim 行为 |
| `routes/api/ask.ts` ★ | SSE 问答；**多轮**：读历史 → 改写 → 检索 → 生成带历史块 → 落 messages | 会话契约、拒答、落库 |
| `routes/api/conversations.ts` ★新增 | 会话列表 / 详情 / 删除 | 侧栏 UI |
| `routes/api/ocr.ts` ★新增 | 单页 OCR（dataURL only） | 扫描件导入 |
| `routes/api/probe.ts` ★新增 | 索引可见性探针（真检索自身） | 索引延迟提示的诚实性 |
| `routes/api/history.ts` ★ | 改读 `messages`；`?includeLegacy=1` 才带一期 `qa_history` | 历史口径（CONTEXT D23） |
| `pages/index.tsx` ★ | 三区：左文档（含徽标/检测/OCR）、会话侧栏、消息流 | 冒烟脚本依赖 `data-testid` |
| `e2e/{ai-shim,server,flow-check,smoke-ui}.mjs` ★ | 本地替身与门禁（ai-shim 增加 OCR 分支；flow-check 到 §12） | 本地验证能力 |
| `e2e/serve-for-smoke.mjs` ★新增 | 常驻假上游 + shim，供 ego-browser 冒烟期间使用 | 冒烟前置 |
| `eval/{cases.json,corpus/04-故障处理.md}` ★ | 21 例（新增 q20/q21 错误码用例） | 消融证据、阈值标定 |
| `db/migrations/0004_conversations_hybrid.sql` ★新增 | 三张新表（仅 `CREATE ... IF NOT EXISTS`，幂等） | 部署必须先 apply |

## 3. 复现验证命令

```bash
cd product3

npm run typecheck          # 期望 0 error
npm test                   # 期望 通过 199 · 失败 0
npm run build              # 期望成功，dist/ssr/wrangler.json 含 ai / vectorize / d1_databases

npm run verify:local       # 一条命令：假上游 + shim → 接口 E2E(63) → 评测 → 自动清理
npm run verify:local:e2e   # 只跑接口 E2E

# 消融对比（CONTEXT §12.1 的两个数字就是这么来的）
node scripts/local-verify.mjs --eval-only                      # 混合检索开：Recall 100%
HYBRID_ENABLED=0 node scripts/local-verify.mjs --eval-only      # 混合检索关：Recall 85.7%

# 浏览器冒烟（需 ego-browser；**先起栈，且每轮重启保证内存库干净**）
node e2e/serve-for-smoke.mjs &        # 或另开终端常驻
ego-browser nodejs < e2e/smoke-ui.mjs
```

> 沙箱注意：`vite dev` 不可用（workerd 无法 spawn），本地一律走 `e2e/server.mjs`；`npm install` 需 `--ignore-scripts`。
> 冒烟前必须重启 shim（内存库会累积），否则会撞「已跳过重复导入」的假失败；截图偶发失败属 ego 环境问题（断言仍是 DOM 断言）。

## 4. 未解决问题（按优先级）

1. ~~部署 + 迁移~~ → **已完成**（2026-10-28 晚，version `6eb0b19a`，线上 E2E 35/35）：见 [deploy-kb-ask.md](./deploy-kb-ask.md) §6。剩余：交付文档 §8.2 的 M1–M5 人工用例（真扫描件 OCR 质量、线上 eval 标定、探针延迟表现）。
2. ~~阈值未用真模型标定~~ → **已完成（2026-10-28）**：线上 21 例 Recall 100% / 拒答 100% / 误拒 0% / 引用准确 100%，`RETRIEVE_MIN_SCORE=0.45` 无需调整（D16 关闭）。复跑入口：`ego-browser nodejs < e2e/live-eval.mjs`（浏览器通道版）。
3. **OCR 中文质量未验证**：本地只有假模型；真实 moondream 对中文扫描件的识别质量必须线上实测（交付文档 M2）。质量不达标时用 `OCR_MODEL` 换模型，代码不用改。
4. **会话无用户隔离**：仍是单用户令牌；`ACCESS_TOKEN` 未配置即对公网开放（一期遗留，本产品数据更敏感）。
5. **手动跑 `npm run eval` 仍会污染目标库**：它会把 4 篇示例文档写进目标库（`verify:local` 已改为给评测起独立 shim，自动流程不受影响；手工打线上时跑完要删）。
6. **误拒率 17.6%**（假嵌入尺度）：与一期同量级，但真模型下的拒答/误拒平衡未测。

## 7. 本期踩到的坑（下次省时间）

1. **`page.waitForFunction` 的谓词在页面里执行，取不到 Node 侧闭包变量**：`length < beforeConv` 里 `beforeConv` 是 `undefined`，条件恒 false —— 浏览器冒烟的「删除会话」断言因此假失败半小时。要用 `new Function` 把目标值内联进函数体。
2. **ego `page.click` 要求元素在视口内**：长页面下方的按钮会报 `element is not visible in the viewport`（不是产品缺陷）。统一改成 `evaluate(() => el.click())`，断言仍落在点击后的 DOM 上。
3. **冒烟前必须重启 shim**：内存库会累积，同内容第二次导入走「已跳过」，`导入成功` 类断言会假失败。`node e2e/serve-for-smoke.mjs` 起栈、跑完 kill。
4. **flow-check 会污染 eval 指标**：同一 shim 里先跑接口 E2E 再跑评测，指标会从 100% 掉到 92.9%；`local-verify.mjs` 现在给评测单独起一个 shim。
5. **`cargo`-式教训：参数要由评测驱动，不要拍脑袋**：本轮混合检索改了 5 轮（等权 RRF → 加权 → code-like 加权 → 罕见词入池 → 影响力闸门），每一版都用 21 例 eval + 消融对比验，才没把 q06 的 Recall 打下去。

### 4.1 部署期踩到的坑（下次别再踩）

1. **`wrangler d1 migrations apply` 要在 `dist/ssr/` 目录跑**（根目录无 wrangler 配置；`migrations_dir` 是构建产物里的 `../../db/migrations`）。
2. **迁移一律走 `migrations apply`，别用 `d1 execute --file`**：后者不进 `d1_migrations` 台账，下次 apply 会重复执行并炸（`0003` 就是这么炸的：`duplicate column name: indexed_at`）。台账补记：`insert into d1_migrations (name) values ('0003_indexed_at.sql')`。
3. **D1 单条 SQL 绑定变量上限 = 100**（本地 sqlite 32766）：多值语句必须按**变量数**切批，否则线上 `too many SQL variables` → 导入 502。已固化在 `lib/repo.ts` 的 `D1_MAX_SQL_PARAMS`。
4. **共享 LLM 隧道会突然失效**（`Unauthorized: Tunnel not found`）：症状是「生成类接口报服务不可用，其它正常」。查 `tools/tunnel.log`；换域名后要同步三处（两个 `.secrets.json` + 每个 Worker 的 secret + 重新部署）。
5. **沙箱 Node/curl 直连 workers.dev 超时**（出网被限），但 ego-browser 通道与 wrangler API 都可用 —— 线上验证走这两条。

## 5. 猜测 vs 已验证（明确分开）

**已验证（有证据，可复现）**：
- 二期线上：版本 `6eb0b19a`，`e2e/live-e2e.mjs` **35/35**（含会话自动创建、追问改写 `rewritten=true`、关键词通道召回、探针、OCR 契约、历史兼容读）；迁移台账 4/4；三产品 health 均 200
- 混合检索在 21 例评测上带来可测收益：关闭 Recall 85.7% → 开启 100%，拒答正确率/误拒率不变（CONTEXT §12.1）。
- 追问改写生效且可观测：flow-check §8 断言 `rewritten=true` 且改写后的查询含上一轮问题；单测覆盖 `CONTEXT_REWRITE=0` 关闭路径。
- 倒排与 chunk 生命周期一致：删除文档时 `chunk_terms` 一并清理（`d1-shim` 真 SQL 单测 + 路由删除断言）。
- 探针不改写已有 `indexed_at`（单测），避免污染「刚导入」提示窗口。
- OCR 接口契约：dataURL-only、页号上限、429/502/503 映射（单测 + flow-check）。
- 浏览器接线：会话侧栏、追问标注、徽标翻转、取消回正、复制反馈复原（32/32 断言）。

**未验证（属推测，动它前先证伪）**：
- **真 Vectorize 的可见性延迟在二期探针下的表现**：线上实测 `searchable=false`（刚导入尚未进索引），与预期一致；但**探测命中率与等待时长的分布**没有线上数据（只跑了少量样本）。
- **真模型对 `chunk_terms` 体积/写入耗时的影响**：每 chunk ≤24 term 的估算基于本地；线上导入总耗时是否仍在 60s 目标内未测。
- **OCR 视觉模型的真实返回形状**：`extractOcrText` 兼容了 `answer/response/description/string`，但只在假模型上验证；真模型可能返回 markdown 包裹或带引导语（`normalizeOcrText` 只做了常见前缀清理）。
- **多轮历史块对真模型的增益**：规则改写对检索的增益有断言，但「历史块是否真的改善回答质量」需要真模型 + 人工比对。
- **`node:sqlite` shim 与真 D1 的差异**：`JOIN` + `LENGTH()` + 子查询在 shim 通过，真 D1 上未跑过 `chunk_terms` 相关查询（部署后建议直接点一次「检测」验证）。

## 6. 下一步建议

1. 部署（先 apply `0004`）+ 线上核验四绑定与新接口。
2. 线上 `npm run eval`（真模型、真向量），按结果标定 `RETRIEVE_MIN_SCORE` 与关键词参数，并把数字写回 `CONTEXT.md` §12.1。
3. 线上实测 OCR（中文扫描件 1–2 页），把质量结论与是否换模型写进交付文档 §9。
4. 若继续迭代：rerank（评测驱动开关）→ 多知识库命名空间 → 会话级「只问某几篇文档」的过滤。