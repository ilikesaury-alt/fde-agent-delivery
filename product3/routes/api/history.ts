/**
 * GET /api/history —— 问答历史（回看用，倒序，最多 50 条）
 *
 * 401 令牌缺失/错误 · 500 存储异常
 */

import { defineHandler } from "void";

import { authorize, jsonResponse, resolveRepo } from "../../lib/http.ts";

export const GET = defineHandler(async (c) => {
  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  try {
    const records = await resolveRepo(c).listQa(50);
    return jsonResponse(200, { records });
  } catch {
    return jsonResponse(500, { error: "读取问答历史失败，请稍后重试。" });
  }
});
