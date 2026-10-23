/**
 * POST /api/digest
 * 请求：{ text: string }
 * 响应：{ digest: string } | { error: string }
 *
 * 错误映射：
 *   400 请求体非 JSON / text 非字符串 / 空输入
 *   413 超长
 *   503 未配置 magpie 凭据
 *   502 LLM 失败 / 结构不完整
 */

import { defineHandler } from "void";

import { buildSystemPrompt } from "../../lib/prompt.ts";
import { validateInput } from "../../lib/validate.ts";
import { hasAllSections } from "../../lib/sections.ts";
import { callLLM, MissingConfigError, LLMError, type LLMEnv } from "../../lib/llm.ts";

/** 从 context 读配置；测试可注入 c._fetchImpl 与 c.env */
function resolveEnv(c: unknown): LLMEnv {
  const ctx = c as { env?: Record<string, string> };
  const e = ctx.env ?? {};
  return {
    MAGPIE_BASE_URL: e.MAGPIE_BASE_URL,
    MAGPIE_API_KEY: e.MAGPIE_API_KEY,
    MAGPIE_MODEL: e.MAGPIE_MODEL,
  };
}

function resolveFetch(c: unknown): typeof fetch {
  const ctx = c as { _fetchImpl?: typeof fetch };
  return ctx._fetchImpl ?? fetch;
}

export const POST = defineHandler(async (c) => {
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

  // 空输入走 400；超长走 413，避免与边缘对超大 body 的 413 撞码
  const check = validateInput(text);
  if (!check.ok) {
    return c.json({ error: check.error }, check.status);
  }

  const systemPrompt = buildSystemPrompt();
  const llmEnv = resolveEnv(c);
  const fetchImpl = resolveFetch(c);

  try {
    let digest = await callLLM(llmEnv, systemPrompt, text, fetchImpl);

    // 结构不完整时重试一次；仍失败则明确报错，不交付残缺结果
    if (!hasAllSections(digest)) {
      digest = await callLLM(llmEnv, systemPrompt, text, fetchImpl);
      if (!hasAllSections(digest)) {
        return c.json({ error: "日报生成不完整，请重试或调整输入内容。" }, 502);
      }
    }

    return c.json({ digest });
  } catch (e) {
    if (e instanceof MissingConfigError) {
      // 标准 7：未配置时返回明确文案，不泄露堆栈
      return c.json({ error: e.message }, 503);
    }
    if (e instanceof LLMError) {
      // 文案已在 lib/llm.ts 收敛为面向用户的安全表述
      return c.json({ error: e.message }, 502);
    }
    // 其余未知异常一律返回通用文案，避免泄露内部堆栈/上游细节
    return c.json({ error: "AI 服务暂不可用，请稍后重试。" }, 502);
  }
});
