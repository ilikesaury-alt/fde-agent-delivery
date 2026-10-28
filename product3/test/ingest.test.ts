import { assert, assertEqual, assertThrows, describe, it } from "./harness.ts";
import { createFakeAI } from "./fakes.ts";
import { ingest, IngestError, MAX_DOC_CHARS } from "../lib/ingest.ts";
import { createMemoryRepo, createMemoryVectorIndex } from "../lib/memory.ts";
import type { IngestDeps } from "../lib/ingest.ts";

function makeDeps(): IngestDeps & { repo: ReturnType<typeof createMemoryRepo>; index: ReturnType<typeof createMemoryVectorIndex> } {
  return { repo: createMemoryRepo(), index: createMemoryVectorIndex(), ai: createFakeAI() };
}

const DOC = `# 部署指南

## 前置条件

需要在 Cloudflare 账号下开通 Workers 与 D1，并且本地安装 wrangler 命令行工具。

## 部署步骤

执行构建后进入 dist/ssr 目录，用 wrangler deploy 并带上 secrets 文件完成部署。

## 回滚

使用 wrangler rollback 指定完整版本号回滚到上一个已知可用版本。`;

describe("ingest — 状态机与落库", () => {
  it("导入成功 → status=ready 且 chunkCount>0", async () => {
    const deps = makeDeps();
    const r = await ingest(deps, { source: "paste", sourceRef: null, title: "部署指南", text: DOC });
    assertEqual(r.document.status, "ready");
    assert(r.document.chunkCount > 0, "应有 chunk");
    assertEqual(r.skipped, false);
    assertEqual(r.replaced, false);
    assertEqual(deps.repo.__chunks.size, r.document.chunkCount, "chunk 数应与记录一致");
  });

  it("chunk id 形如 docId:idx 且与向量键一致（引用映射依赖此约定）", async () => {
    const deps = makeDeps();
    const r = await ingest(deps, { source: "paste", sourceRef: null, title: "t", text: DOC });
    const chunks = await deps.repo.listChunksByDoc(r.document.id);
    assert(chunks.every((c) => c.id === `${r.document.id}:${c.idx}`), "chunk id 约定不符");
    assertEqual(deps.index.__vectors.size, chunks.length, "向量数应等于 chunk 数");
    for (const c of chunks) assert(deps.index.__vectors.has(c.id), `向量缺失: ${c.id}`);
  });

  it("空内容 → IngestError(empty) 且不落库", async () => {
    const deps = makeDeps();
    await assertThrows(
      () => ingest(deps, { source: "paste", sourceRef: null, title: "t", text: "   \n\n " }),
      (e) => e instanceof IngestError && e.code === "empty",
    );
    assertEqual(deps.repo.__documents.size, 0, "空内容不应产生文档");
  });

  it("超长内容 → IngestError(too_long)", async () => {
    const deps = makeDeps();
    await assertThrows(
      () => ingest(deps, { source: "paste", sourceRef: null, title: "t", text: "字".repeat(MAX_DOC_CHARS + 1) }),
      (e) => e instanceof IngestError && e.code === "too_long",
    );
  });
});

describe("ingest — 幂等（D14 同内容跳过）", () => {
  it("重复导入同内容 → skipped，且不重复嵌入", async () => {
    const deps = makeDeps();
    const first = await ingest(deps, { source: "paste", sourceRef: null, title: "t", text: DOC });
    const callsAfterFirst = (deps.ai as unknown as { calls: unknown[] }).calls.length;

    const second = await ingest(deps, { source: "paste", sourceRef: null, title: "t", text: DOC });
    assertEqual(second.skipped, true, "同内容应跳过");
    assertEqual(second.document.id, first.document.id, "应返回同一文档");
    assertEqual(
      (deps.ai as unknown as { calls: unknown[] }).calls.length,
      callsAfterFirst,
      "跳过时不应再调用嵌入（省配额是幂等的意义）",
    );
    assertEqual(deps.repo.__documents.size, 1, "不应产生第二份文档");
  });

  it("换行/空白差异不产生新文档（规范化后哈希相同）", async () => {
    const deps = makeDeps();
    await ingest(deps, { source: "paste", sourceRef: null, title: "t", text: DOC });
    const r2 = await ingest(deps, { source: "file", sourceRef: "a.md", title: "t", text: DOC.replace(/\n/g, "\r\n") });
    assertEqual(r2.skipped, true, "仅换行差异应判为同内容");
    assertEqual(deps.repo.__documents.size, 1);
  });
});

describe("ingest — 同来源内容变化整篇替换（D14）", () => {
  it("同 URL 内容变了 → 旧文档整体被替换，旧向量不残留", async () => {
    const deps = makeDeps();
    const url = "https://example.com/doc";
    const first = await ingest(deps, { source: "url", sourceRef: url, title: "v1", text: DOC });
    const oldIds = (await deps.repo.listChunksByDoc(first.document.id)).map((c) => c.id);
    assert(oldIds.length > 0);

    const second = await ingest(deps, {
      source: "url",
      sourceRef: url,
      title: "v2",
      text: DOC + "\n\n## 新增章节\n\n这是更新后新增的说明内容。",
    });

    assertEqual(second.replaced, true, "应标记为整篇替换");
    assertEqual(second.document.status, "ready");
    assertEqual(deps.repo.__documents.size, 1, "旧文档应被删除，只剩一份");
    assert(second.document.id !== first.document.id, "ready 文档被替换时用新 id（B1：旧的在成功后才删）");

    const leftover = oldIds.filter((id) => deps.index.__vectors.has(id));
    assertEqual(leftover.length, 0, "旧向量不应残留: " + leftover.join(","));
    assertEqual(deps.index.__vectors.size, second.document.chunkCount, "向量数应等于新 chunk 数");
  });

  it("不同来源同内容 → 走幂等跳过而非替换", async () => {
    const deps = makeDeps();
    await ingest(deps, { source: "url", sourceRef: "https://a.com/x", title: "a", text: DOC });
    const r = await ingest(deps, { source: "file", sourceRef: "b.md", title: "b", text: DOC });
    assertEqual(r.skipped, true);
    assertEqual(deps.repo.__documents.size, 1);
  });
});

describe("ingest — 嵌入失败与配额", () => {
  it("嵌入抛错 → 文档置 failed 且 error 有文案（不留 indexing 僵尸）", async () => {
    const deps: IngestDeps = {
      repo: createMemoryRepo(),
      index: createMemoryVectorIndex(),
      ai: createFakeAI({ embedError: () => new Error("boom") }),
    };
    await assertThrows(() => ingest(deps, { source: "paste", sourceRef: null, title: "t", text: DOC }));
    const docs = await deps.repo.listDocuments();
    assertEqual(docs.length, 1);
    assertEqual(docs[0].status, "failed", "失败必须落成 failed 状态");
    assert(Boolean(docs[0].error), "失败原因不能为空（否则用户无法自查）");
  });

  it("配额错误被识别为 quota 文案", async () => {
    const deps: IngestDeps = {
      repo: createMemoryRepo(),
      index: createMemoryVectorIndex(),
      ai: createFakeAI({ embedError: () => new Error("429 too many requests: neuron quota exceeded") }),
    };
    const err = await assertThrows(() => ingest(deps, { source: "paste", sourceRef: null, title: "t", text: DOC }));
    assert(err instanceof Error && err.name === "EmbedError", "应转成 EmbedError");
    assertEqual((err as unknown as { code: string }).code, "quota");
  });

  it("失败后重试复用同一 document id（引用编号不悬空）", async () => {
    const repo = createMemoryRepo();
    const index = createMemoryVectorIndex();
    let fail = true;
    const ai = {
      calls: [] as unknown[],
      async run(model: string, input: { text: string[] }) {
        this.calls.push(model);
        if (fail) throw new Error("temporary");
        const { fakeEmbed } = await import("./fakes.ts");
        return { data: input.text.map((t) => fakeEmbed(t)) };
      },
    };
    await assertThrows(() => ingest({ repo, index, ai }, { source: "paste", sourceRef: null, title: "t", text: DOC }));
    const failedId = [...repo.__documents.keys()][0];
    fail = false;
    const r = await ingest({ repo, index, ai }, { source: "paste", sourceRef: null, title: "t", text: DOC });
    assertEqual(r.document.id, failedId, "重试应复用同一 id");
    assertEqual(r.document.status, "ready");
  });
});

describe("ingest — 写后回读校验", () => {
  it("upsert 抛错 → 置 failed（真失败）", async () => {
    const repo = createMemoryRepo();
    const index = createMemoryVectorIndex();
    const throwingIndex = {
      ...index,
      upsert: async () => {
        throw new Error("vectorize 500");
      },
      existing: index.existing,
      query: index.query,
      queryById: index.queryById,
      deleteByIds: index.deleteByIds,
    };
    await assertThrows(
      () => ingest({ repo, index: throwingIndex, ai: createFakeAI() }, { source: "paste", sourceRef: null, title: "t", text: DOC }),
      (e) => e instanceof Error,
    );
    const docs = await repo.listDocuments();
    assertEqual(docs[0].status, "failed", "upsert 抛错必须置 failed");
    assert(Boolean(docs[0].error), "失败原因不能为空");
  });

  it("upsert 未抛错但向量暂不可见 → 文档 ready（Vectorize 异步语义）", async () => {
    const repo = createMemoryRepo();
    const inner = createMemoryVectorIndex();
    // 模拟线上：upsert 被接受但数据尚未可见
    const pendingIndex = {
      ...inner,
      existing: async () => [],
      queryById: async () => ({ matches: [] }),
    };
    const r = await ingest(
      { repo, index: pendingIndex, ai: createFakeAI(), verify: { attempts: 1 } },
      { source: "paste", sourceRef: null, title: "t", text: DOC },
    );
    assertEqual(r.document.status, "ready", "平台已接受 mutationId 即视为成功（不阻塞在可见性上）");
    assert(r.document.chunkCount > 0);
    assert(Boolean(r.document.indexedAt), "应记录索引验收时间");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// cross-review 回归用例：B1（替换失败不丢旧文档）/ B3（失败态不可被检索）/ N2（chunk 上限）
// ───────────────────────────────────────────────────────────────────────────

describe("ingest — B1：整篇替换失败时旧文档必须还在", () => {
  const V1 = DOC;
  const V2 = DOC + "\n\n## 新增章节\n\n这是更新后的内容。";

  it("新版本超长（超 chunk 上限）→ 旧版本完好保留", async () => {
    const deps = makeDeps();
    const first = await ingest(deps, { source: "url", sourceRef: "https://example.com/a", title: "v1", text: V1 });
    assertEqual(first.document.status, "ready");

    // 构造一个切分后必然超过 MAX_DOC_CHUNKS 的新版本
    // 410 段 × 450 字 ≈ 18.5 万字（< MAX_DOC_CHARS 20 万），但每段自成一块 → 410 chunk > 上限 400
    const huge = "# 巨大文档\n\n" + Array.from({ length: 410 }, (_, i) => `第 ${i} 段。` + "字".repeat(450)).join("\n\n");
    await assertThrows(
      () => ingest(deps, { source: "url", sourceRef: "https://example.com/a", title: "v2", text: huge }),
      (e) => e instanceof IngestError && e.code === "too_many_chunks",
    );

    const docs = await deps.repo.listDocuments();
    assertEqual(docs.length, 1, "只应有一份文档（旧版本）");
    assertEqual(docs[0].id, first.document.id, "旧文档 id 不应变化");
    assertEqual(docs[0].status, "ready", "旧文档必须仍可用");
    assert(docs[0].chunkCount > 0, "旧文档的 chunk 必须还在");
    const chunks = await deps.repo.listChunksByDoc(first.document.id);
    assert(chunks.length > 0, "旧 chunk 不应被删除");
    assertEqual(deps.index.__vectors.size, chunks.length, "旧向量不应被删除");
  });

  it("新版本嵌入失败（配额耗尽）→ 旧版本完好保留", async () => {
    const repo = createMemoryRepo();
    const index = createMemoryVectorIndex();
    let fail = false;
    const ai = {
      async run(model: string, input: { text: string[] }) {
        if (fail) throw new Error("429 too many requests: quota exceeded");
        const { fakeEmbed } = await import("./fakes.ts");
        return { data: input.text.map((t) => fakeEmbed(t)) };
      },
    };
    const first = await ingest({ repo, index, ai }, { source: "url", sourceRef: "https://e.com/x", title: "v1", text: V1 });
    const oldChunks = (await repo.listChunksByDoc(first.document.id)).map((c) => c.id);

    fail = true;
    await assertThrows(() =>
      ingest({ repo, index, ai }, { source: "url", sourceRef: "https://e.com/x", title: "v2", text: V2 }),
    );

    const docs = await repo.listDocuments();
    const oldDoc = docs.find((d) => d.id === first.document.id);
    assert(Boolean(oldDoc), "旧版本必须仍然存在（配额失败不应导致数据损失）");
    assertEqual(oldDoc?.status, "ready", "旧版本必须仍为 ready 且可问答");
    assert(oldDoc && oldDoc.chunkCount > 0, "旧版本 chunk 不能丢");
    for (const id of oldChunks) assert(index.__vectors.has(id), "旧向量丢失: " + id);
    // 新版本留下一条 failed 记录供用户查看失败原因（不是静默消失）
    const failed = docs.filter((d) => d.status === "failed");
    assertEqual(failed.length, 1, "失败的新版本应留下一条 failed 记录");
    assert(Boolean(failed[0].error), "failed 记录必须带失败原因");
  });
});

describe("ingest — B3：失败文档不可参与检索", () => {
  it("upsert 抛错置 failed 的文档，其 chunk 不应产出引用", async () => {
    const repo = createMemoryRepo();
    const index = createMemoryVectorIndex();
    const throwingIndex = {
      ...index,
      upsert: async () => {
        throw new Error("boom");
      },
      existing: index.existing,
      query: index.query,
      queryById: index.queryById,
      deleteByIds: index.deleteByIds,
    };
    await assertThrows(() =>
      ingest({ repo, index: throwingIndex, ai: createFakeAI() }, { source: "paste", sourceRef: null, title: "t", text: DOC }),
    );
    const docs = await repo.listDocuments();
    assertEqual(docs[0].status, "failed");
    // 构造一个「能返回该文档向量」的索引视图，验证检索侧仍会过滤掉非 ready 文档
    const readable = createMemoryVectorIndex();
    await readable.upsert([{ id: `${docs[0].id}:0`, values: (await import("./fakes.ts")).fakeEmbed("部署") }]);
    await repo.insertChunks([
      { id: `${docs[0].id}:0`, docId: docs[0].id, idx: 0, headingPath: "部署", text: "部署用 wrangler deploy。", createdAt: 0 },
    ]);
    const { retrieve } = await import("../lib/retrieve.ts");
    const { embedOne } = await import("../lib/embed.ts");
    const qv = await embedOne(createFakeAI(), "部署");
    const r = await retrieve(qv, { repo, index: readable }, { minScore: 0 });
    assertEqual(r.hits.length, 0, "failed 文档不得产出引用");
  });

  it("chunk 存在但文档行已删（孤儿 chunk）→ 不产出引用", async () => {
    const deps = makeDeps();
    const { document: doc } = await ingest(deps, { source: "paste", sourceRef: null, title: "t", text: DOC });
    deps.repo.__documents.delete(doc.id);
    const { retrieve } = await import("../lib/retrieve.ts");
    const { embedOne } = await import("../lib/embed.ts");
    const qv = await embedOne(createFakeAI(), "部署");
    const r = await retrieve(qv, { repo: deps.repo, index: deps.index }, { minScore: 0 });
    assertEqual(r.hits.length, 0, "孤儿 chunk 不应作为引用出现");
  });
});

describe("ingest — B4：并发导入同内容只落一份", () => {
  it("两个并发 ingest（同内容）→ 最终只有一份文档，其中一个是 skipped", async () => {
    const repo = createMemoryRepo();
    const index = createMemoryVectorIndex();
    const ai = createFakeAI();
    const input = { source: "paste" as const, sourceRef: null, title: "t", text: DOC };
    const [a, b] = await Promise.all([
      ingest({ repo, index, ai }, input),
      ingest({ repo, index, ai }, input),
    ]);
    assertEqual(repo.__documents.size, 1, `应只有一份文档，实际 ${repo.__documents.size}`);
    assert(a.skipped !== b.skipped, "并发场景下应有一个走幂等跳过");
    assertEqual(a.document.id, b.document.id, "两边应指向同一份文档");
  });
});


// ───────────────────────────────────────────────────────────────────────────
// 线上事故回归（2026-10-28 首次部署）：Vectorize 最终一致 → 立即回读假阴性
// 真实现场：upsert 成功后 getByIds 读不到 → 误判失败 → 补偿删 D1 行 → 孤儿向量
// ───────────────────────────────────────────────────────────────────────────

describe("ingest — Vectorize 异步可见性（线上事故回归）", () => {
  /** 构造一个「upsert 被接受但永远读不到」的索引替身（线上 Vectorize 的真实行为） */
  function alwaysInvisibleIndex() {
    const inner = createMemoryVectorIndex();
    return {
      ...inner,
      __vectors: inner.__vectors,
      async existing() {
        return [];
      },
      async queryById() {
        return { matches: [] };
      },
    };
  }

  it("向量始终不可见 → 仍判定 ready（平台异步契约），且数据一条都不丢", async () => {
    const repo = createMemoryRepo();
    const index = alwaysInvisibleIndex();
    const r = await ingest(
      { repo, index, ai: createFakeAI(), verify: { attempts: 1 } },
      { source: "paste", sourceRef: null, title: "t", text: DOC },
    );
    assertEqual(r.document.status, "ready", "upsert 未抛错即成功");
    assert(r.document.chunkCount > 0);
    assertEqual(repo.__chunks.size, r.document.chunkCount, "chunk 行必须写入");
    assert(index.__vectors.size > 0, "向量必须已写入（不能补偿删除）");
    assert(Boolean(r.document.indexedAt), "应记录验收时间用于对账");
  });

  it("重试同一内容 → 幂等跳过（不会因为不可见而重复写入）", async () => {
    const repo = createMemoryRepo();
    const index = alwaysInvisibleIndex();
    const deps = { repo, index, ai: createFakeAI(), verify: { attempts: 1 } };
    const a = await ingest(deps, { source: "paste", sourceRef: null, title: "t", text: DOC });
    const b = await ingest(deps, { source: "paste", sourceRef: null, title: "t", text: DOC });
    assertEqual(b.skipped, true, "第二次应幂等跳过");
    assertEqual(a.document.id, b.document.id);
    assertEqual(repo.__documents.size, 1);
  });
});
