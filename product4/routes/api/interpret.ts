/**
 * POST /api/interpret —— 单指标 AI 解读（CONTEXT D5 红线）
 *
 * 请求体：{ standardName: string, question?: string }
 * 响应：  { ok, refused, refusalReason?, text, citations[], mode, disclaimer }
 *
 * 三道闸（lib/interpret.ts）：
 *   ① 无历史数据 → 拒答（不调模型）
 *   ② 附加问题命中诊断/用药/危急意图 → 拒答（不调模型，lib/interpret-guard.ts）
 *   ③ 只有一次数据 → 只解释含义，不判趋势
 * 通过三道闸后才调模型，模型侧还有第二道红线 system prompt。
 *
 * 状态码：401 · 400 · 404（数据不足由 200 响应里的 refused 表达，不是错误）
 */

import { defineHandler } from "void";

import { ERR } from "../../lib/errors.ts";
import { ACTIVE_PROFILE, authorize, asString, jsonResponse, resolveEnv, resolveRepo, type RouteCtx } from "../../lib/http.ts";
import { interpretMetric } from "../../lib/interpret.ts";
import { LLMError, MissingConfigError } from "../../lib/llm.ts";

export const POST = defineHandler(async (c) => {
  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  let body: { standardName?: unknown; question?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return jsonResponse(400, { error: ERR.badRequest });
  }

  const standardName = asString(body.standardName);
  if (!standardName) return jsonResponse(400, { error: ERR.badRequest });
  const question = asString(body.question);

  const repo = resolveRepo(c);
  const ctx = c as RouteCtx;

  try {
    const history = await repo.listMetricHistory(ACTIVE_PROFILE, standardName);
    const result = await interpretMetric(resolveEnv(c), standardName, history, {
      fetchImpl: ctx._fetchImpl,
      question,
    });
    return jsonResponse(200, { ok: true, standardName, ...result });
  } catch (e) {
    if (e instanceof MissingConfigError) {
      return jsonResponse(500, { error: "AI 服务未配置，无法解读。" });
    }
    if (e instanceof LLMError) {
      return jsonResponse(502, { error: ERR.interpretFailed });
    }
    console.warn(`[interpret] failed: ${e instanceof Error ? e.message : String(e)}`);
    return jsonResponse(500, { error: ERR.interpretFailed });
  }
});