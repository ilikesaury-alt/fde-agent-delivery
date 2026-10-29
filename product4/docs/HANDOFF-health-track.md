# HANDOFF · health-track（产品④）

> 面向**下一个开发者会话**：现状、坑、下一步。读完应能直接接着干，不用翻聊天记录。
> 最后更新：2026-10-29

## 1. 当前状态（一句话）

**已上线并通过真环境验证**：version `b1ac8d2b-35d3-4310-9090-de2af6668474`，
线上接口级 E2E 39/39、OCR 路径 10/10、UI 走查 26/26、真网关抽取评测行级 100%（28/28）。

需求口径与全部决策在 [CONTEXT.md](../CONTEXT.md)（只增不改）。交付/原理/部署文档：
[交付文档](./features/health-track/health-track-交付文档.md) ·
[工作原理](./features/health-track/health-track-工作原理.md) ·
[部署记录](./deploy-health-track.md)

## 2. 代码地图（按修改频率）

```
product4/
├── CONTEXT.md                   需求活文档（口径唯一权威源）
├── void.config.ts               CF 配置权威源（D1 id / AI / account）
├── env.ts                       env 声明（Void 校验）
├── db/migrations/0001_*.sql     reports + metrics
├── lib/
│   ├── types.ts                 领域类型（共享形状）
│   ├── extract.ts  ★            LLM 抽取 + 校验 + 重试（核心纪律所在）
│   ├── trend.ts     ★           参考范围解析 / 状态判定 / 趋势聚合（纯函数）
│   ├── metrics-dict.ts ★        指标名归一字典（23 个高频指标）
│   ├── interpret.ts + interpret-guard.ts ★  解读三道闸 + 红线守卫
│   ├── repo.ts                  D1 实现 + 内存实现（同接口）
│   ├── service.ts               落库编排（含手工补录合并）
│   ├── ocr.ts                   扫描件 OCR（llama-3.2-vision + 5016 自愈）
│   ├── pdf.ts                   前端 PDF 抽文本 / 渲染页图
│   ├── llm.ts  http.ts  auth.ts  errors.ts
├── routes/api/{health,extract,reports,metrics,trends,interpret,ocr}.ts
├── pages/{index.tsx,index.server.ts,layout.tsx}   layout 必须返回 fragment
├── test/*.ts                    104 项单测（node --experimental-strip-types）
├── eval/                        真网关评测（抽取 + 红线）
├── scripts/{deploy.mjs,local-verify.mjs}
└── e2e/{live-e2e.mjs,live-ocr.mjs,live-ui.mjs}   经 ego-browser 跑
```

## 3. 五条不能破坏的纪律（破坏任意一条都是回退）

1. **LLM 只转录，计算全在服务端**。`toExtractedMetric` 之外任何地方都不许信任模型或
   客户端给的 `status` / `valueNum` / `ref_low` / `ref_high`。
2. **参考范围解析不出 → `status='unknown'`，绝不判异常**。不要为了「覆盖率好看」给默认值。
3. **抽取结果不自动入库**。预览 → 人勾选 → 入库这条链不能省。
4. **解读红线**：不做诊断/用药/危急值。规则守卫（`interpret-guard.ts`）是第一道，不能删；
   加新规则时**宁可误拒**。
5. **指标归一不做语义合并**。`normalizeMetricName` 只做去括号/去标记/小写；加语义相似度
   会把不同指标合成一条假趋势。

## 4. 已知坑（都踩过，别再踩）

| 坑 | 表现 | 正确做法 |
|---|---|---|
| 值里带箭头 | `2.31 ↑` → 判成「无法判断」 | `cleanValueText` 先剥 `↑↓*` |
| `<input type="date">` | 程序化赋值不触发 onChange → 保存报「请填写日期」 | 提交读 `ref.current.value`；默认今天 |
| 单序列面板 | 按钮 disabled 且无默认选中项 | 载入序列时默认选中第一个 |
| 前端回传字段名 | 只认 snake_case → 「确认入库」全部 400 | `toExtractedMetric` 同时认 camelCase |
| D1 绑定变量上限 | 一次插 300 行必炸（上限 100/条） | 按**变量数**分批（14 列 → 7 行/批） |
| 迁移台账 | `d1 execute --file` 不写台账 → 重复执行 | 只用 `migrations apply`（deploy.mjs 已内含） |
| 沙箱出网 | Node/curl 到 workers.dev 超时（**不是服务故障**） | 走 `ego-browser` 通道 |
| 截图 | `Page.captureScreenshot` 对外站也超时 | 环境限制，不提供截图证据；用 DOM 断言 |
| E2E 假绿 | 用「元素存在」判成功，被上一条提示骗过 | 用 `waitText` 等内容包含目标文案 |
| `localeCompare` | 无 locale 参数 → 跨平台排序不同（CI 挂） | 需确定性就用码点比较 |
| 正则双捕获组 | `^<NUM\|^<NUM` 走第二分支时 m[1] 是 undefined | 用 `(?:<=|<)\s*NUM` 单捕获组 |
| 测试 helper 用 `??` | `valueNum: over.valueNum ?? 1.2` 让 `null` 变成 1.2 → 定性值用例永远测不出 | 用 `=== undefined ? x : y` |

## 5. 环境约束（本沙箱）

- `vite dev` **起不来**（workerd 不能 spawn）→ 本地验证用 `npm run verify:local`（内存 Repo + 假网关）。
- Node 出不了网 → 线上验证只能走 `ego-browser nodejs < e2e/*.mjs`。
- `npm install` 必须 `--ignore-scripts`（`.npmrc` 已设本地缓存）。
- 密钥在 `product4/.secrets.json`（gitignore）。**不要**把密钥写进任何入库文件或文档。

## 6. 下一步（按价值排序）

1. **真实语料标定抽取准确率**（最大未验证面）：拿自己 3–5 份真实报告跑 `npm run eval`
   的同一套比较逻辑，把失败形态记进 CONTEXT §判断，再决定改 prompt 还是改解析。
2. **补指标字典**：目前 23 个高频指标。真实报告跑完后按「未归一但高频」的顺序补。
3. **指标手动合并入口**：同一指标的跨医院变体（如「尿素」vs「尿素氮」）目前只能分线显示。
   若实测断裂频繁，再加「合并到某个标准名」的 UI + 数据迁移。
4. **多成员档案**：表已有 `profile_id`，只需 UI 与权限。
5. **扫描件真实拍照验证**：倾斜/阴影/印章，评估是否需要预处理（灰度、二值化、去倾斜）。

## 7. 复现与验收命令

```bash
cd product4
npm run typecheck && npm test && npm run build && npm run verify:local
npm run eval
node scripts/deploy.mjs --skip-migrate
ego-browser nodejs < e2e/live-e2e.mjs
ego-browser nodejs < e2e/live-ocr.mjs
ego-browser nodejs < e2e/live-ui.mjs
```

## 8. 相关技能（真源在全局库，项目内 junction）

- `cf-worker-local-env` — D1 绑定变量上限、迁移台账、本地替代验证
- `workers-ai-model-usage` — 视觉模型入参形状、5016 许可自愈、空返回排障
- `rag-retrieval-tuning` — 阈值跨环境不可移植、评测可复现（本产品**不用**向量检索，但评测方法论同源）
- `ci-parity-triage` — 本地绿/CI 红的六类差异（接了 CI 之后会用到）