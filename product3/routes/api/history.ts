/**
 * GET /api/history —— 问答历史（回看用，倒序，最多 50 条）
 *
 * 二期口径（CONTEXT D23）：新真源是 `messages`（会话消息）；一期的 `qa_history`
 * 停止写入，只在 `?includeLegacy=1` 时一并读出来，方便上线后仍能看到历史问答。
 *
 * 401 令牌缺失/错误 · 500 存储异常
 */

import { defineHandler } from "void";

import { ERR } from "../../lib/errors.ts";
import { authorize, jsonResponse, resolveRepo } from "../../lib/http.ts";
import type { QaRecord } from "../../lib/types.ts";

export const GET = defineHandler(async (c) => {
  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  try {
    const repo = resolveRepo(c);
    const limit = 50;

    const messages = await repo.listRecentMessages(limit);
    const records: QaRecord[] = messages.map((m) => ({
      id: m.id,
      question: m.question,
      result: m.result,
      citedDocIds: m.citedDocIds,
      createdAt: m.createdAt,
    }));

    const includeLegacy = new URL(c.req.url).searchParams.get("includeLegacy") === "1";
    if (includeLegacy) {
      const legacy = await repo.listQa(limit);
      const known = new Set(records.map((r) => r.id));
      for (const r of legacy) {
        if (!known.has(r.id)) records.push(r);
      }
      records.sort((a, b) => b.createdAt - a.createdAt);
    }

    return jsonResponse(200, { records: records.slice(0, limit), legacyIncluded: includeLegacy });
  } catch (e) {
    console.warn(`[history] list failed: ${e instanceof Error ? e.message : String(e)}`);
    return jsonResponse(500, { error: ERR.historyFailed });
  }
});