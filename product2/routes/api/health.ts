/** GET /api/health —— 存活探针（部署后验证用，不校验令牌） */

import { defineHandler } from "void";

export const GET = defineHandler(async () => {
  return new Response(JSON.stringify({ ok: true, service: "content-studio" }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
});
