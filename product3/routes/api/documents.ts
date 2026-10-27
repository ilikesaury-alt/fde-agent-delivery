/**
 * /api/documents —— 文档管理
 *
 *   GET    /api/documents              列表（倒序，不含正文）
 *   POST   /api/documents              导入（粘贴 / 上传文本 / PDF 抽取文本 / URL）
 *   DELETE /api/documents?id=<id>      删除（连带清理向量）
 *
 * POST 请求体：
 *   { source: "paste" | "file" | "pdf", text: string, title?: string, sourceRef?: string }
 *   { source: "url", url: string, title?: string }
 *
 * 状态码：401 令牌 · 400 请求非法 · 404 不存在 · 413 超限 · 429 配额 · 409 容量 · 502 索引失败
 *
 * 删除顺序（cross-review N1）：**先删向量，再删 D1 行**。
 * 反过来的话向量删失败时文档已经没了，用户「重试」只会拿到 404 → 孤儿向量永久占 top-k 槽位。
 */

import { defineHandler } from "void";

import { ERR } from "../../lib/errors.ts";
import { fetchArticle, FetchArticleError } from "../../lib/fetch-article.ts";
import {
  authorize,
  jsonResponse,
  resolveAi,
  resolveIndex,
  resolveRepo,
  resolveRetrieveOptions,
  type RouteCtx,
} from "../../lib/http.ts";
import { IngestError, ingest, MAX_DOC_CHARS } from "../../lib/ingest.ts";
import type { IngestDeps } from "../../lib/ingest.ts";
import type { DocSource } from "../../lib/types.ts";

function buildDeps(c: unknown): IngestDeps {
  return { repo: resolveRepo(c), index: resolveIndex(c), ai: resolveAi(c) };
}

export const GET = defineHandler(async (c) => {
  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  try {
    const documents = await resolveRepo(c).listDocuments(100);
    const totalChunks = documents.reduce((s, d) => s + d.chunkCount, 0);
    return jsonResponse(200, { documents, totalChunks, retrieve: resolveRetrieveOptions(c) });
  } catch {
    return jsonResponse(500, { error: ERR.docListFailed });
  }
});

export const POST = defineHandler(async (c) => {
  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  let body: {
    source?: unknown;
    text?: unknown;
    url?: unknown;
    title?: unknown;
    sourceRef?: unknown;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return jsonResponse(400, { error: ERR.badJson });
  }

  const source = body.source;
  if (source !== "paste" && source !== "file" && source !== "pdf" && source !== "url") {
    return jsonResponse(400, { error: ERR.sourceInvalid });
  }

  const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";

  // AI 绑定缺失时尽早 503（而不是走到 ingest 里 undefined.run 抛 500）
  if (!(c as RouteCtx)._ai && !(c as RouteCtx).env?.AI) {
    return jsonResponse(503, { error: ERR.aiBindingMissing });
  }

  // ---- URL：抓取（含 SSRF 三道闸）由上游完成，之后走同一条文本管道 ----
  if (source === "url") {
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!url) return jsonResponse(400, { error: ERR.missingField("url") });
    try {
      const ctx = c as RouteCtx;
      const fetched = await fetchArticle(url, { fetchImpl: ctx._fetchImpl ?? fetch });
      return await runIngest(c, {
        source: "url",
        sourceRef: url,
        title: title || fetched.title,
        text: fetched.text,
      });
    } catch (e) {
      if (e instanceof FetchArticleError) {
        const status = e.code === "blocked_host" || e.code === "invalid_url" ? 400 : 502;
        return jsonResponse(status, { error: e.message });
      }
      if (e instanceof IngestError) return ingestErrorResponse(e);
      console.warn(`[documents] url fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      return jsonResponse(502, { error: ERR.urlFetchFailed });
    }
  }

  // ---- 文本类（粘贴 / 文件 / PDF 前端抽取后的纯文本）----
  const text = typeof body.text === "string" ? body.text : "";
  if (!text.trim()) return jsonResponse(400, { error: ERR.emptyText });
  if (text.length > MAX_DOC_CHARS) return jsonResponse(413, { error: ERR.tooLong(text.length, MAX_DOC_CHARS) });

  const sourceRef =
    typeof body.sourceRef === "string" && body.sourceRef.trim() ? body.sourceRef.trim().slice(0, 500) : null;
  const fallbackTitle = sourceRef ?? "粘贴的文本";

  return runIngest(c, {
    source: source as DocSource,
    sourceRef,
    title: title || fallbackTitle,
    text,
  });
});

export const DELETE = defineHandler(async (c) => {
  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  const id = new URL(c.req.url).searchParams.get("id");
  if (!id) return jsonResponse(400, { error: ERR.missingField("id") });

  try {
    const repo = resolveRepo(c);
    const index = resolveIndex(c);
    const doc = await repo.getDocument(id);
    if (!doc) return jsonResponse(404, { error: ERR.docNotFound });

    // 先算要删的 chunk（此时 D1 还在），再删向量，最后删 D1 行。
    const chunks = await repo.listChunksByDoc(id);
    const chunkIds = chunks.map((x) => x.id);

    try {
      await index.deleteByIds(chunkIds);
    } catch (e) {
      // 向量没删掉就不能动 D1：保留文档，用户重试才有意义（N1）
      console.warn(`[documents] vector delete failed: ${e instanceof Error ? e.message : String(e)}`);
      return jsonResponse(502, { error: "删除失败（索引清理未成功），请重试。" });
    }

    const removed = await repo.deleteDocument(id);
    if (removed.length && removed.length !== chunkIds.length) {
      console.warn(`[documents] chunk count drift: d1=${removed.length} listed=${chunkIds.length}`);
    }

    // 删除后断言：残留向量会让检索引用到不存在的 chunk
    if (chunkIds.length) {
      const leftover = await index.existing(chunkIds);
      if (leftover.length) {
        return jsonResponse(500, { error: ERR.docDeleteVectorLeft(leftover.length) });
      }
    }
    return jsonResponse(200, { ok: true, removedChunks: chunkIds.length });
  } catch (e) {
    console.warn(`[documents] delete failed: ${e instanceof Error ? e.message : String(e)}`);
    return jsonResponse(500, { error: ERR.docDeleteFailed });
  }
});

async function runIngest(
  c: unknown,
  input: { source: DocSource; sourceRef: string | null; title: string; text: string },
): Promise<Response> {
  try {
    const result = await ingest(buildDeps(c), input);
    return jsonResponse(result.skipped ? 200 : 201, {
      document: result.document,
      skipped: result.skipped,
      replaced: result.replaced,
      message: result.skipped ? "该文档内容已在库中，已跳过重复导入。" : undefined,
    });
  } catch (e) {
    if (e instanceof IngestError) return ingestErrorResponse(e);
    const name = e instanceof Error ? e.name : "";
    if (name === "EmbedError") {
      const code = (e as unknown as { code?: string }).code;
      const message = e instanceof Error ? e.message : ERR.embedFailed;
      return jsonResponse(code === "quota" ? 429 : 502, { error: message });
    }
    // 内部错误只写日志，不透传原始 message（N4）
    console.warn(`[documents] ingest failed: ${e instanceof Error ? e.message : String(e)}`);
    return jsonResponse(502, { error: ERR.indexWriteFailed });
  }
}

function ingestErrorResponse(e: IngestError): Response {
  const status =
    e.code === "too_long" || e.code === "too_many_chunks" ? 413 : e.code === "library_full" ? 409 : 400;
  return jsonResponse(status, { error: e.message });
}
