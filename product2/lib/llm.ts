/**
 * LLM 接入 — 经 magpie 中转（OpenAI 兼容 /chat/completions）
 * 密钥只从 Void env 读，绝不进前端、绝不写死。
 *
 * 与产品① 的差异：产品② 需要**流式**（生成步骤 token 级输出），
 * 因此这里提供两个入口：
 *   - callLLM()      非流式，用于「长文压缩要点」
 *   - streamLLM()    流式（async generator），用于「生成笔记正文」
 */

import { env } from "void/env";

/** magpie 未配置/配置不完整时抛出，文案面向终端用户（验收标准 9） */
export class MissingConfigError extends Error {
  constructor(message = "AI 服务暂不可用：未配置模型服务凭据，请检查配置后重试。") {
    super(message);
    this.name = "MissingConfigError";
  }
}

/** LLM 调用失败（网络/超时/限流/上游 5xx），文案面向终端用户 */
export class LLMError extends Error {
  constructor(message = "AI 服务暂不可用，请检查配置或稍后重试。") {
    super(message);
    this.name = "LLMError";
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
  if (status === 401 || status === 403) return new LLMError("AI 服务凭据无效，请检查配置后重试。");
  if (status === 429) return new LLMError("请求过于频繁，请稍后再试。");
  if (status >= 500) return new LLMError("AI 服务暂时不可用，请稍后重试。");
  return new LLMError();
}

/** 排查用：仅在 DEBUG_LLM=1 时把上游状态与响应片段打到服务端日志（不上屏、不回传前端） */
function debugLog(status: number, detail: string): void {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const flag = env?.DEBUG_LLM;
  if (flag && flag !== "0" && flag !== "false") {
    console.warn(`[llm] upstream ${status}: ${detail.slice(0, 400)}`);
  }
}

/**
 * 非流式调用。用于「长文压缩要点」这类一次性产出。
 * 失败统一收敛为 LLMError，不把上游堆栈/响应体泄露给前端。
 */
export async function callLLM(
  e: LLMEnv,
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<string> {
  const { url, model, key } = endpoint(e);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  // 与产品① 对齐：真实模型整篇生成约 26–36s，压缩调用也应留足余量。
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 85_000);

  try {
    const resp = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: opts.temperature ?? 0.3,
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        // 显式关闭流式：若中转默认走 SSE，resp.json() 会解析失败并被误报为服务不可用
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
      throw new LLMError("AI 返回结果为空，请重试或调整素材内容。");
    }
    return content.trim();
  } catch (err) {
    if (err instanceof MissingConfigError || err instanceof LLMError) throw err;
    // 网络异常 / abort / JSON 解析失败统一收敛
    throw new LLMError();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 流式调用。逐段产出 token 增量（OpenAI SSE 的 `choices[0].delta.content`）。
 *
 * 解析要点（都是真实踩坑点）：
 *  - 上游可能把 `data: {...}` 与空行分片乱切，必须跨 chunk 缓冲到换行再解析；
 *  - `data: [DONE]` 是结束哨兵，不当作 JSON；
 *  - 上游返回非 SSE（例如整段 JSON）时要能识别并降级为一次性产出，而不是静默产出空内容。
 */
export async function* streamLLM(
  e: LLMEnv,
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number; fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {},
): AsyncGenerator<string, void, unknown> {
  const { url, model, key } = endpoint(e);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort);
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);

  let produced = false;
  try {
    const resp = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: opts.temperature ?? 0.7,
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        stream: true,
        messages,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      // SSE 响应体是流，不读整段，只记状态码
      const ct = resp.headers.get("content-type") ?? "";
      if (ct.includes("text/event-stream")) debugLog(resp.status, "(SSE 错误响应)");
      else {
        try {
          debugLog(resp.status, await resp.text());
        } catch {
          debugLog(resp.status, "(响应体读取失败)");
        }
      }
      throw mapStatus(resp.status);
    }

    const contentType = resp.headers.get("content-type") ?? "";

    // 上游不认流式、直接回整段 JSON → 降级为一次性产出，保证功能可用
    if (!contentType.includes("text/event-stream") || !resp.body) {
      const text = await resp.text();
      let whole = text;
      try {
        const data = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
        whole = data.choices?.[0]?.message?.content ?? "";
      } catch {
        // 不是 JSON：只有纯文本才当内容（HTML 错误页/网关页不能当笔记正文）
        if (!contentType.includes("text/plain")) {
          debugLog(resp.status, text);
          throw new LLMError("AI 服务返回异常内容，请稍后重试。");
        }
      }
      if (whole.trim().length) {
        produced = true;
        yield whole;
      }
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawDone = false;
    let sawUpstreamError = false;

    while (!sawDone) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // 按行消费，最后一行可能不完整，留在 buffer 里
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIdx).replace(/\r$/, "");
        buffer = buffer.slice(newlineIdx + 1);
        const delta = parseSseLine(line);
        if (delta === UPSTREAM_ERROR) {
          sawUpstreamError = true;
          continue;
        }
        if (delta === DONE) {
          sawDone = true;
          await reader.cancel().catch(() => {});
          break;
        }
        if (delta) {
          produced = true;
          yield delta;
        }
      }
    }

    if (sawUpstreamError) {
      throw new LLMError("生成被上游中断，请重试。");
    }

    if (sawDone) {
      // 收到 [DONE] 也要校验产出：部分模型只回空 delta/推理字段，不吐 content，
      // 早期版本在这里提前 return 会把「空结果」当成成功。
      if (!produced) throw new LLMError("AI 返回结果为空，请重试。");
      return;
    }

    // 收尾：处理最后一行无换行符的情况
    const tail = parseSseLine(buffer.replace(/\r$/, ""));
    if (tail === UPSTREAM_ERROR) throw new LLMError("生成被上游中断，请重试。");
    if (tail && tail !== DONE) {
      produced = true;
      yield tail;
    }

    if (!produced) throw new LLMError("AI 返回结果为空，请重试。");
  } catch (err) {
    if (err instanceof MissingConfigError || err instanceof LLMError) throw err;
    if (opts.signal?.aborted) throw new LLMError("生成已取消。");
    throw new LLMError();
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

const DONE = Symbol("sse-done");
const UPSTREAM_ERROR = Symbol("sse-error");

/** 解析一行 SSE，返回 token 增量 / 结束哨兵 / null（忽略） */
function parseSseLine(rawLine: string): string | typeof DONE | typeof UPSTREAM_ERROR | null {
  const line = rawLine.trim();
  if (!line || line.startsWith(":")) return null; // 空行、keep-alive 注释
  if (!line.startsWith("data:")) return null; // event:/id:/retry: 等

  const payload = line.slice(5).trim();
  if (!payload) return null;
  if (payload === "[DONE]") return DONE;

  try {
    const data = JSON.parse(payload) as {
      choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
      error?: { message?: string };
    };
    // 上游错误帧必须上报：吃完一半正文再来一个 error 帧（限流/内容审查/超上下文）时，
    // 静默忽略会让「截断的笔记」被当成功落库。
    if (data.error) return UPSTREAM_ERROR;
    const choice = data.choices?.[0];
    const content = choice?.delta?.content ?? choice?.message?.content;
    return typeof content === "string" && content.length > 0 ? content : null;
  } catch {
    return null; // 无法解析的帧直接跳过
  }
}

/** 从 Void env 取出 LLM 所需配置（保持与调用逻辑解耦，便于测试） */
export function llmEnvFromVoid(): LLMEnv {
  return {
    MAGPIE_BASE_URL: asStr(env.MAGPIE_BASE_URL),
    MAGPIE_API_KEY: asStr(env.MAGPIE_API_KEY),
    MAGPIE_MODEL: asStr(env.MAGPIE_MODEL),
  };
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
