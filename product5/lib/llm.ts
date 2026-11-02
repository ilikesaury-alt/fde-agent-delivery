/**
 * lib/llm.ts —— 上游 LLM 网关适配（OpenAI 兼容，经 magpie 中转）
 *
 * 与产品①②③④ 同约定：BASE_URL / API_KEY / MODEL 只从 env 读，密钥永不出服务端。
 *
 * 本产品特有：
 *  - **严格 JSON 打分**：`parseScore` 失败即视为该条失败，不塞默认分（否则阈值标定失真）
 *  - **失败不重试**（一次也不重试）：评分是批量任务，单条失败留 empty 比拖长整批更有用；
 *    重试策略留给调用方按预算决定（Cron 里由「下一轮再评」自然补偿）
 *  - **面向用户文案**：错误分类（未配置 / 超时 / 上游错误 / 返回不可解析），不回显上游响应体
 */

import { buildScorePrompt, parseScore, SCORE_SYSTEM_PROMPT, type Score, type ScoreInput } from "./score.ts";

export type LLMEnv = {
  MAGPIE_BASE_URL?: string;
  MAGPIE_API_KEY?: string;
  MAGPIE_MODEL?: string;
};

export type LLMErrorCode = "not_configured" | "timeout" | "upstream" | "bad_response";

export class LLMError extends Error {
  code: LLMErrorCode;
  constructor(code: LLMErrorCode, message: string) {
    super(message);
    this.name = "LLMError";
    this.code = code;
  }
}

export const LLM_MESSAGES: Record<LLMErrorCode, string> = {
  not_configured: "AI 服务未配置，评分功能暂不可用。",
  timeout: "AI 服务响应超时，请稍后重试。",
  upstream: "AI 服务暂不可用，请稍后重试。",
  bad_response: "AI 返回内容无法解析，本条未评分。",
};

export type ScoreOneResult =
  | { ok: true; score: Score }
  | { ok: false; error: LLMErrorCode; message: string };

export type ScoreCallOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
};

function resolveConfig(env: LLMEnv): { base: string; key: string; model: string } {
  if (!env.MAGPIE_BASE_URL || !env.MAGPIE_API_KEY) {
    throw new LLMError("not_configured", LLM_MESSAGES.not_configured);
  }
  return {
    base: env.MAGPIE_BASE_URL.replace(/\/+$/, ""),
    key: env.MAGPIE_API_KEY,
    model: env.MAGPIE_MODEL || "deepseek-chat",
  };
}

/** 给单条资讯打分（失败分类返回，不抛异常，便于批量汇总） */
export async function scoreOne(
  env: LLMEnv,
  input: ScoreInput,
  opts: ScoreCallOptions = {},
): Promise<ScoreOneResult> {
  let cfg: { base: string; key: string; model: string };
  try {
    cfg = resolveConfig(env);
  } catch (err) {
    const e = err as LLMError;
    return { ok: false, error: e.code, message: e.message };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let resp: Response;
    try {
      resp = await fetchImpl(`${cfg.base}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.key}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: "system", content: SCORE_SYSTEM_PROMPT },
            { role: "user", content: buildScorePrompt(input) },
          ],
          temperature: opts.temperature ?? 0.2,
          max_tokens: opts.maxTokens ?? 300,
        }),
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) {
        return { ok: false, error: "timeout", message: LLM_MESSAGES.timeout };
      }
      return { ok: false, error: "upstream", message: LLM_MESSAGES.upstream };
    }

    if (!resp.ok) {
      await resp.body?.cancel().catch(() => undefined);
      return { ok: false, error: "upstream", message: LLM_MESSAGES.upstream };
    }

    let content: string;
    try {
      const body = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      content = body.choices?.[0]?.message?.content ?? "";
    } catch {
      return { ok: false, error: "bad_response", message: LLM_MESSAGES.bad_response };
    }

    const parsed = parseScore(content);
    if (!parsed.ok) {
      return { ok: false, error: "bad_response", message: `${LLM_MESSAGES.bad_response}（${parsed.reason}）` };
    }
    return { ok: true, score: parsed.score };
  } finally {
    clearTimeout(timer);
  }
}

export type BatchScoreOptions = ScoreCallOptions & {
  /** 并发度（默认 2；Free 套餐 subrequest 50/次是硬预算） */
  concurrency?: number;
};

export type BatchScoreItem<T> = {
  input: T;
  result: ScoreOneResult;
};

/**
 * 批量打分：逐条独立，**单条失败不影响其它条**。
 * 返回顺序与输入一致（调用方按索引写库，不能靠返回顺序猜）。
 */
export async function scoreMany<T extends ScoreInput>(
  env: LLMEnv,
  inputs: T[],
  opts: BatchScoreOptions = {},
): Promise<Array<BatchScoreItem<T>>> {
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 2, 5));
  const results: Array<BatchScoreItem<T>> = new Array(inputs.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= inputs.length) return;
      const input = inputs[index]!;
      const result = await scoreOne(env, input, opts);
      results[index] = { input, result };
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, () => worker()));
  return results;
}