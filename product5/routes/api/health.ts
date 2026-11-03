/** GET /api/health —— 存活探针（部署后验证用，不校验令牌） */

import { defineHandler } from "void";

import { authMode } from "../../lib/http.ts";

export const GET = defineHandler(async (c) => {
  // 审查 B-1：把鉴权模式暴露出来 —— 否则「当前无鉴权」这件事只有翻 env 才知道
  return new Response(
    JSON.stringify({ ok: true, service: "ai-hot-radar", authMode: authMode(c) }),
    { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
  );
});