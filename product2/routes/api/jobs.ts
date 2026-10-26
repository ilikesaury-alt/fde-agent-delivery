/**
 * /api/jobs —— 历史记录
 *
 *   GET    /api/jobs            列表（倒序，最多 50 条，不含全文）
 *   GET    /api/jobs?id=<id>    单条（回看全文，含 sourceText 供重新生成）
 *   DELETE /api/jobs?id=<id>    删除
 *
 * 401 令牌缺失/错误 · 400 缺 id · 404 不存在 · 500 存储异常
 */

import { defineHandler } from "void";

import { authorize, jsonResponse, resolveStore } from "../../lib/http.ts";

export const GET = defineHandler(async (c) => {
  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  const id = new URL(c.req.url).searchParams.get("id");
  const store = resolveStore(c);

  try {
    if (id) {
      const job = await store.get(id);
      if (!job) return jsonResponse(404, { error: "记录不存在或已删除。" });
      return jsonResponse(200, { job });
    }

    // store.list 已在 SQL 层只取列（不搬运原文），这里直接返回
    const jobs = await store.list(50);
    return jsonResponse(200, { jobs });
  } catch {
    return jsonResponse(500, { error: "读取历史记录失败，请稍后重试。" });
  }
});

export const DELETE = defineHandler(async (c) => {
  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  const id = new URL(c.req.url).searchParams.get("id");
  if (!id) return jsonResponse(400, { error: "缺少 id。" });

  try {
    const removed = await resolveStore(c).remove(id);
    if (!removed) return jsonResponse(404, { error: "记录不存在或已删除。" });
    return jsonResponse(200, { ok: true });
  } catch {
    return jsonResponse(500, { error: "删除失败，请稍后重试。" });
  }
});
