# 体检指标追踪（health-track）— 工作原理文档

> 面向：接手的开发者。读完应能独立改这个产品而不破坏它的核心纪律。

## 1. 一句话与整体架构

**一句话**：把躺在抽屉里的体检报告变成**可信的健康时间序列**，并在其上做**有纪律的 AI 解读**。

```
浏览器                                     Worker (Cloudflare)
┌──────────────────────────┐              ┌─────────────────────────────────────┐
│ PDF 文字层 → pdf.js 抽文本 │──文本──────▶│ POST /api/extract                  │
│ 扫描件 → pdf.js 渲染 JPEG  │──图片──────▶│   → 上游 LLM（只转录）              │
│   → POST /api/ocr          │◀─文本──────│   → 服务端校验 + 计算（唯一计算权）  │
│ 粘贴文本                   │              │                                     │
│                            │──确认的行──▶│ POST /api/reports  → D1             │
│ 预览表格（勾选 + 原文对照） │              │ POST /api/metrics  → D1（手工补录） │
│                            │◀─序列──────│ GET  /api/trends  （D1 → 纯函数聚合）│
│ 趋势图（自绘 SVG）          │              │ POST /api/interpret → 守卫 → LLM     │
└──────────────────────────┘              └─────────────────────────────────────┘
```

设计上把系统切成三层，**每层只做一件事**：

| 层 | 文件 | 职责 | 为什么单独一层 |
|---|---|---|---|
| 获取文本 | `lib/pdf.ts`（前端）、`lib/ocr.ts` | 拿到**文本**（不论来自 PDF、扫描件还是粘贴） | 三种输入的差异只在这一层；下面完全同构 |
| 抽取 + 计算 | `lib/extract.ts`、`lib/trend.ts`、`lib/metrics-dict.ts` | 文本 → 指标行，全部计算在本层 | 计算必须可单测、可复现，不能交给模型 |
| 存储 / 展示 | `lib/repo.ts`、`lib/service.ts`、`routes/*`、`pages/*` | 落库、聚合展示 | 存储与业务解耦，内存实现可跑本地整链 |

## 2. 导入的完整生命周期

1. **取文本**
   - 电子版 PDF：`extractPdfText`（pdf.js，仅浏览器）→ 纯文本。无文字层则抛 `no_text`，
     UI 引导走 OCR 而不是「假装成功」。
   - 扫描件：`renderPdfPages` 渲染前 ≤5 页为 JPEG → 逐页 `POST /api/ocr` → Worker 调
     Workers AI 视觉模型 → 文本。**单页失败只跳过该页**（标记出来），不整批失败。
   - 粘贴：直接用。
2. **抽取**（`POST /api/extract`，**不落库**）
   - 构造 system prompt：明确「只转录、不计算、原文没有的字段一律 null、source_quote 必须原样截取」。
   - `callLLM` → `parseJsonLoose`（容忍 ```json 包裹 / 前后有解释文字）→ `validateExtracted`：
     - `check_date` 必须是可解析日期（`2025-3-4` / `2025年3月4日` 都归一成 `2025-03-04`），
       否则判 `extractInvalid` → 重试；
     - 指标行缺名字或缺值 → **丢该行**（报告常有表头/注释被误认），全丢则判 `extractFailed`；
     - 同报告内 `rawName|valueText` 重复 → 去重（模型偶尔抄两遍）。
   - 重试策略：**只对解析/校验失败重试**（默认 1 次）；上游 401/429/5xx 不重试（避免放大限流）。
3. **人工确认闸**：返回预览，前端表格逐行显示 + 勾选。**此时数据库没有写入**。
4. **入库**（`POST /api/reports`）：服务端用 `toExtractedMetric` **重新计算**每一行 ——
   前端回传的 `status`/`valueNum` 一律不采信（否则确认闸可被改包绕过）。写入
   `reports` 一行 + `metrics` N 行（按绑定变量数分批）。

## 3. 解读的完整生命周期

```
POST /api/interpret { standardName, question? }
  ├─ 闸①：该指标无历史数据        → 200 refused:true, reason=no_data（不调模型）
  ├─ 闸②：question 命中红线意图    → 200 refused:true, reason=question_guard（不调模型）
  ├─ 闸③：历史 < 2 条 → mode=explain（只解释含义，不判趋势）
  └─ 调模型（system prompt 第二道红线）→ 返回 text + citations（实际用到的数据行）+ disclaimer
```

**为什么拒答不走「错误码」而是 200 + refused**：拒答是产品**正常行为**，不是故障。
前端据此渲染成「说明性提示」而不是红色报错。

**为什么红线用规则守卫而不是让模型自己拒绝**：模型拒绝是不可测的（同一提问有时拒有时不拒），
而医疗红线不能有概率。规则守卫宁可误拒（少答），不可漏放；模型侧提示词是第二道，不是第一道。

## 4. 关键设计决策与原理

### 4.1 为什么「LLM 只转录，计算全在服务端」（本产品最重要的一条）

如果让模型直接给「偏高/正常」，会有两个不可接受的后果：
1. **算错无从复核**：模型算错一位就是医疗数据事故，且没有单测能固定它；
2. **不可测**：同一输入模型可能给不同结论，评测永远不稳。

改成「转录 + 服务端计算」后：
- 每条结论都能用纯函数单测固定（`trend.test.ts` 30+ 用例）；
- 模型出错只剩「抄错原文」，而抄错原文有 `source_quote` 对照 + 人工确认闸兜底；
- 计算口径改一次就全局生效，不用重新调模型。

配套的实测缺陷：报告里写 `2.31 ↑`，模型照原样转录，`parseValueNum("2.31 ↑")` 判成非数值
→ 偏高被显示成「无法判断」。修法：`cleanValueText` 先剥方向标记再解析
（箭头信息由 `status` 承载）。

### 4.2 为什么参考范围「宁可判不出，也不猜」

不同医院/方法学参考范围不同，格式千奇百怪：`0.45-1.7`、`≤100`、`≥1.0`、`100以下`、
`阴性`、`未见异常`、`0～10^9/L`。所以：
- `ref_text` 原文**永远存**（展示与追溯都用它）；
- `parseRefRange` 只认**能可靠解析的几种形态**，解析失败返回 `null`；
- `determineStatus` 遇到 `null` 范围、无数值、`low>high` 一律 `unknown`。

**正确性优先于覆盖率**：错误地标「偏高」比不标更糟 —— 用户会据此焦虑或自行改治疗。

### 4.3 为什么指标名要归一，但归一必须「安全」

「甘油三酯 / TG / Triglyceride」若各存各的，趋势会碎成每份报告一条线。
但归一**错并**比断裂更严重（把两个不同指标合成一条线 = 假的趋势）。
因此 `normalizeMetricName` 只做三类安全操作：
1. 去括号说明（`白细胞(血常规)` → `白细胞`）；
2. 去尾部标记（`肌酐 ↑` → `肌酐`）；
3. 拉丁字母转小写（`ALT` = `alt`）。

**不做**单词级缩写展开、语义相似度合并。未命中字典 → 保留清洗后的原文名，
并在序列上展示所有出现过的原文名（让人能看出「这是一族叫法」）。

### 4.4 为什么手工补录建模成「一份报告」

补录的指标只要检测日期与某份报告一致，就属于**同一次检测**。所以按
`(checkDate, source_type='manual')` 复用同一份手工报告并合并指标。
这样趋势、异常判定、解读全部不用为手工数据走特殊分支 —— 一种数据一个模型。

### 4.5 为什么前端自己画 SVG 图

需求只有「折线 + 参考范围带」。引入 recharts/echarts 要付出体积与 SSR 兼容代价，
收益不成立。落选条件也记了下来：若后续需要多指标叠加/缩放/导出，再考虑换库。

### 4.6 为什么 `<input type="date">` 提交时读 DOM 真值

`<input type="date">` 被程序化赋值（自动填充、测试脚本、部分输入法）时**不触发 onChange**，
于是 state 与界面显示不一致：用户看得见日期，点保存却报「请填写检测日期」（实测踩到）。
因此：默认值设为今天，且提交时以 `ref.current.value` 为准。

## 5. 数据模型

```sql
reports(id, profile_id, source_type, file_name, check_date, hospital,
        raw_text, metric_count, created_at)          -- 原文全文永远保留
metrics(id, report_id, profile_id, standard_name, raw_name,
        value_num, value_text, unit, ref_low, ref_high, ref_text,
        status, source_quote, created_at)            -- 每条可回指原文片段
```

- `value_text` 与 `value_num` **双存**：前者原文（含 `<0.01`、`阴性`），后者用于画图；
- `ref_text` 与 `ref_low/ref_high` 同理：原文永远可读，数值范围只在该解析得出时才有；
- 删除报告时**先删 metrics 再删 reports**（不依赖 D1 是否开外键级联），避免悬挂指标。

查询：
- 趋势：`metrics JOIN reports` 按 `(profile_id, standard_name)` 取点，`ORDER BY check_date`；
- 解读历史：同一 join 限定 `standard_name`。

## 6. 安全机制

| 面 | 措施 |
|---|---|
| 访问控制 | `ACCESS_TOKEN` + `Authorization: Bearer`，等长比较；**所有** `/api/*` 路由统一 `authorize()` |
| 确认闸不可绕过 | 入库路由服务端**重算**所有派生字段，不采信客户端值 |
| 红线 | 规则守卫（确定性）+ 模型 system prompt（第二道）+ 固定免责声明 |
| 隐私 | 无第三方分析/上报；数据仅在自有 D1；`raw_text` 全文本地保存（复核必需） |
| OCR 输入面 | 只接受 data URL（禁止 Worker 去 fetch 任意 URL，避免新增 SSRF 面） |
| 密钥 | 只在 Worker env；仓库内无明文（`.secrets.json` 被 gitignore） |

## 7. 前端结构

单页四页签：时间线 / 趋势 / 指标解读 / 手工补录，左栏是导入 + 预览确认闸。

- 所有可交互元素带 `data-testid`（E2E 依赖）；
- 状态诚实：索引/加载/解析中都有可见文案；401 明确提示去填令牌；
- 长操作可取消（`AbortController`）；OCR 显示「第 N/M 页」进度；
- 预览表格默认全选，人只需取消抄错的行。

## 8. 环境与部署拓扑

- Worker `health-track`，绑定 `DB`（D1 `health-track-db`）、`AI`、`ASSETS`；**无 Vectorize**。
- 部署：`scripts/deploy.mjs`（迁移 → 构建 → deploy `--secrets-file` → `/api/health` + `/` 双探针）。
- 版本记录见 [deploy-health-track.md](../../deploy-health-track.md)。

## 9. 本地可跑什么、不能跑什么（沙箱约束）

| 能力 | 本地 | 说明 |
|---|---|---|
| 单测 / 类型检查 / 构建 | ✅ | `npm test` / `typecheck` / `build` |
| 整链（抽取→入库→趋势→解读） | ✅ | `npm run verify:local`（内存 Repo + 假网关，跑的是同一份 `lib/`） |
| 真实抽取评测 | ✅ | `npm run eval`（真网关；需 `.secrets.json`） |
| `vite dev` | ❌ | 沙箱不能 spawn workerd |
| 线上验证 | ⚠️ | 沙箱 Node/curl 到 workers.dev 超时 → 走 ego-browser 浏览器通道 |
| 截图 | ❌ | 本环境 `Page.captureScreenshot` 对外站也超时（环境限制） |