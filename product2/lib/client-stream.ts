/**
 * 客户端 SSE 消费。
 *
 * 为什么不用 EventSource：流水线是 POST + 需要 Authorization 头，
 * EventSource 只支持 GET 且不能自定义头。所以用 fetch + ReadableStream 手写读取。
 * （Void 的 void/sse/client 的 connectEventStream 同样是 GET 语义，不适用。）
 *
 * 解析规则与 lib/llm.ts 一致：跨 chunk 缓冲到 "\n\n" 再切事件块。
 *
 * 关键保证（都是踩过的坑）：
 *  - 空闲超时：上游首 token 可能要 15s+，但**完全无事件**超过阈值就要中止，
 *    否则「抓取卡住/网络半断」会让用户无限等待（验收 4）。
 *  - 必须有终态：流结束却没收到 done/error 时，必须回调 onError，
 *    否则调用方会永远停在「生成中」。
 */

export type StepName = "fetch" | "prepare" | "generate";

export type StepState = {
  step: StepName;
  status: "started" | "done" | "failed" | "skipped";
  detail?: string;
};

export type DonePayload = { job: unknown; persisted: boolean; warning?: string; warnings?: string[] };

export type StreamHandlers = {
  onStep?: (s: StepState) => void;
  onToken?: (text: string) => void;
  onDone?: (payload: DonePayload) => void;
  onError?: (payload: { phase?: string; message: string; hint?: string }) => void;
};

/** 无任何事件多久后放弃（step 事件在流水线开始时就会来，故只可能卡在「开始前」或「生成中」） */
const IDLE_TIMEOUT_MS = 90_000;

/** 读取 SSE 流；Promise resolve 表示流已结束（无论成功或已通过 onError 报过错） */
export async function consumeGenerateStream(
  body: { sourceType: "url" | "text"; url?: string; text?: string; variation?: boolean },
  token: string,
  handlers: StreamHandlers,
  options: { signal?: AbortSignal; idleTimeoutMs?: number } = {},
): Promise<void> {
  const controller = new AbortController();
  const external = options.signal;
  const onExternalAbort = () => controller.abort();
  external?.addEventListener("abort", onExternalAbort);

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  const idleMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;

  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    if (idleTimer) clearTimeout(idleTimer);
    fn();
  };

  const bumpIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      settle(() => {
        controller.abort();
        handlers.onError?.({
          message: "等待响应超时，请重试或改用「粘贴文本」。",
        });
      });
    }, idleMs);
  };

  try {
    bumpIdle();

    const resp = await fetch("/api/generate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      // 开流前的错误是 JSON（401/400/503）
      let message = "请求失败，请稍后重试。";
      try {
        const data = (await resp.json()) as { error?: string };
        if (data.error) message = data.error;
      } catch {
        /* 保持兜底文案 */
      }
      settle(() => handlers.onError?.({ message }));
      return;
    }

    if (!resp.body) {
      settle(() => handlers.onError?.({ message: "浏览器不支持流式响应，请更换浏览器。" }));
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const dispatch = (event: string, data: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        // 单帧损坏不应该悄悄吞掉：整条流的内容已经不可信
        settle(() => handlers.onError?.({ message: "响应内容异常，请重试。" }));
        return;
      }
      if (event === "step") handlers.onStep?.(parsed as StepState);
      else if (event === "token") handlers.onToken?.((parsed as { text: string }).text);
      else if (event === "done") settle(() => handlers.onDone?.(parsed as DonePayload));
      else if (event === "error")
        settle(() => handlers.onError?.(parsed as { phase?: string; message: string; hint?: string }));
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bumpIdle();
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        let event = "message";
        const dataLines: string[] = [];
        for (const rawLine of block.split("\n")) {
          const line = rawLine.replace(/\r$/, "");
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length) dispatch(event, dataLines.join("\n"));
        if (settled) {
          await reader.cancel().catch(() => {});
          return;
        }
      }
    }

    // 流结束但没有终态 → 视为异常结束（否则界面永远停在「生成中」）
    settle(() =>
      handlers.onError?.({ message: "连接中断，结果可能不完整，请重试。" }),
    );
  } catch {
    if (external?.aborted) return; // 用户主动取消：不算错误
    settle(() => handlers.onError?.({ message: "网络异常，请检查连接后重试。" }));
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    external?.removeEventListener("abort", onExternalAbort);
  }
}
