/**
 * LLM 接入 — 经 magpie 中转（OpenAI 兼容 /chat/completions）
 * 密钥只从 Void env 读，绝不进前端、绝不写死。
 */

import { env } from "void/env";

import { wrapTranscript } from "./prompt.ts";

/** magpie 未配置/配置不完整时抛出，文案面向终端用户（验收标准 7） */
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

function assertConfigured(e: LLMEnv): void {
  if (!e.MAGPIE_BASE_URL || !e.MAGPIE_API_KEY) {
    throw new MissingConfigError();
  }
}

/**
 * 调用 magpie 中转生成会议日报。
 * 用 OpenAI 兼容协议；失败统一转成 LLMError，避免把上游堆栈/响应体泄露给前端。
 */
export async function callLLM(
  e: LLMEnv,
  systemPrompt: string,
  userText: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  assertConfigured(e);

  const base = String(e.MAGPIE_BASE_URL).replace(/\/+$/, "");
  const model = e.MAGPIE_MODEL || "deepseek-chat";

  const controller = new AbortController();
  // 85s：实测真实模型生成完整 6 板块日报约 26–36s（含推理 tokens），25s 会误杀正常请求。
  // Workers 的 CPU 限制不包含 fetch 等待时间，墙钟不受限；与前端 90s 超时对齐，让后端错误 JSON 先返回。
  const timeout = setTimeout(() => controller.abort(), 85_000);

  try {
    const resp = await fetchImpl(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${e.MAGPIE_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        // 显式关闭流式：若中转默认走 SSE，resp.json() 会解析失败并被误报为服务不可用
        stream: false,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: wrapTranscript(userText) },
        ],
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      // 只按状态码给友好文案，不把上游响应体带回前端
      if (resp.status === 401 || resp.status === 403) {
        throw new LLMError("AI 服务凭据无效，请检查配置后重试。");
      }
      if (resp.status === 429) {
        throw new LLMError("请求过于频繁，请稍后再试。");
      }
      throw new LLMError();
    }

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new LLMError("AI 返回结果为空，请重试或调整输入内容。");
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

/** 从 Void env 取出 LLM 所需配置（保持与 callLLM 解耦，便于测试） */
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
