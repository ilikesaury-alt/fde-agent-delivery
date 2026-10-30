# HANDOFF · health-track（产品④）

> 面向**下一个开发者会话**：现状、坑、下一步。读完应能直接接着干，不用翻聊天记录。
> 最后更新：2026-10-29
>
> **Status：`ready-for-review`** —— 实现完成、证据齐、已上线；剩余的是「真实语料标定」等人做决策的事，
> 故不用 `complete`（口径见 `handoff` 技能的 status vocabulary）。

## 1. 当前状态（一句话）

**已上线并通过真环境验证**：version `ad7dbe77-2152-48ea-a8e9-64804aa438ed`，
线上接口级 E2E 39/39、OCR 路径 10/10、UI 走查 33/33、真网关抽取评测行级 100%（28/28）。

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
├── test/*.ts                    128 项单测（node --experimental-strip-types）
├── eval/                        真网关评测（抽取 + 红线）
├── scripts/{deploy.mjs,local-verify.mjs}
└── e2e/{live-e2e.mjs,live-ocr.mjs,live-ui.mjs}   经 ego-browser 跑
```

## 2.1 现状标注继承（来自 CONTEXT §7.3 `code-reality-check`）

冷读时不凭记忆假设接口：

- **已存在（改造/复制自其它产品）**：`callLLM` 调用口径（产品①）、`extractPdfText` / `renderPdfPages`（产品③）、
  OCR 5016 自愈（产品③）、`checkAccessToken` / `authorize`（产品②③）、评测器结构（产品③）。
  这些在④ 里是**独立副本**（各 Worker 独立部署，不跨产品 import）。
- **待建（④ 自建）**：`lib/extract.ts`、`lib/trend.ts`、`lib/metrics-dict.ts`、`lib/interpret*.ts`、
  `lib/repo.ts`（含 `appendMetrics`）、`lib/service.ts`、全部 `routes/api/*`、`pages/index.tsx`、
  `db/migrations/0001`、`eval/*`、`e2e/*`。
- **明确不复用**：`chunk.ts` / `embed.ts` / `retrieve.ts`（④ 无 Vectorize；复活条件见 CONTEXT「落选候选清单」）。

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
| 宽指标别名 | `血糖/glu/葡萄糖` 会吃掉餐后/OGTT/尿糖（同单位，无告警） | 别加宽别名；用 `veto` 上下文否决 |
| 严格界限 | `<6.1` 与 `≤6.1` 同待遇 → 等号处漏判 | `RefRange` 带 `lowStrict/highStrict` |
| 范围带分区/数量级 | `130-175（男）`、`0-10^9/L` 会「解析成功但结论全错」 | 命中就返回 null（宁可不判） |
| 数据字段也是注入面 | 把越界诉求写进 `valueText`/`refText` 可绕过只守 `question` 的守卫 | 所有进 prompt 字段都清洗 + `data_guard` |
| 视觉模型读中文表格 | llama-3.2-11b-vision 在真实扫描件上值错行/名字错/挂死 | 换浏览器本地 PaddleOCR（有检测框 → 确定性重建表格） |
| SDK 自带 worker | 预打包 worker 内联 28.2MB jsep 运行时 → 超 Workers 25MiB 单文件上限 | 自己开 worker + SDK inline 跑（plain 运行时 14.2MB） |
| Worker 里没 DOM | `document` / `HTMLImageElement` 未定义（opencv-js imread） | 最小 DOM shim + 构造器占位类（`instanceof` 恒 false） |
| 多线程 WASM | 单线程 70.5s/页 | `void.config` 的 `routing.headers` 下发 COOP+COEP → 12–20s/页 |
| 页脚混入指标 | 「申请时间：…」落进名称/结果列 | `isMetricRow`（名称不含冒号、不以页脚词开头） |
| 日期被过滤掉 | 页脚是日期唯一来源，过滤后趋势全堆「今天」 | `findReportDate` 单独提取 + 补一行 `检测日期：` |
| OCR 单位混淆 | `IU/m1`（l→1） | `normalizeUnitText` 只做能确定的替换 |
| e2e 注入文件 | React 未水合时 change 事件被静默丢掉（页面一片安静） | 注入后看「进度是否出现」再判定，最多重试 6 次 |
| 正则双捕获组 | `^<NUM\|^<NUM` 走第二分支时 m[1] 是 undefined | 用 `(?:<=|<)\s*NUM` 单捕获组 |
| 测试 helper 用 `??` | `valueNum: over.valueNum ?? 1.2` 让 `null` 变成 1.2 → 定性值用例永远测不出 | 用 `=== undefined ? x : y` |

## 5. 环境约束（本沙箱）

- `vite dev` **起不来**（workerd 不能 spawn）→ 本地验证用 `npm run verify:local`（内存 Repo + 假网关）。
- Node 出不了网 → 线上验证只能走 `ego-browser nodejs < e2e/*.mjs`。
- `npm install` 必须 `--ignore-scripts`（`.npmrc` 已设本地缓存）。
- 密钥在 `product4/.secrets.json`（gitignore）。**不要**把密钥写进任何入库文件或文档。

## 5.1 猜测 vs 已验证（严格分开，别把猜测当事实）

**已验证（有证据）**
- 线上可用、绑定齐全（ASSETS/DB/AI）、迁移已应用且台账无待办。
- 抽取在本轮 6 份自造报告上行级 100%；红线守卫 10/10；无数据/红线提问各路径拒答正确且不调模型。
- 确认闸不可绕过（客户端伪造 status 被服务端覆盖，有单测）。
- 趋势点排序、参考范围带、单位/范围变化告警都在真实 UI 里渲染成功（DOM 断言）。
- 手工补录用增量追加，原报告 id 不变（有测试）；同日手工报告用 `findManualReport` 直查（不经截断列表）。
- 指标别名有**上下文否决**：`葡萄糖(餐后2h)`/`尿糖 GLU` 不会被并进空腹血糖，`甲状腺球蛋白 TG` 不会被并进甘油三酯，
  `尿素` 不并入 `尿素氮`（各有单测）。
- 参考范围的分区（男/女）与数量级（`0-10^9/L`）写法一律解析失败 → `unknown`（有单测）。

**猜测（未验证，别当事实用）**
- 真实体检报告的抽取准确率 —— 只会更低，跨页表格/脚注/合并单元格没有任何证据。
- 「行级 100%」的稳定性 —— 6 次重复中 1 次 96.4%（漏一行定性指标），故**不能**当作确定性 100%。
- **真实扫描件只有 1 份**（2026-10-29）：跨页表格、合并单元格、彩色底纹、手机拍照（透视/阴影）全无证据。
- **WebGPU 未启用**：显式 `backend: "wasm"`（WebGPU 需另一份 29.5MB 运行时，托管方式未解决）。
- **模型依赖百度 CDN**：离线不可用；自托管受 Workers 静态资源单文件 25MiB 限制（可用 R2）。
- 真实手机拍照的 OCR 质量 —— 合成扫描件（正向、清晰、无阴影）不代表真实场景。
- 「营养 30 次历史足够」的截断阈值 —— 没做过对照实验。
- 23 个指标字典的覆盖度 —— 只覆盖高频项，实际报告里未命中比例未知。
- D1 无事务下的并发安全性 —— 单用户场景下概率极低，但**没有**并发测试。
- 前端在 Safari / 移动端的表现 —— 只在 ego-browser（Chromium）里跑过。

## 5.2 扫描件路径现状（2026-10-29 更换引擎后）

| 项 | 现状 |
|---|---|
| 引擎 | 浏览器本地 PaddleOCR.js（PP-OCRv5 mobile，ONNX Runtime WASM，Web Worker 内） |
| 输入 | 电子版 PDF → pdf.js 抽文字（不经 OCR）；扫描件 PDF → 渲染页图（scale 2）→ 本地 OCR |
| 表格重建 | `lib/table-reconstruct.ts`：y 聚行（剔高度离群框）+ 表头 x 区间定列 + 单位修正 |
| 日期 | `findReportDate` 从全部行提取（采集>报告>申请），补 `检测日期：YYYY-MM-DD` 到文本开头 |
| 服务端 | **不再有** `/api/ocr`、`lib/ocr.ts`、`AI` 绑定；旧路由返回 404（有 e2e 断言） |
| 性能 | 单页 12–20s（4 线程 WASM）；首次需下载模型 20.5MB（走百度 CDN，浏览器缓存） |
| 证据 | `e2e/live-scan.mjs` 真实扫描件 11/11；`test/table-reconstruct.test.ts` 用真实几何夹具 |

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