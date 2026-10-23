/**
 * GET /api/health
 * 健康检查 + 暴露前端需要的阈值（避免前后端两处硬编码漂移）。
 */

import { defineHandler } from "void";

import { MAX_INPUT_CHARS } from "../../lib/prompt.ts";

export const GET = defineHandler((c) => {
  c.header("Cache-Control", "no-store");
  return c.json({
    ok: true,
    service: "meeting-digest",
    maxInputChars: MAX_INPUT_CHARS,
  });
});
