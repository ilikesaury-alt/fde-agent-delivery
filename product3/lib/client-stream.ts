/**
 * 客户端 SSE 消费（/api/ask）。
 *
 * 不用 EventSource：请求是 POST 且要带 Authorization 头，
 * EventSource 只支持 GET 且不能自定义头。所以手写 fetch + ReadableStream。
 *
 * 三条硬性保证（都来自踩过的坑）：
 *  - **空闲超时**：完全无事件超过阈值就中止，否则「上游卡住」会让用户无限等待
 *  - **必须有终态**：流结束却没收到 done/error 时必须回调 onError，
 *    否则调用方会永远停在「生成中」
 *  - **必须消费完响应流**：中途 return 不清空 reader 会让连接悬着
 */

export type StepName = "embed" | "retrieve" | "generate";
export type StepStatus = "started" | "done" | "failed";

export type StepState = { step: StepName; status: StepStatus; detail?: string };

/**
 * 引用 / 拒答 / 问答结果的类型**只从 lib/types.ts 出**。
 * 这里曾各写一份，与 lib/types.ts 的 AskResult 分头演化：
 * 加了 indexingRecently 后就出现「运行时字段存在、类型里没有」。
 */
export type { AskResult, Citation, NearestHit } from "./types.ts";
import type { AskResult } from "./types.ts";

export type AskDonePayload = {
  result: AskResult;
  /** 本轮所属会话（二期多轮：首次提问由服务端创建） */
  conversationId?: string;
  messageId?: string;
  /** 兼容旧字段（= messageId） */
  qaId?: string;
  persisted: boolean;
  warning?: string;
};

export type AskHandlers = {
  onStep?: (s: StepState) => void;
  onToken?: (text: string) => void;
  onDone?: (payload: AskDonePayload) => void;
  onError?: (payload: { phase?: string; message: string }) => void;
};

const IDLE_TIMEOUT_MS = 90_000;

export async function consumeAskStream(
  question: string,
  token: string,
  handlers: AskHandlers,
  options: { signal?: AbortSignal; idleTimeoutMs?: number; conversationId?: string | null } = {},
): Promise<void> {
  const controller = new AbortController();
  const external = options.signal;
  const onExternalAbort = () => controller.abort();
  external?.addEventListener("abort", onExternalAbort);

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;

  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), options.idleTimeoutMs ?? IDLE_TIMEOUT_MS);
  };
  const disarmIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  /** 保证只回调一次终态 */
  const finish = (fn: () => void) => {
    if (settled) return;
    settled = true;
    disarmIdle();
    fn();
  };

  try {
    armIdle();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;

    const res = await fetch("/api/ask", {
      method: "POST",
      headers,
      body: JSON.stringify(options.conversationId ? { question, conversationId: options.conversationId } : { question }),
      signal: controller.signal,
    });

    if (!res.ok) {
      let message = "问答失败，请稍后重试。";
      try {
        const body = (await res.json()) as { error?: string };
        if (body?.error) message = body.error;
      } catch {
        // 非 JSON 错误体：用兜底文案
      }
      finish(() => handlers.onError?.({ message }));
      return;
    }
    if (!res.body) {
      finish(() => handlers.onError?.({ message: "浏览器不支持流式响应。" }));
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle();
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const evt = parseBlock(block);
        if (!evt) continue;
        dispatch(evt, handlers, finish);
      }
    }

    // 流结束但没拿到终态：必须报错，不能让 UI 一直转圈
    finish(() => handlers.onError?.({ message: "连接中断，未收到完整回答，请重试。" }));
  } catch (e) {
    const aborted = (e as { name?: string })?.name === "AbortError";
    finish(() =>
      handlers.onError?.({
        message: aborted
          ? external?.aborted
            ? "已取消。"
            : "等待超时，请重试。"
          : "网络异常，请检查连接后重试。",
      }),
    );
  } finally {
    disarmIdle();
    external?.removeEventListener("abort", onExternalAbort);
  }
}

type ParsedEvent = { event: string; data: Record<string, unknown> };

function parseBlock(block: string): ParsedEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const raw of block.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith(":")) continue; // 注释/keepAlive
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> };
  } catch {
    return null;
  }
}

function dispatch(evt: ParsedEvent, handlers: AskHandlers, finish: (fn: () => void) => void): void {
  if (evt.event === "step") {
    const s = evt.data as unknown as StepState;
    handlers.onStep?.(s);
    return;
  }
  if (evt.event === "token") {
    const text = (evt.data as { text?: string }).text ?? "";
    if (text) handlers.onToken?.(text);
    return;
  }
  if (evt.event === "done") {
    const d = evt.data as unknown as AskDonePayload;
    finish(() => handlers.onDone?.(d));
    return;
  }
  if (evt.event === "error") {
    const d = evt.data as { phase?: string; message?: string };
    finish(() => handlers.onError?.({ phase: d.phase, message: d.message ?? "问答失败，请稍后重试。" }));
  }
}
