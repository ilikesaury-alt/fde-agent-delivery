/**
 * 导入管道 —— 文档进库的唯一入口。
 *
 * 状态机：pending → indexing → ready | failed
 *
 * **顺序铁律（B1）**：切分、容量校验、嵌入全部完成后，才允许碰旧文档。
 *   - 若被替换的旧文档是 `ready`：**全程不碰它**，用新 id 写入；新文档 ready 后才删旧的。
 *     这样新内容超限 / 撞配额时，用户至少还有旧版本可问（否则既没有新的也没有旧的）。
 *   - 若旧文档是 `failed`：直接复用同一 id 重试（本来就没有可用内容，引用编号也稳定）。
 *
 * 幂等（D14）：
 *   - 同内容哈希已存在且 ready → 直接跳过（不重复嵌入、不重复扣配额）
 *   - 同来源（URL/文件名）但内容变了 → 整篇替换（成功后删旧）
 *   - 并发同内容（B4）：靠 `documents.content_hash` 唯一索引 + 插入后回查「赢家」转幂等跳过
 *
 * 补偿（B3）：写 D1 chunks / 写向量任一步失败都要回滚已写入部分并置 failed，
 * 不留「D1 有 chunk 但向量没有」或反向的孤儿数据。
 */

import { chunkText } from "./chunk.ts";
import { embedAll } from "./embed.ts";
import type { AILike } from "./embed.ts";
import { ERR } from "./errors.ts";
import { normalizeText, sha256Hex } from "./hash.ts";
import { extractTerms } from "./hybrid.ts";
import { awaitVectorAcceptance, type Repo, type VectorIndex } from "./repo.ts";
import type { Chunk, Document, DocSource } from "./types.ts";

/** 单文档硬上限：太长的文档应拆分导入（也保护 Vectorize 免费额度） */
export const MAX_DOC_CHARS = 200_000;
/** 单文档 chunk 上限 */
export const MAX_DOC_CHUNKS = 400;
/** 知识库总量上限（≈ Vectorize Free 5M 维度 / 1024 维） */
export const MAX_LIBRARY_CHUNKS = 4_000;

export class IngestError extends Error {
  readonly code: "empty" | "too_long" | "too_many_chunks" | "library_full" | "duplicate" | "verify_pending";
  constructor(code: IngestError["code"], message: string) {
    super(message);
    this.name = "IngestError";
    this.code = code;
  }
}

export type IngestDeps = {
  repo: Repo;
  index: VectorIndex;
  ai: AILike;
  /** 回读校验的重试参数（Vectorize 最终一致；测试可调小） */
  verify?: { attempts?: number; baseDelayMs?: number };
};

export type IngestInput = {
  source: DocSource;
  /** URL 或文件名；paste 传 null */
  sourceRef: string | null;
  title: string;
  /** 已经是纯文本（URL 抓取 / PDF 前端抽取都在上游完成） */
  text: string;
};

export type IngestResult = {
  document: Document;
  /** 同内容已存在，未做任何写入 */
  skipped: boolean;
  /** 同来源但内容变化，旧文档被整篇替换 */
  replaced: boolean;
};

let seq = 0;
function newId(prefix: string): string {
  seq = (seq + 1) % 1e6;
  const rand = crypto.getRandomValues(new Uint8Array(6));
  const hex = [...rand].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}${hex}`;
}

export function makeDocId(): string {
  return newId("doc");
}

/** 尽力清理：删 chunk 行 + 删向量。用于失败补偿，自身不抛错。 */
async function cleanupPartial(deps: IngestDeps, docId: string, chunkIds: string[]): Promise<void> {
  try {
    await deps.index.deleteByIds(chunkIds);
  } catch {
    // 向量清理失败由 existing() 巡检兜底；这里不掩盖原始错误
  }
  try {
    await deps.repo.deleteDocument(docId);
  } catch {
    // 同上
  }
}

export async function ingest(deps: IngestDeps, input: IngestInput): Promise<IngestResult> {
  const text = normalizeText(input.text);
  if (!text) throw new IngestError("empty", ERR.emptyText);
  if (text.length > MAX_DOC_CHARS) throw new IngestError("too_long", ERR.tooLong(text.length, MAX_DOC_CHARS));

  const contentHash = await sha256Hex(text);

  // ① 同内容幂等
  const sameContent = await deps.repo.findByHash(contentHash);
  if (sameContent && sameContent.status === "ready") {
    return { document: sameContent, skipped: true, replaced: false };
  }

  // ② 切分 + 容量校验（B1：一律在碰旧文档之前）
  const drafts = chunkText(text);
  if (!drafts.length) throw new IngestError("empty", ERR.emptyText);
  if (drafts.length > MAX_DOC_CHUNKS) {
    throw new IngestError("too_many_chunks", ERR.tooManyChunks(drafts.length, MAX_DOC_CHUNKS));
  }

  const sameRef = input.sourceRef ? await deps.repo.findBySourceRef(input.source, input.sourceRef) : null;

  /**
   * 将被本次写入取代的旧文档：
   *  - 同内容但上次失败/中断 → 可安全复用同一 id（本来就没有可用内容）
   *  - 同来源但内容变了 → 仅当它是 failed 才复用 id；是 ready 则走「新 id + 成功后再删」
   */
  const reusable = (d: Document | null): Document | null => (d && d.status !== "ready" ? d : null);
  const retryTarget = reusable(sameContent) ?? (sameRef && sameRef.contentHash !== contentHash ? reusable(sameRef) : null) ?? reusable(sameRef);
  /** ready 且内容不同的旧文档：成功后才删（真正的「整篇替换」） */
  const replaceTarget =
    sameRef && sameRef.contentHash !== contentHash && sameRef.status === "ready" ? sameRef : null;

  const existingDocs = await deps.repo.listDocuments(MAX_LIBRARY_CHUNKS);
  const reclaimed = new Set<string>([retryTarget?.id, replaceTarget?.id].filter((x): x is string => Boolean(x)));
  const libraryChunks = existingDocs.filter((d) => !reclaimed.has(d.id)).reduce((sum, d) => sum + d.chunkCount, 0);
  if (libraryChunks + drafts.length > MAX_LIBRARY_CHUNKS) {
    throw new IngestError("library_full", ERR.libraryFull(MAX_LIBRARY_CHUNKS));
  }

  // ③ 决定目标 id（此时仍不碰旧文档）
  const targetId = retryTarget?.id ?? makeDocId();
  const createdAt = retryTarget?.createdAt ?? Date.now();
  const replaced = Boolean(replaceTarget);

  // 落一条 pending/indexing 记录。retry 场景下这条本来就是 failed，改动它是安全的。
  if (retryTarget) {
    await deps.repo.updateDocument(targetId, { status: "indexing", error: null, title: input.title, chunkCount: 0 });
  } else {
    try {
      await deps.repo.insertDocument({
        id: targetId,
        source: input.source,
        sourceRef: input.sourceRef,
        title: input.title,
        contentHash,
        createdAt,
      });
      await deps.repo.updateDocument(targetId, { status: "indexing" });
    } catch (e) {
      // 并发导入同一内容：唯一索引挡掉第二次写入（B4）→ 回查赢家，按幂等跳过
      const winner = await deps.repo.findByHash(contentHash);
      if (winner) return { document: winner, skipped: true, replaced: false };
      throw e;
    }
    // 插入后回查：赢家不是自己说明别处已写入同一内容
    const winner = await deps.repo.findByHash(contentHash);
    if (winner && winner.id !== targetId) {
      await cleanupPartial(deps, targetId, []);
      return { document: winner, skipped: true, replaced: false };
    }
  }

  // ④ 嵌入（分批）—— 仍在删除/覆盖旧文档之前
  const now = Date.now();
  const chunks: Chunk[] = drafts.map((d) => ({
    id: `${targetId}:${d.idx}`,
    docId: targetId,
    idx: d.idx,
    headingPath: d.headingPath,
    text: d.text,
    createdAt: now,
  }));

  let vectors: number[][];
  try {
    vectors = await embedAll(
      deps.ai,
      chunks.map((c) => c.text),
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : ERR.embedFailed;
    await deps.repo.updateDocument(targetId, { status: "failed", error: message });
    throw e;
  }

  // ⑤ 收尾：先清重试残留 → 写新（失败才做破坏性补偿）
  try {
    // retry 场景需要先清掉同一 id 下的旧 chunk/向量（它们本就不可用）
    if (retryTarget) {
      const staleIds = (await deps.repo.listChunksByDoc(targetId)).map((c) => c.id);
      if (staleIds.length) {
        await deps.index.deleteByIds(staleIds);
        await deps.repo.deleteDocument(targetId);
        await deps.repo.insertDocument({
          id: targetId,
          source: input.source,
          sourceRef: input.sourceRef,
          title: input.title,
          contentHash,
          createdAt,
        });
        await deps.repo.updateDocument(targetId, { status: "indexing" });
      }
    }

    await deps.repo.insertChunks(chunks);
    // 关键词倒排（二期混合检索）：与 chunk 同批写，失败走同一补偿路径。
    // 每 chunk 只取 tf 最高的 24 个 term（体积约束，见 lib/hybrid.ts）。
    await deps.repo.insertChunkTerms(
      chunks.flatMap((c) => extractTerms(c.text).map((t) => ({ term: t.term, chunkId: c.id, tf: t.tf }))),
    );
    await deps.index.upsert(
      chunks.map((c, i) => ({
        id: c.id,
        values: vectors[i],
        metadata: { docId: c.docId, headingPath: c.headingPath.slice(0, 200) },
      })),
    );
  } catch (e) {
    // 真正的写入失败：D1 或 upsert 抛错 → 补偿清理是安全的（向量确实没进去）
    await cleanupPartial(deps, targetId, chunks.map((c) => c.id));
    const message = e instanceof Error ? e.message : ERR.embedFailed;
    await deps.repo.insertDocument({
      id: targetId,
      source: input.source,
      sourceRef: input.sourceRef,
      title: input.title,
      contentHash,
      createdAt,
    });
    await deps.repo.updateDocument(targetId, { status: "failed", error: message });
    throw new Error(message);
  }

  // ⑥ 写入确认 —— **不等待向量可见**。
  //
  // 线上实测（2026-10-28，多次复现）：
  //   - vectorize upsert 返回 mutationId（平台已接受），但**立即及随后数十秒内**
  //     query / queryById / getByIds 全部读不到新向量；数据会在几十秒~几分钟后进入索引。
  //   - 因此「写完立刻回读」不适用于 Vectorize，它会把正常写入判成失败。
  //
  // 设计取舍：把 upsert 的 mutationId 当作成功凭据（这正是平台的异步契约），
  // 文档直接置 ready；索引追上之前检索会少命中，属**优雅降级**而非故障。
  // mutationId 写入文档记录，便于线上排障时对账。
  //
  // 只有「upsert 抛错」才算真失败（在 ⑤ 的 catch 里处理）。
  const accepted = await awaitVectorAcceptance(deps.index, chunks.map((c) => c.id), deps.verify ?? {});

    await deps.repo.updateDocument(targetId, {
    status: "ready",
    chunkCount: chunks.length,
    error: null,
    indexedAt: Date.now(),
  });

  // ⑥ 新文档已 ready，才删除被替换的旧文档（旧文档此时才失去存在意义）
  if (replaceTarget) {
    try {
      const oldIds = (await deps.repo.listChunksByDoc(replaceTarget.id)).map((c) => c.id);
      await deps.index.deleteByIds(oldIds);
      await deps.repo.deleteDocument(replaceTarget.id);
    } catch {
      // 旧文档清理失败不是致命问题：它已不参与检索（retrieve 只认 ready，且 deleteDocument 会删行）
      // 但必须让调用方知道，以便后续清理
      console.warn(`[ingest] 旧文档清理失败: ${replaceTarget.id}`);
    }
  }

  const document = await deps.repo.getDocument(targetId);
  if (!document) throw new Error("文档写入异常：写入后读取为空。");
  return { document, skipped: false, replaced };
}
