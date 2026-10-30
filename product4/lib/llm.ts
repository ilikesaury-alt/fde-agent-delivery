/**
 * 上游 LLM 网关调用（OpenAI 兼容）—— 与产品①②③ 同口径的独立副本。
 *
 * 为什么允许「副本」而不共享包：三产品是独立 Worker、独立部署，跨产品 import 会让
 * 一个产品的改动意外影响另一个（部署边界即依赖边界）。同口径靠约定 + 本注释。
 */

export class MissingConfigError extends Error {
  constructor() {
    super("AI 服务未配置（缺少 MAGPIE_BASE_URL / MAGPIE_API_KEY）。");
    this.name = "MissingConfigError";
  }
}

/** LLM 调用失败（网络/超时/限流/上游 5xx），文案面向终端用户 */
export type LLMErrorReason = "empty" | "status" | "exception";

export class LLMError extends Error {
  status: number;
  /**
   * 失败性质，决定调用方**能否重试**：
   * - `empty`：上游 200 但内容为空（退化响应，瞬时，可重试）
   * - `status`：上游给了错误码（401/429/5xx，重试只会放大限流）
   * - `exception`：网络/超时/解析失败（重试会再等一个超时，通常无益）
   */
  reason: LLMErrorReason;
  constructor(message = "AI 服务暂不可用，请检查配置或稍后重试。", status = 0, reason?: LLMErrorReason) {
    super(message);
    this.name = "LLMError";
    this.status = status;
    this.reason = reason ?? (status ? "status" : "exception");
  }
}

export type LLMEnv = {
  MAGPIE_BASE_URL?: string;
  MAGPIE_API_KEY?: string;
  MAGPIE_MODEL?: string;
};

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

function assertConfigured(e: LLMEnv): void {
  if (!e.MAGPIE_BASE_URL || !e.MAGPIE_API_KEY) {
    throw new MissingConfigError();
  }
}

function endpoint(e: LLMEnv): { url: string; model: string; key: string } {
  assertConfigured(e);
  const url = `${String(e.MAGPIE_BASE_URL).replace(/\/+$/, "")}/chat/completions`;
  return { url, model: e.MAGPIE_MODEL || "deepseek-chat", key: String(e.MAGPIE_API_KEY) };
}

/** 上游状态码 → 面向用户的友好错误（不回传上游响应体，避免泄露） */
function mapStatus(status: number): LLMError {
  if (status === 401 || status === 403) return new LLMError("AI 服务凭据无效，请检查配置后重试。", status);
  if (status === 429) return new LLMError("请求过于频繁，请稍后再试。", status);
  if (status >= 500) return new LLMError("AI 服务暂时不可用，请稍后重试。", status);
  return new LLMError(undefined, status);
}

/**
 * 排查用日志：只进 Worker 日志（console.warn），不上屏、不回传前端。
 * ⚠️ Workers 里没有 process.env —— 不要按环境变量决定是否打日志（②踩过的坑）。
 */
function debugLog(status: number | string, detail: string): void {
  console.warn(`[llm] upstream ${status}: ${detail.slice(0, 300)}`);
}

/**
 * 非流式调用。失败统一收敛为 LLMError，不把上游堆栈/响应体泄露给前端。
 * `reason` 供调用方判断**能否重试**：`empty` 是退化响应（瞬时，可重试），
 * `status`/`exception` 是确定性或环境性失败（不重试，避免放大限流）。
 */
export async function callLLM(
  e: LLMEnv,
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<string> {
  const { url, model, key } = endpoint(e);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  // 抽取是长输入短输出，但仍按远端慢的情况留足余量（③实测整篇生成 26–36s）
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 85_000);

  try {
    const resp = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: opts.temperature ?? 0.1,
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        // 显式关闭流式：中转默认走 SSE 时 resp.json() 会解析失败并被误报为服务不可用（②踩过）
        stream: false,
        messages,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      try {
        debugLog(resp.status, await resp.text());
      } catch {
        debugLog(resp.status, "(响应体读取失败)");
      }
      throw mapStatus(resp.status);
    }

    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      debugLog("empty", JSON.stringify(data).slice(0, 300));
      throw new LLMError("AI 服务返回了空内容，请稍后重试。", 0, "empty");
    }
    return content;
  } catch (err) {
    if (err instanceof LLMError || err instanceof MissingConfigError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    debugLog("exception", msg);
    throw new LLMError(undefined, 0, "exception");
  } finally {
    clearTimeout(timeout);
  }
}