/**
 * Cloudflare Worker 入口 — 会议记录整理日报
 * 路由：
 *   GET  /health   健康检查（不依赖任何配置）
 *   POST /api/digest  { text } -> { digest: Markdown }
 */

import { Hono } from "hono";
import { cors } from "hono/cors";

import { buildSystemPrompt, MAX_INPUT_CHARS } from "./prompt.ts";
import { validateInput } from "./validate.ts";
import { hasAllSections } from "./sections.ts";
import { callLLM, MissingConfigError, LLMError, type Env } from "./llm.ts";

export type Bindings = Env;

const app = new Hono<{ Bindings: Bindings }>();
// 前端 Pages 域名与本地开发都需要跨域。
// 默认放开（个人工具、无凭证无 Cookie）；配了 ALLOWED_ORIGIN 则收紧为单一来源。
app.use("/api/*", async (c, next) => {
  const allowed = c.env?.ALLOWED_ORIGIN as string | undefined;
  const corsMiddleware = cors(
    allowed
      ? { origin: allowed, credentials: false }
      : { origin: "*", credentials: false },
  );
  return corsMiddleware(c, next);
});

// 统一错误形状：路由外异常也返回 { error } JSON，避免前端拿到 text/plain
app.onError((_e, c) => c.json({ error: "服务内部错误，请稍后重试。" }, 500));

app.get("/health", (c) => {
  const configured = Number(c.env?.MAX_INPUT_CHARS);
  return c.json({
    ok: true,
    service: "meeting-digest-worker",
    // 前端据此展示字数上限，避免前后端两处硬编码漂移
    // （实际校验阈值是 prompt.ts 的常量；此值仅用于展示同步）
    maxInputChars: Number.isFinite(configured) && configured > 0 ? configured : MAX_INPUT_CHARS,
  });
});

/**
 * 结构校验：确认日报包含全部必需板块（验收标准 1）。
 * 模型偶发漏板块时靠这个兜底，避免用户静默拿到残缺日报。
 * 实现在 src/sections.ts（与测试共用）。
 */
app.post("/api/digest", async (c) => {
  let text: unknown;
  try {
    const body = (await c.req.json()) as { text?: unknown };
    text = body.text;
  } catch {
    return c.json({ error: "请求体必须是 JSON，且包含 text 字段。" }, 400);
  }

  if (typeof text !== "string") {
    return c.json({ error: "字段 text 必须是字符串。" }, 400);
  }

  // 标准 4（空输入）走 400；标准 5（超长）走 413，避免与 Cloudflare 边缘对超大 body 的 413 撞码
  const check = validateInput(text);
  if (!check.ok) {
    return c.json({ error: check.error }, check.status);
  }

  const systemPrompt = buildSystemPrompt();

  try {
    let digest = await callLLM(c.env, systemPrompt, text);

    // 结构不完整时重试一次；仍失败则明确报错，不交付残缺结果
    if (!hasAllSections(digest)) {
      digest = await callLLM(c.env, systemPrompt, text);
      if (!hasAllSections(digest)) {
        return c.json(
          { error: "日报生成不完整，请重试或调整输入内容。" },
          502,
        );
      }
    }

    return c.json({ digest });
  } catch (e) {
    if (e instanceof MissingConfigError) {
      // 标准 7：未配置时返回明确文案，不泄露堆栈
      return c.json({ error: e.message }, 503);
    }
    if (e instanceof LLMError) {
      // 文案已在 llm.ts 收敛为面向用户的安全表述
      return c.json({ error: e.message }, 502);
    }
    // 其余未知异常一律返回通用文案，避免泄露内部堆栈/上游细节
    return c.json({ error: "AI 服务暂不可用，请稍后重试。" }, 502);
  }
});

export default app;
