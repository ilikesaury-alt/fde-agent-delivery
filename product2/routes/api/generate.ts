/**
 * POST /api/generate  —— 流水线入口（SSE）
 *
 * 请求体：
 *   { sourceType: "url", url: string, variation?: boolean }
 *   { sourceType: "text", text: string, variation?: boolean }
 *
 * SSE 事件：
 *   step  { step, status, detail }   抓取/准备/生成 的状态
 *   token { text }                   正文增量
 *   done  { job, persisted, warning? }  完整笔记 + jobId
 *   error { phase, message, hint? }  用户可读错误（不泄露堆栈）
 *
 * 状态码约定（流未开始时用 HTTP 状态码，开流后只能走 error 事件）：
 *   401 令牌缺失/错误 · 400 请求体非法 · 503 未配置上游
 */

import { eventStream } from "void/sse";
import { defineHandler } from "void";

import { callLLM, streamLLM, MissingConfigError } from "../../lib/llm.ts";
import { fetchArticle, FetchArticleError } from "../../lib/fetch-article.ts";
import { authorize, jsonResponse, resolveEnv, resolveStore, type RouteCtx } from "../../lib/http.ts";
import { runPipeline, PipelineError, HARD_CAP, type PipelineDeps } from "../../lib/pipeline.ts";
import type { PipelineEvent } from "../../lib/types.ts";

/** 组装流水线依赖。测试通过 ctx._deps 局部覆盖。 */
export function buildDeps(c: unknown, fetchImplOverride?: typeof fetch): PipelineDeps {
  const ctx = c as RouteCtx;
  const e = resolveEnv(c);
  const fetchImpl = fetchImplOverride ?? ctx._fetchImpl ?? fetch;
  return {
    fetchArticle: (url) => fetchArticle(url, { fetchImpl }),
    callLLM: (messages) => callLLM(e, messages, { fetchImpl, temperature: 0.3 }),
    streamLLM: (messages) => streamLLM(e, messages, { fetchImpl, temperature: 0.7 }),
    ...(ctx as RouteCtx & { _deps?: Partial<PipelineDeps> })._deps,
  };
}

export const POST = defineHandler(async (c) => {
  const env = resolveEnv(c);

  // ① 令牌（验收标准 10）
  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  // ② 请求体
  let body: { sourceType?: unknown; url?: unknown; text?: unknown; variation?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return jsonResponse(400, { error: "请求体必须是 JSON。" });
  }

  const sourceType = body.sourceType === "url" ? "url" : body.sourceType === "text" ? "text" : null;
  if (!sourceType) {
    return jsonResponse(400, { error: "缺少 sourceType（url 或 text）。" });
  }
  const url = typeof body.url === "string" ? body.url.trim() : "";
  const text = typeof body.text === "string" ? body.text : "";
  // 前置大小闸：别让数 MB 文本先进内存再在流水线里被拒（HARD_CAP 口径一致）
  if (text.length > HARD_CAP) {
    return jsonResponse(400, {
      error: `素材过长（${text.length.toLocaleString("zh-CN")} 字，上限 ${HARD_CAP.toLocaleString("zh-CN")} 字），请截取重点后重试。`,
    });
  }
  if (sourceType === "url" && !url) {
    return jsonResponse(400, { error: "请提供要抓取的链接。" });
  }
  if (sourceType === "text" && !text.trim()) {
    return jsonResponse(400, { error: "请先粘贴素材文本。" });
  }

  // ③ 上游未配置 → 明确错误（验收标准 9，不泄露堆栈）
  if (!env.MAGPIE_BASE_URL || !env.MAGPIE_API_KEY) {
    return jsonResponse(503, { error: new MissingConfigError().message });
  }

  const store = resolveStore(c);
  const deps = buildDeps(c);

  return eventStream(
    async (stream) => {
      const emit = async (e: PipelineEvent) => {
        if (e.type === "step") {
          await stream.send({ event: "step", data: e });
        } else {
          await stream.send({ event: "token", data: e });
        }
      };

      try {
        const { job, warnings } = await runPipeline(
          { sourceType, url, text, variation: body.variation === true },
          deps,
          emit,
        );

        // 落库时机 = 流水线成功之后（失败/中断不产生半截记录）
        try {
          await store.insert(job);
        } catch {
          // 存储失败不应吞掉用户已看到的结果：笔记照常返回，但明确告知未保存
          await stream.send({
            event: "done",
            data: {
              job,
              persisted: false,
              warning: "笔记已生成，但历史记录保存失败，请自行复制留存。",
              warnings,
            },
          });
          return;
        }

        await stream.send({ event: "done", data: { job, persisted: true, warnings } });
      } catch (err) {
        const phase = err instanceof PipelineError ? err.phase : "generate";
        const message =
          err instanceof PipelineError || err instanceof FetchArticleError
            ? err.message
            : "生成失败，请稍后重试。";

        // 抓取失败是「可以换方式重试」的错误，附带引导
        const hint =
          phase === "fetch" ? "也可以切换到「粘贴文本」模式，把正文复制进来生成。" : undefined;

        await stream.send({ event: "error", data: { phase, message, hint } });
      } finally {
        // 显式关闭：void/sse 的 keepAlive 定时器在部分收尾路径（早退/写失败）不会被清理，
        // 不关就会在 Worker isolate 里留下永久 interval。close() 是幂等的。
        await stream.close().catch(() => {});
      }
    },
    { headers: { "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" } },
  );
});
