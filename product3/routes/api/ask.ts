/**
 * POST /api/ask —— 问答（SSE 流式）
 *
 * 请求体：{ question: string }
 *
 * SSE 事件（协议与产品② 一致，便于前端复用消费逻辑）：
 *   step  { step, status, detail? }   embed / retrieve / generate 的状态
 *   token { text }                    回答增量
 *   done  { result, qaId?, persisted, warning? }  AskResult（含 citations / refused）
 *   error { phase, message }          用户可读错误（不泄露堆栈）
 *
 * 防幻觉两条防线都在这里体现：
 *   ① 检索阈值不过 → 直接拒答（不调用模型）
 *   ② 模型输出 INSUFFICIENT_EVIDENCE → 转拒答（不让它自由发挥）
 *
 * 状态码：401 令牌 · 400 请求非法 · 503 未配置上游
 * ⚠️ 一旦 eventStream 开流，后续只能发 error 事件，不能再返回 HTTP 状态码。
 */

import { eventStream } from "void/sse";
import { defineHandler } from "void";

import { buildCitations, buildMessages, isInsufficient, stripMarkers } from "../../lib/answer.ts";
import { embedOne } from "../../lib/embed.ts";
import { ERR } from "../../lib/errors.ts";
import {
  authorize,
  jsonResponse,
  resolveAi,
  resolveIndex,
  resolveRepo,
  resolveRetrieveOptions,
  resolveEnv,
  type RouteCtx,
} from "../../lib/http.ts";
import { MissingConfigError, streamLLM } from "../../lib/llm.ts";
import { retrieve, type RetrieveResult } from "../../lib/retrieve.ts";
import type { AskResult, QaRecord } from "../../lib/types.ts";
import type { Repo } from "../../lib/repo.ts";

/** 拒答时的统一措辞（前端口径不能漂） */
export const REFUSAL_TEXT = "知识库中未找到足以回答该问题的依据。";

/** 问题长度上限（远超正常提问，只为挡住粘贴整篇文档） */
const MAX_QUESTION_CHARS = 2000;

function makeQaId(): string {
  const rand = crypto.getRandomValues(new Uint8Array(6));
  const hex = [...rand].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `qa_${Date.now().toString(36)}${hex}`;
}

/** 批量取文档标题（引用与 nearest 展示用；一次查完，不 N+1） */
async function loadTitles(repo: Repo, docIds: Iterable<string>): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const id of new Set(docIds)) {
    if (map.has(id)) continue;
    const doc = await repo.getDocument(id);
    map.set(id, doc?.title || doc?.sourceRef || "未命名文档");
  }
  return map;
}

/** 拒答结果：带「未通过阈值但最接近」的片段，帮用户判断是没导入还是问法不对 */
function buildRefusal(r: RetrieveResult, titles: Map<string, string>): AskResult {
  return {
    answer: REFUSAL_TEXT,
    citations: [],
    refused: true,
    nearest: r.nearest.map((h) => ({
      chunkId: h.chunk.id,
      docTitle: titles.get(h.chunk.docId) ?? "未命名文档",
      headingPath: h.chunk.headingPath,
      snippet: h.chunk.text.replace(/\s+/g, " ").trim().slice(0, 160),
      score: h.score,
    })),
  };
}

export const POST = defineHandler(async (c) => {
  const env = resolveEnv(c);

  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  let body: { question?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return jsonResponse(400, { error: ERR.badJson });
  }
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return jsonResponse(400, { error: ERR.emptyQuestion });
  if (question.length > MAX_QUESTION_CHARS) return jsonResponse(400, { error: ERR.questionTooLong });

  if (!env.MAGPIE_BASE_URL || !env.MAGPIE_API_KEY) {
    return jsonResponse(503, { error: new MissingConfigError().message });
  }

  const repo = resolveRepo(c);
  const index = resolveIndex(c);
  let ai;
  try {
    ai = resolveAi(c);
  } catch {
    // 绑定缺失是部署配置问题：给明确 503，而不是让框架抛 500
    return jsonResponse(503, { error: ERR.aiBindingMissing });
  }
  const opts = resolveRetrieveOptions(c);
  const ctx = c as RouteCtx;

  return eventStream(
    async (stream) => {
      try {
        // ── step 1: 问题嵌入 ────────────────────────────────────────────
        await stream.send({ event: "step", data: { step: "embed", status: "started" } });
        let qv: number[];
        try {
          qv = await embedOne(ai, question);
        } catch (e) {
          const code = (e as { code?: string }).code;
          await stream.send({
            event: "error",
            data: { phase: "embed", message: code === "quota" ? ERR.embedQuota : ERR.embedFailed },
          });
          return;
        }
        await stream.send({ event: "step", data: { step: "embed", status: "done" } });

        // ── step 2: 检索 + 阈值拒答 ─────────────────────────────────────
        await stream.send({ event: "step", data: { step: "retrieve", status: "started" } });
        const retrieved = await retrieve(qv, { repo, index }, opts);
        await stream.send({
          event: "step",
          data: {
            step: "retrieve",
            status: "done",
            detail: `命中 ${retrieved.hits.length} 段（阈值 ${opts.minScore}，top-k ${opts.topK}）`,
          },
        });

        if (!retrieved.hits.length) {
          const titles = await loadTitles(repo, retrieved.nearest.map((h) => h.chunk.docId));
          const refusal = buildRefusal(retrieved, titles);
          const qaId = makeQaId();
          let persisted = true;
          try {
            await repo.insertQa({ id: qaId, question, result: refusal, citedDocIds: [], createdAt: Date.now() });
          } catch {
            persisted = false;
          }
          await stream.send({
            event: "done",
            data: { result: refusal, qaId, persisted, warning: persisted ? undefined : "问答记录未保存。" },
          });
          return;
        }

        // ── step 3: grounded 生成（流式）────────────────────────────────
        await stream.send({ event: "step", data: { step: "generate", status: "started" } });
        const messages = buildMessages(question, retrieved.hits);

        let answer = "";
        try {
          for await (const delta of streamLLM(env, messages, {
            temperature: 0.2,
            fetchImpl: ctx._fetchImpl ?? fetch,
          })) {
            answer += delta;
            await stream.send({ event: "token", data: { text: delta } });
          }
        } catch (e) {
          const message = e instanceof MissingConfigError ? e.message : ERR.llmFailed;
          await stream.send({ event: "error", data: { phase: "generate", message } });
          return;
        }
        await stream.send({ event: "step", data: { step: "generate", status: "done" } });

        // ── step 4: 引用映射 / 依据不足转拒答 ───────────────────────────
        const titles = await loadTitles(repo, retrieved.hits.map((h) => h.chunk.docId));
        let result: AskResult;
        if (!answer.trim() || isInsufficient(answer)) {
          result = buildRefusal(retrieved, titles);
        } else {
          result = {
            answer: stripMarkers(answer),
            citations: buildCitations(answer, retrieved.hits, titles),
            refused: false,
          };
        }

        // ── step 5: 落库（失败不影响已看到的结果）──────────────────────
        const qaId = makeQaId();
        let persisted = true;
        try {
          const citedDocIds = [...new Set(result.citations.map((x) => x.docId))];
          const record: QaRecord = { id: qaId, question, result, citedDocIds, createdAt: Date.now() };
          await repo.insertQa(record);
        } catch {
          persisted = false;
        }

        await stream.send({
          event: "done",
          data: { result, qaId, persisted, warning: persisted ? undefined : "问答记录未保存，请自行复制留存。" },
        });
      } catch (err) {
        // 兜底：内部错误只写日志，不给用户看原始 message（cross-review N4）
        console.warn(`[ask] unexpected error: ${err instanceof Error ? err.message : String(err)}`);
        await stream.send({ event: "error", data: { phase: "ask", message: ERR.llmFailed } });
      } finally {
        // void/sse 的 keepAlive 定时器在早退/写失败路径不会被自动清理，
        // 不显式 close 会在 isolate 里留下永久 interval（产品② 踩过）。
        await stream.close().catch(() => {});
      }
    },
    { headers: { "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" } },
  );
});
