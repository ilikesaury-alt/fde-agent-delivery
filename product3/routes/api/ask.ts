/**
 * POST /api/ask —— 问答（SSE 流式，支持多轮会话）
 *
 * 请求体：{ question: string, conversationId?: string }
 *
 * SSE 事件（协议与产品② 一致，便于前端复用消费逻辑）：
 *   step  { step, status, detail? }   embed / retrieve / generate 的状态
 *   token { text }                    回答增量
 *   done  { result, conversationId, messageId?, qaId?, persisted, warning? }
 *   error { phase, message }          用户可读错误（不泄露堆栈）
 *
 * 多轮（CONTEXT D18）：
 *   - 有 conversationId → 读该会话最近几轮，按**规则**把指代式追问改写成可检索的查询；
 *   - 无 conversationId → 自动建会话（标题取首问），单轮行为与一期一致；
 *   - 历史只进生成 prompt 的「指代理解」块，**不构成回答依据**（防跨轮幻觉继承）。
 *
 * 防幻觉两条防线都在这里体现：
 *   ① 检索两道闸都不过 → 直接拒答（不调用模型）
 *   ② 模型输出 INSUFFICIENT_EVIDENCE → 转拒答（不让它自由发挥）
 *
 * 状态码：401 令牌 · 400 请求非法 · 404 会话不存在 · 503 未配置上游
 * ⚠️ 一旦 eventStream 开流，后续只能发 error 事件，不能再返回 HTTP 状态码。
 */

import { eventStream } from "void/sse";
import { defineHandler } from "void";

import { buildCitations, buildMessages, isInsufficient, stripMarkers } from "../../lib/answer.ts";
import { buildContextBlock, buildRetrievalQuery, buildTitle } from "../../lib/conversation.ts";
import { embedOne } from "../../lib/embed.ts";
import { ERR } from "../../lib/errors.ts";
import {
  authorize,
  jsonResponse,
  resolveAi,
  resolveFlags,
  resolveIndex,
  resolveRepo,
  resolveRetrieveOptions,
  resolveEnv,
  type RouteCtx,
} from "../../lib/http.ts";
import { MissingConfigError, streamLLM } from "../../lib/llm.ts";
import { retrieve, type RetrieveResult } from "../../lib/retrieve.ts";
import type { AskResult, Conversation, ConversationMessage } from "../../lib/types.ts";
import type { Repo } from "../../lib/repo.ts";
import type { HistoryTurn } from "../../lib/conversation.ts";

/** 拒答时的统一措辞（前端口径不能漂） */
export const REFUSAL_TEXT = "知识库中未找到足以回答该问题的依据。";

/**
 * 「刚导入的文档可能还在索引中」的判定窗口。
 * Vectorize 的 upsert 是异步的：线上实测导入后 0–40 秒必拒答，第 50 秒才命中；
 * 另有一次观测 10 余秒即可检索。取 90 秒留余量（跨环境可能更慢）。
 */
export const INDEXING_HINT_WINDOW_MS = 90_000;

/** 问题长度上限（远超正常提问，只为挡住粘贴整篇文档） */
const MAX_QUESTION_CHARS = 2000;
/** 读几轮历史做上下文（多读只是白花 D1 往返，2 轮足够理解指代） */
const HISTORY_READ_LIMIT = 6;

function makeId(prefix: string): string {
  const rand = crypto.getRandomValues(new Uint8Array(6));
  const hex = [...rand].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${Date.now().toString(36)}${hex}`;
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

/** 拒答结果：带「未通过闸但最接近」的片段，帮用户判断是没导入还是问法不对 */
function buildRefusal(r: RetrieveResult, titles: Map<string, string>, indexingRecently: boolean): AskResult {
  return {
    answer: REFUSAL_TEXT,
    citations: [],
    refused: true,
    indexingRecently: indexingRecently || undefined,
    nearest: r.nearest.map((h) => {
      const keywordOnly = h.sources?.includes("keyword") && !h.sources?.includes("vector");
      return {
        chunkId: h.chunk.id,
        docTitle: titles.get(h.chunk.docId) ?? "未命名文档",
        headingPath: h.chunk.headingPath,
        snippet: h.chunk.text.replace(/\s+/g, " ").trim().slice(0, 160),
        score: h.score,
        matchedBy: keywordOnly ? ("keyword" as const) : ("vector" as const),
        coverage: h.coverage,
      };
    }),
  };
}

/**
 * 库内是否有「刚刚写完索引」的文档。
 * 只用于给拒答加一句可行动的解释，读写失败一律当作 false（不能因为提示失败把问答弄挂）。
 */
async function hasRecentIndexing(repo: Repo): Promise<boolean> {
  try {
    const docs = await repo.listDocuments(20);
    const now = Date.now();
    return docs.some((d) => d.indexedAt != null && now - d.indexedAt < INDEXING_HINT_WINDOW_MS);
  } catch {
    return false;
  }
}

/**
 * 会话历史（时间正序；Repo 返回倒序）。
 *
 * 锚点用 **retrievalQuery**（改写后的查询）而不是原始问题：
 * 否则第三轮起改写会退化 ——「X 是什么」→「它呢」（锚点=它呢）→「还有吗」
 * 拼出来的查询是「它呢 还有吗」，实体词全丢（cross-review 发现 #7）。
 */
async function loadHistory(repo: Repo, conversationId: string): Promise<HistoryTurn[]> {
  const recent = await repo.listMessages(conversationId, HISTORY_READ_LIMIT);
  return recent
    .slice()
    .reverse()
    .map((m) => ({ question: m.retrievalQuery?.trim() || m.question, answer: m.result?.answer ?? "" }));
}

type PersistOutcome = { persisted: boolean; conversationId: string; messageId: string };

/**
 * 落库一轮问答。
 *
 * 顺序：先确保会话存在 → 再写消息 → 最后刷新 updatedAt。
 * 任一步失败都只把 persisted=false 返回给前端（答案已经流式看到了，不能因为落库失败撤回）。
 * 不做 qa_history 双写（CONTEXT D23：单写 messages，避免两套真源分叉）。
 */
async function persistTurn(
  repo: Repo,
  params: {
    conversation: Conversation | null;
    question: string;
    result: AskResult;
    retrievalQuery: string;
  },
): Promise<PersistOutcome> {
  const now = Date.now();
  const messageId = makeId("msg");
  let conversation = params.conversation;
  /** 本次是否新建了会话：写入失败时要把它回滚掉，别留「标题=问题、轮数=0」的幽灵会话 */
  let createdHere = false;
  try {
    if (!conversation) {
      conversation = {
        id: makeId("conv"),
        title: buildTitle(params.question),
        turnCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      await repo.insertConversation({
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
      });
      createdHere = true;
    } else {
      // 会话可能是并发删除的另一端：写消息前回查一次（cross-review 发现 #1）
      const still = await repo.getConversation(conversation.id);
      if (!still) throw new Error("conversation 已在别处删除");
    }

    const record: ConversationMessage = {
      id: messageId,
      conversationId: conversation.id,
      question: params.question,
      result: params.result,
      citedDocIds: [...new Set(params.result.citations.map((x) => x.docId))],
      refused: params.result.refused,
      retrievalQuery: params.retrievalQuery,
      createdAt: now,
    };
    await repo.insertMessage(record);
    await repo.updateConversation(conversation.id, { updatedAt: now });
    return { persisted: true, conversationId: conversation.id, messageId };
  } catch {
    if (createdHere && conversation) {
      // 回滚刚建的空会话（best-effort：失败也不影响「未保存」的结论）
      await repo.deleteConversation(conversation.id).catch(() => {});
      return { persisted: false, conversationId: "", messageId: "" };
    }
    // 已有会话：保留 id，前端至少能继续在这个会话里追问
    return { persisted: false, conversationId: conversation?.id ?? "", messageId: "" };
  }
}

function retrievalDetail(r: RetrieveResult, rewritten: boolean): string {
  const parts = [
    `命中 ${r.hits.length} 段（阈值 ${r.minScore}，top-k ${r.topK}，向量 ${r.vectorHits} 段 / 关键词 ${r.keywordHits} 段）`,
  ];
  if (rewritten) parts.push("检索查询已按上下文改写");
  return parts.join("，");
}

export const POST = defineHandler(async (c) => {
  const env = resolveEnv(c);

  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  let body: { question?: unknown; conversationId?: unknown };
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
  const flags = resolveFlags(c);
  const ctx = c as RouteCtx;

  // 会话归属校验：给了 id 就必须真存在（单用户令牌，不做 owner 校验但要挡掉幽灵 id）
  const requestedId = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
  let conversation: Conversation | null = null;
  if (requestedId) {
    conversation = await repo.getConversation(requestedId);
    if (!conversation) return jsonResponse(404, { error: ERR.conversationNotFound });
  }

  return eventStream(
    async (stream) => {
      try {
        const history = conversation ? await loadHistory(repo, conversation.id) : [];
        const { query: retrievalQuery, rewritten } = buildRetrievalQuery(
          question,
          history,
          flags.contextRewrite,
        );

        // ── step 1: 查询嵌入（多轮时嵌的是改写后的查询）──────────────────
        await stream.send({
          event: "step",
          data: { step: "embed", status: "started", detail: rewritten ? `检索查询：${retrievalQuery}` : undefined },
        });
        let qv: number[];
        try {
          qv = await embedOne(ai, retrievalQuery);
        } catch (e) {
          const code = (e as { code?: string }).code;
          await stream.send({
            event: "error",
            data: { phase: "embed", message: code === "quota" ? ERR.embedQuota : ERR.embedFailed },
          });
          return;
        }
        await stream.send({ event: "step", data: { step: "embed", status: "done" } });

        // ── step 2: 检索（向量 + 关键词融合）+ 阈值拒答 ──────────────────
        await stream.send({ event: "step", data: { step: "retrieve", status: "started" } });
        const retrieved = await retrieve({ queryVector: qv, query: retrievalQuery }, { repo, index }, opts);
        await stream.send({
          event: "step",
          data: { step: "retrieve", status: "done", detail: retrievalDetail(retrieved, rewritten) },
        });

        if (!retrieved.hits.length) {
          const titles = await loadTitles(repo, retrieved.nearest.map((h) => h.chunk.docId));
          const refusal: AskResult = {
            ...buildRefusal(retrieved, titles, await hasRecentIndexing(repo)),
            retrievalQuery,
            rewritten,
          };
          const saved = await persistTurn(repo, { conversation, question, result: refusal, retrievalQuery });
          await stream.send({
            event: "done",
            data: {
              result: refusal,
              conversationId: saved.conversationId || conversation?.id || "",
              messageId: saved.messageId || undefined,
              qaId: saved.messageId || undefined,
              persisted: saved.persisted,
              warning: saved.persisted ? undefined : "问答记录未保存。",
            },
          });
          return;
        }

        // ── step 3: grounded 生成（流式，带「只用于理解指代」的历史块）────
        await stream.send({ event: "step", data: { step: "generate", status: "started" } });
        const messages = buildMessages(question, retrieved.hits, buildContextBlock(history) || undefined);

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
          result = { ...buildRefusal(retrieved, titles, await hasRecentIndexing(repo)), retrievalQuery, rewritten };
        } else {
          result = {
            answer: stripMarkers(answer),
            citations: buildCitations(answer, retrieved.hits, titles),
            refused: false,
            retrievalQuery,
            rewritten,
          };
        }

        // ── step 5: 落库（失败不影响已看到的结果）──────────────────────
        const saved = await persistTurn(repo, { conversation, question, result, retrievalQuery });
        await stream.send({
          event: "done",
          data: {
            result,
            conversationId: saved.conversationId || conversation?.id || "",
            messageId: saved.messageId || undefined,
            qaId: saved.messageId || undefined,
            persisted: saved.persisted,
            warning: saved.persisted ? undefined : "问答记录未保存，请自行复制留存。",
          },
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