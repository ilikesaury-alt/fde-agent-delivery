import { assert, assertEqual, describe, it } from "./harness.ts";
import { createFakeAI } from "./fakes.ts";
import { embedAll, embedOne, extractVectors, isQuotaError, EMBED_DIM, BATCH_SIZE } from "../lib/embed.ts";
import { createMemoryRepo, createMemoryVectorIndex } from "../lib/memory.ts";
import { ingest } from "../lib/ingest.ts";
import { retrieve, DEFAULT_MIN_SCORE } from "../lib/retrieve.ts";

const DOC_DEPLOY = `# 部署

执行构建后进入 dist/ssr 目录，用 wrangler deploy 并携带 secrets 文件完成部署。

# 回滚

使用 wrangler rollback 指定完整版本号回滚到上一个已知可用版本。`;

const DOC_BILLING = `# 计费

模型调用按 token 计费，免费额度每月重置，超出部分按量结算。`;

async function setup() {
  const repo = createMemoryRepo();
  const index = createMemoryVectorIndex();
  const ai = createFakeAI();
  await ingest({ repo, index, ai }, { source: "paste", sourceRef: null, title: "部署手册", text: DOC_DEPLOY });
  await ingest({ repo, index, ai }, { source: "paste", sourceRef: null, title: "计费说明", text: DOC_BILLING });
  return { repo, index, ai };
}

describe("embed — 批处理与异常", () => {
  it("按 BATCH_SIZE 分批调用", async () => {
    const ai = createFakeAI();
    const texts = Array.from({ length: BATCH_SIZE * 2 + 1 }, (_, i) => `第${i}段内容`);
    const vectors = await embedAll(ai, texts);
    assertEqual(vectors.length, texts.length);
    assertEqual(ai.calls.length, 3, `应分 3 批，实际 ${ai.calls.length}`);
    assert(vectors.every((v) => v.length === EMBED_DIM), "维度应为 1024");
  });

  it("配额错误 → EmbedError(code=quota)", async () => {
    const ai = createFakeAI({ embedError: () => new Error("429 rate limit exceeded") });
    try {
      await embedAll(ai, ["x"]);
      throw new Error("应抛错");
    } catch (e) {
      assertEqual((e as { code: string }).code, "quota");
    }
  });

  it("isQuotaError 识别常见配额措辞", () => {
    assert(isQuotaError(new Error("neuron quota exceeded")));
    assert(isQuotaError(new Error("HTTP 429 Too Many Requests")));
    assert(!isQuotaError(new Error("network error")));
  });

  it("返回格式异常 → EmbedError(upstream)", () => {
    try {
      extractVectors({ data: "not-an-array" }, 1);
      throw new Error("应抛错");
    } catch (e) {
      assertEqual((e as { code: string }).code, "upstream");
    }
  });

  it("数量不一致 → 报错（防止静默错位）", () => {
    try {
      extractVectors({ data: [[1, 2]] }, 2);
      throw new Error("应抛错");
    } catch (e) {
      assertEqual((e as { code: string }).code, "upstream");
    }
  });
});

describe("retrieve — 阈值分流", () => {
  it("相关问题命中对应文档", async () => {
    const { repo, index, ai } = await setup();
    const qv = await embedOne(ai, "怎么部署到 Cloudflare");
    const r = await retrieve(qv, { repo, index }, { topK: 6, minScore: 0.1 });
    assert(r.hits.length > 0, "应有命中");
    assertEqual(r.hits[0].chunk.docId, (await repo.listDocuments()).find((d) => d.title === "部署手册")?.id, "最高分应来自部署手册");
  });

  it("低于阈值 → hits 为空但 nearest 有值（拒答仍可展示最接近内容）", async () => {
    const { repo, index, ai } = await setup();
    const qv = await embedOne(ai, "量子色动力学的渐近自由");
    const r = await retrieve(qv, { repo, index }, { topK: 6, minScore: 0.99 });
    assertEqual(r.hits.length, 0, "高阈值下应无命中");
    assert(r.nearest.length > 0, "nearest 应保留最相近片段");
  });

  it("默认阈值是 0.35（env 未配置时的口径）", async () => {
    const { repo, index, ai } = await setup();
    const qv = await embedOne(ai, "回滚");
    const r = await retrieve(qv, { repo, index });
    assertEqual(r.minScore, DEFAULT_MIN_SCORE);
  });

  it("已删除 chunk 的索引残影被跳过（不返回空引用）", async () => {
    const { repo, index, ai } = await setup();
    const docs = await repo.listDocuments();
    const target = docs.find((d) => d.title === "部署手册")!;
    const chunkIds = await repo.deleteDocument(target.id); // 只删元数据，故意不清向量
    assert(chunkIds.length > 0);
    const qv = await embedOne(ai, "部署");
    const r = await retrieve(qv, { repo, index }, { minScore: 0 });
    assert(r.hits.every((h) => !chunkIds.includes(h.chunk.id)), "已删 chunk 不应出现在命中的引用候选里");
  });
});
