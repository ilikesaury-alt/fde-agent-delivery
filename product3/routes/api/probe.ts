/**
 * POST /api/probe —— 「这篇文档现在真的能搜到了吗」的可见性探针（CONTEXT D22）
 *
 * 请求体：{ id: string }（文档 id）
 * 响应：  { ok: true, searchable: boolean, matches: string[], checked: number, message?: string }
 *
 * 为什么要真探而不是看时间：
 *   Vectorize 的 upsert 是异步的（线上实测：接口返回 ready 后 0–40 秒仍检索不到，
 *   第 50 秒才命中，另一次 10 余秒即命中）。没有探针时，用户只能靠「再问一次试试」
 *   来判断 —— 那是猜，不是验证。
 *
 * 探测方法：拿该文档首个 chunk 的文本重新嵌入，再用它检索，
 * 看**它自己**是否出现在结果里（同 id 命中即索引已可见）。成本：1 次嵌入 + 1 次查询。
 *
 * 语义边界：
 *   - 「探不到」不是故障 → 返回 200 + searchable:false（前端提示「索引还在写入」），
 *     只有真的调用失败才 5xx。把「还没好」当错误会让用户以为导入坏了。
 *   - `indexedAt` 只补写缺失值，**不覆盖**：它是「写入被平台接受」的时刻，
 *     覆盖会污染 `/api/ask` 的「刚导入可能还在索引」提示窗口。
 *
 * 状态码：401 令牌 · 400 缺参/无片段 · 404 文档不存在 · 502 探测过程出错
 */

import { defineHandler } from "void";

import { embedOne } from "../../lib/embed.ts";
import { ERR } from "../../lib/errors.ts";
import { authorize, jsonResponse, resolveAi, resolveIndex, resolveRepo, type RouteCtx } from "../../lib/http.ts";

export const POST = defineHandler(async (c) => {
  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  const ctx = c as RouteCtx;
  if (!ctx._ai && !ctx.env?.AI) return jsonResponse(503, { error: ERR.aiBindingMissing });

  let body: { id?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return jsonResponse(400, { error: ERR.badJson });
  }
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) return jsonResponse(400, { error: ERR.missingField("id") });

  try {
    const repo = resolveRepo(c);
    const index = resolveIndex(c);
    const ai = resolveAi(c);

    const doc = await repo.getDocument(id);
    if (!doc) return jsonResponse(404, { error: ERR.docNotFound });

    const chunks = await repo.listChunksByDoc(id);
    if (!chunks.length) return jsonResponse(400, { error: ERR.probeNoChunks });

    // 只探 1 个片段：每次探测 = 1 次嵌入 + 1 次查询（Workers AI 配额是真金白银），
    // 「能不能搜到」用首个片段就足够表达（cross-review 发现 #10 的成本面）。
    const probes = chunks.slice(0, 1);
    const matches: string[] = [];
    for (const chunk of probes) {
      const vector = await embedOne(ai, chunk.text);
      const hits = await index.query(vector, 5);
      if (hits.some((h) => h.id === chunk.id)) matches.push(chunk.id);
    }

    const searchable = matches.length > 0;
    // 只给「刚导入不久、还没记过接受时刻」的文档补 indexed_at。
    // 若对很久以前导入的历史文档补写，会让 /api/ask 的「刚导入可能还在索引」提示误报
    // 90 秒（那时它其实早就能检索了 —— cross-review 发现 #3）。
    const RECENT_INGEST_MS = 10 * 60_000;
    if (searchable && doc.indexedAt == null && Date.now() - doc.createdAt < RECENT_INGEST_MS) {
      await repo.updateDocument(id, { indexedAt: Date.now() });
    }

    return jsonResponse(200, {
      ok: true,
      searchable,
      checked: probes.length,
      matches,
      message: searchable ? undefined : ERR.probeNotVisible,
    });
  } catch (e) {
    console.warn(`[probe] failed: ${e instanceof Error ? e.message : String(e)}`);
    return jsonResponse(502, { error: ERR.probeNotVisible });
  }
});