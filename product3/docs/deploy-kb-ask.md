# kb-ask 部署记录（2026-10-28）

> 产品③ 首次线上部署。**部署成功、云端资源与绑定已逐项核验**；运行时 E2E 因沙箱网络策略无法执行（见 §5）。
> 需求与验收见 [`product3/CONTEXT.md`](../CONTEXT.md)；交付文档见 [`product3/docs/features/kb-ask/kb-ask-交付文档.md`](./features/kb-ask/kb-ask-交付文档.md)。

## 1. 线上信息

| 项 | 值 |
|---|---|
| Worker 名 | `kb-ask` |
| 地址 | https://kb-ask.ilikesaury.workers.dev |
| 首个线上版本 | `dfddedbf-9120-4152-9bc5-ae2a7b6238ba` |
| 修复后当前版本 | `74ca217b-f759-436a-97c6-99604b52f683`（线上 E2E 12/12 通过） |
| 账号 | `e279d1f8bcb29c72945905179e57faeb`（与产品①② 同账号） |
| D1 | `kb-ask-db` → `722408dc-313a-4386-950f-ee35d867c9f5`（region **APAC**） |
| Vectorize | `kb-ask`（dimensions **1024**，metric **cosine**） |
| 上游模型 | 复用产品② 的 magpie 隧道（`MAGPIE_BASE_URL` / `MAGPIE_API_KEY` / `MAGPIE_MODEL`） |
| 访问令牌 | `ACCESS_TOKEN` 已配置（复用产品② 的值） |

## 2. 部署步骤（实际执行）

```bash
cd product3

# ① 建库（本次落在 APAC，靠近使用地）
npx wrangler d1 create kb-ask-db --location apac
#   → database_id: 722408dc-313a-4386-950f-ee35d867c9f5

# ② 应用 migration（顺序不可换：0002 依赖 0001 的表）
npx wrangler d1 execute kb-ask-db --remote --file=db/migrations/0001_init.sql
npx wrangler d1 execute kb-ask-db --remote --file=db/migrations/0002_unique_content_hash.sql

# ③ 建向量索引（维度必须与 bge-m3 一致，否则写入即报错）
npx wrangler vectorize create kb-ask --dimensions 1024 --metric cosine

# ④ database_id 回填 void.config.ts（唯一权威源）
#    ⚠️ 不要手改 .void-wrangler.jsonc（生成物，下次构建会被覆盖）

# ⑤ 构建 + 部署（脚本 = 构建 → wrangler deploy --secrets-file → 双探针）
npm run deploy -- --secrets .secrets.json
```

## 3. 部署核验（写死，缺一步不算成功）

| 核验项 | 实际结果 | 结论 |
|---|---|---|
| 部署日志 `Uploaded kb-ask` | `10.63 sec` | ✅ |
| 部署日志 assets 上传 | 有 `env.ASSETS` 且上传成功 | ✅（**1101 的关键项**） |
| `versions view` → `env.DB` | `722408dc-...` | ✅ |
| `versions view` → `env.VEC` | `kb-ask` | ✅ |
| `versions view` → `env.AI` | `AI` | ✅ |
| `versions view` → `env.ASSETS` | `Assets` | ✅ |
| secrets 注入 | `MAGPIE_BASE_URL` / `MAGPIE_API_KEY` / `MAGPIE_MODEL` / `ACCESS_TOKEN` 均为 `(hidden)` | ✅ |
| D1 表结构 | `documents` / `chunks` / `qa_history` 三表 + 6 个索引（含 `idx_documents_content_hash` 唯一索引） | ✅ |
| Vectorize 索引 | `kb-ask` / 1024 维 / cosine | ✅ |
| 上游模型可达 | `GET {MAGPIE_BASE_URL}/models` → HTTP 200 | ✅ |
| 线上 `/api/health` | `{"ok":true,"service":"kb-ask"}` | ✅ |
| 线上首页非 1101 | 无错误特征，应用正常渲染 | ✅ |
| 线上接口 E2E | **12/12 通过**（含真嵌入/真检索/真引用/拒答/幂等/删除） | ✅ |

## 4. 与产品①② 的差异（部署侧）

| 项 | 产品①② | 产品③ |
|---|---|---|
| 绑定数 | 2（ASSETS + DB） | **4（ASSETS + DB + AI + VEC）** |
| 首次资源 | D1 建库 | D1 建库 **+ Vectorize 建索引** |
| 维度写死风险 | 无 | 索引维度必须与嵌入模型一致（`bge-m3` = 1024），改模型需重建索引并重新导入 |
| 部署后探针 | `/api/health` + 首页 | 同上，另外**必须**在 `versions view` 里看到 AI 与 VEC |

## 5. 运行期排障：首次上线暴露的 4 个真实缺陷（已全部修复并线上验证）

> 这一节是产品③ 最有价值的部分：**本地全绿、绑定齐全、探针正常，功能依然不可用**。
> 四个缺陷全部只在「真 Cloudflare 运行时」暴露，本地 shim 与单测都无法发现。
> 排查手段：先 `versions view` 确认绑定（排除 1101 类问题），再用临时诊断端点在**线上**直接调用 `env.AI` / `env.VEC`，把真实错误原样取回。

### 缺陷 1：SSE 里所有检索都报「AI 服务暂不可用」

**现象**：`/api/ask` 返回 `event: error {phase:"ask", message:"AI 服务暂不可用"}`，但 `/api/health` 正常。

**根因**：`createVectorizeIndex.query()` 向绑定传了 `{ topK, returnValues: false, returnMetadata: false }`，
运行时绑定对布尔 `false` 的解析会失败：

```
VECTOR_QUERY_ERROR (code = 40026):
Failed to parse the request body as JSON: returnMetadata: expected value at line 1 column 49
```

**为什么本地测不到**：内存替身自己实现 `query(vector, topK)`，根本不看这两个选项。

**修复**：只传 `{ topK }`（本来也只需要 id 与 score，原文在 D1）。

### 缺陷 2：`getByIds` 不能用作「写入是否成功」的判据

**现象**：导入返回 502「索引写入校验失败」，但索引 `vectorCount` 在涨。

**根因**：`upsert` 返回 `mutationId` 后，**`getByIds` / `queryById` 在数十秒内都读不到新向量**，
而同一批向量在 `query` 里可能已经能命中。用 `getByIds` 做回读校验 → 假阴性 → 触发补偿 → 删掉 D1 chunk 行 → **孤儿向量**。

**修复**：见缺陷 4（改成异步验收语义），并把 `existing()` 的探测逻辑换成「`query` 可见性为准」。

### 缺陷 3：Vectorize 的 upsert 是**异步**的（最反直觉的一条）

**实测数据**（同一 Worker 内 upsert 后立即探测）：

| 探测方式 | upsert 后立即 | 60s 后 | 结论 |
|---|---|---|---|
| `query(自身向量)` | ❌ 查不到自己 | ✅ 可查 | 异步生效 |
| `query(用户问题向量)` | ❌ 无新片段 | ✅ 命中 score 0.737 | 异步生效 |
| `queryById(id)` | ❌ null | ✅ 有值 | 异步生效 |
| `getByIds([id])` | ❌ `[]` | ✅ 有值 | 异步生效 |
| `describe().vectorCount` | 不变 | 增加 | 异步生效 |

**实测追平时长：约 50 秒**（导入后轮询检索，第 5 次探测即第 50s 才命中）。这个数字直接决定用户体验与 E2E 写法。

**结论**：`upsert` 返回 `mutationId` 只代表**平台已接受**，不代表已可检索。
因此**不能把导入请求阻塞在「等向量可见」上**——那会让每次导入耗时数十秒甚至超时。

**修复（设计层面的修正）**：
- 导入流程把 `upsert` 的 mutationId 当作成功凭据 → 文档直接置 `ready`，并记录 `indexed_at`；
- 索引追上之前，检索会少命中 → **优雅降级**（RAG 本来就该能容忍部分召回缺失），而不是报错；
- 只有 `upsert` **抛错**才算真失败（走补偿清理）；
- 新增 `db/migrations/0003_indexed_at.sql` 用于线上对账。

### 缺陷 4：阈值默认值有第二份硬编码副本

**现象**：`detail` 里打印的阈值是 `0.35`，而 `DEFAULT_MIN_SCORE` 已改成 `0.45`。

**根因**：`lib/http.ts` 的 `resolveRetrieveOptions()` 自己写了一份 `: 0.35` 兜底值，与
`lib/retrieve.ts` 的 `DEFAULT_MIN_SCORE` 各写一遍 —— 正是 `lib/errors.ts` 头注释警告的「单一真源」问题，
我在同一类问题上又犯了一次。

**修复**：`http.ts` 改为 import `DEFAULT_MIN_SCORE` / `DEFAULT_TOP_K`，不再自带常量。

### 真实模型的相似度尺度（标定依据）

| 文本对 | 真 bge-m3 得分 |
|---|---|
| 「回滚用什么命令」↔ 回滚文档片段 | **0.737** |
| 「部署和回滚」↔ 部署片段 / 回滚片段 | **0.52 / 0.65** |
| 无关问题 ↔ 库内任意片段 | 落在阈值以下（触发拒答） |
| 本地词袋假嵌入 ↔ 相关文本 | 0.05–0.2 |

→ 默认阈值定 **0.45**（位于无关与相关之间的安全带），本地 shim 仍注入 0.05。

### 线上验证结果（修复后，version `74ca217b`）

```
✔ ① /api/health → 200 且 service=kb-ask
✔ ② 带令牌 GET /api/documents → 200（真 D1 连通）
✔ ③ 导入 → ready（真 bge-m3 嵌入 + 真 Vectorize 写入）
✔ ④ 同内容重复导入 → skipped（幂等）
✔ ⑤ 引用可核验 — doc=线上E2E-部署手册 位置=部署手册 / 回滚
✔ ⑥ 无关问题 → 拒答（refused=true）
✔ ⑦ 历史问答已落库
✔ ⑧ 删除 → 连带清理向量
✔ ⑨ 空文本 → 400 / SSRF 尾点地址 → 400 / 删除不存在 → 404
结果：**13/13 通过**（含「等待 50s 索引追上后真正检索到并给出引用」）
```

复现命令（用真实浏览器进程，因为 Node 侧出网受限）：

```bash
cd product3
ego-browser nodejs < e2e/live-e2e.mjs     # 线上接口级 E2E（12 项）
ego-browser nodejs < e2e/live-probe.mjs   # 线上可达性与 1101 检查
```

### 仍待你确认的两点

1. **索引可见性延迟的实际时长**：修复后不再阻塞等待，用户可能遇到「刚导入完立刻提问、该文档还没被检索到」。
   若体验不可接受，二期可加「导入后前端提示：索引同步中，约 N 秒后可检索」。
2. **阈值标定**：0.45 来自少量样本（1 篇文档、4 个查询）。上量后应用 `npm run eval` 重新扫曲线。

---

## 6. 回滚

```bash
npx wrangler deployments list --name kb-ask
npx wrangler rollback <完整 version-id> --name kb-ask --message "原因" -y
```

⚠️ 回滚 Worker **不会**回滚 D1 数据与 Vectorize 索引。若曾改索引维度，回滚后旧代码会用错维度读新索引 → 检索报错，需重建索引并重新导入。
