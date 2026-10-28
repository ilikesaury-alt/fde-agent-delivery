import { assert, assertEqual, describe, it } from "./harness.ts";
import { createFakeAI } from "./fakes.ts";
import { embedAll, embedOne, extractVectors, isQuotaError, EMBED_DIM, BATCH_SIZE } from "../lib/embed.ts";
import { createMemoryRepo, createMemoryVectorIndex } from "../lib/memory.ts";
import { ingest } from "../lib/ingest.ts";
import { mergeResults, retrieve, DEFAULT_MIN_SCORE } from "../lib/retrieve.ts";

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

// ── 二期：混合检索（A3）──────────────────────────────────────────

const DOC_ERR = `# 故障处理

## 错误码

报错 ERR_1101 表示 Workers AI 绑定缺失，请检查 wrangler.json 里的 ai 绑定。

报错 ERR_2049 表示日配额耗尽，等次日恢复。`;

const DOC_BILLING2 = `# 计费说明

模型调用按 token 计费，免费额度每月重置。`;

async function setupErr() {
  const repo = createMemoryRepo();
  const index = createMemoryVectorIndex();
  const ai = createFakeAI();
  await ingest({ repo, index, ai }, { source: "paste", sourceRef: null, title: "故障处理", text: DOC_ERR });
  await ingest({ repo, index, ai }, { source: "paste", sourceRef: null, title: "计费说明", text: DOC_BILLING2 });
  return { repo, index, ai };
}

describe("retrieve — 混合检索（关键词通道）", () => {
  it("关掉关键词通道 → 与一期一致的纯向量行为（高阈值下直接落选）", async () => {
    const { repo, index, ai } = await setupErr();
    const qv = await embedOne(ai, "ERR_1101 是什么意思");
    const r = await retrieve({ queryVector: qv, query: "ERR_1101 是什么意思" }, { repo, index }, {
      hybrid: false,
      minScore: 0.9,
    });
    assertEqual(r.hybrid, false);
    assertEqual(r.hits.length, 0, "纯向量通道在高阈值下不应命中");
    assert(r.nearest.length > 0, "落选片段应作为 nearest 给出");
  });

  it("开启混合检索 → 错误码类查询由关键词通道救回", async () => {
    const { repo, index, ai } = await setupErr();
    const qv = await embedOne(ai, "ERR_1101 是什么意思");
    const r = await retrieve({ queryVector: qv, query: "ERR_1101 是什么意思" }, { repo, index }, { minScore: 0.9 });
    assertEqual(r.hybrid, true);
    assertEqual(r.hits.length > 0, true, "关键词通道应召回到含错误码的片段");
    const hit = r.hits[0];
    assert(hit.sources?.includes("keyword") === true, `命中应标记关键词通道: ${JSON.stringify(hit.sources)}`);
    assert(hit.chunk.text.includes("ERR_1101"), `命中的片段必须真含该错误码: ${hit.chunk.text.slice(0, 40)}`);
    assert((hit.coverage ?? 0) >= 0.6, `库内覆盖率应过门槛: ${hit.coverage}`);
    assert((hit.minDf ?? 99) <= 2, `必须命中罕见词（错误码本身就是低频 token）: df=${hit.minDf}`);
    assert((hit.keywordScore ?? 0) > 0, "应带上 BM25 分供前端/排障看");
  });

  it("库内没有的内容 → 关键词通道也不会凭空造命中", async () => {
    const { repo, index, ai } = await setupErr();
    const qv = await embedOne(ai, "量子色动力学的渐近自由");
    const r = await retrieve(
      { queryVector: qv, query: "量子色动力学的渐近自由" },
      { repo, index },
      { minScore: 0.9 },
    );
    assertEqual(r.hits.length, 0, "无关问题不得靠词面偶然重合过关");
    assertEqual(r.keywordHits, 0);
    assert(r.nearest.length > 0, "仍应给出最相近片段供用户判断");
  });

  it("覆盖率不足的片段不入池（防常见 bigram 抬高召回）", async () => {
    const { repo, index, ai } = await setupErr();
    // 两个查询词都在库内，但每个片段只命中其中一个 → 覆盖率 1/2 < 0.6
    const q = "报错 计费";
    const qv = await embedOne(ai, q);
    const r = await retrieve({ queryVector: qv, query: q }, { repo, index }, { minScore: 0.9 });
    assertEqual(r.hits.length, 0, "部分词面重合不足以判为有依据");
  });

  it("向量通道过闸时仍按融合名次排序（两路都命中优先）", async () => {
    const { repo, index, ai } = await setupErr();
    const q = "ERR_1101 绑定缺失";
    const qv = await embedOne(ai, q);
    const r = await retrieve({ queryVector: qv, query: q }, { repo, index }, { minScore: 0.05 });
    assert(r.hits.length > 0);
    const top = r.hits[0];
    assert(top.sources?.includes("vector") === true, "top1 应同时被向量通道召回");
    assert((top.rrf ?? 0) > 0, "融合分必须 > 0");
  });

  it("排序口径：向量负责排序，关键词只负责兵底召回（eval 驱动修正）", async () => {
    const { repo, index, ai } = await setupErr();
    // 两篇都过闸：向量通道对“计费/token”更准，关键词通道对“错误码”更准
    const q = "ERR_1101 计费 token";
    const qv = await embedOne(ai, q);
    const r = await retrieve({ queryVector: qv, query: q }, { repo, index }, { minScore: 0.05, topK: 10 });
    assert(r.hits.length >= 2, `应召回多篇：${r.hits.length}`);
    const vectorPart = r.hits.filter((h) => h.score >= 0.05);
    const scores = vectorPart.map((h) => h.score);
    assertEqual(scores, [...scores].sort((a, b) => b - a), "过闸的向量命中必须按相似度降序");
    // 关键词专项命中（score < minScore）必须排在所有向量命中之后，不能抢排序
    const firstKeywordOnly = r.hits.findIndex((h) => h.score < 0.05);
    if (firstKeywordOnly >= 0) {
      assert(
        r.hits.slice(firstKeywordOnly).every((h) => h.score < 0.05),
        "关键词专项命中不得插入向量命中中间",
      );
    }
  });

  it("只命中一个泛词、其余查询词全库无命中 → 不得过闸（review #4 场景）", async () => {
    const { repo, index, ai } = await setupErr();
    // 「船票/签证」都不在库里；只有「计费」出现在某段 → 单一泛词命中
    const q = "计费 船票 签证";
    const qv = await embedOne(ai, q);
    const r = await retrieve({ queryVector: qv, query: q }, { repo, index }, { minScore: 0.9 });
    assertEqual(r.hits.length, 0, "单一泛词命中不足以作为回答依据");
    assert(r.nearest.length > 0, "该片段应落到 nearest（给用户看「最接近什么」）");
  });

  it("mergeResults：两路都命中的片段排最前，单路命中的按名次融合", async () => {
    const { repo, index, ai } = await setupErr();
    // 双路：改写查询命中错误码段，原始问题命中计费段
    const qvA = await embedOne(ai, "ERR_1101 绑定缺失");
    const qvB = await embedOne(ai, "计费 token");
    const rA = await retrieve({ queryVector: qvA, query: "ERR_1101 绑定缺失" }, { repo, index }, { minScore: 0.05 });
    const rB = await retrieve({ queryVector: qvB, query: "计费 token" }, { repo, index }, { minScore: 0.05 });
    const merged = mergeResults(rA, rB, { topK: 6 });
    assert(merged.hits.length >= 2, `合并后应有两路片段: ${merged.hits.length}`);
    // 两路各自的 top1 都应保留在合并结果里（RRF 单路命中 = 1/(60+rank)，不会互相挤掉）
    const ids = new Set(merged.hits.map((h) => h.chunk.id));
    assert(ids.has(rA.hits[0].chunk.id), "改写路的 top1 应保留");
    assert(ids.has(rB.hits[0].chunk.id), "原始问题的 top1 应保留");
    const top = merged.hits[0];
    assert((top.rrf ?? 0) >= 1 / (60 + 1), `融合分至少是单路 rank1: ${top.rrf}`);
    // hits 与 nearest 不重叠
    const hitIds = new Set(merged.hits.map((h) => h.chunk.id));
    assert(merged.nearest.every((n) => !hitIds.has(n.chunk.id)), "nearest 不得与 hits 重叠");
  });

  it("mergeResults：空结果合并不炸", async () => {
    const { repo, index, ai } = await setupErr();
    const qv = await embedOne(ai, "量子色动力学的渐近自由");
    const empty = await retrieve({ queryVector: qv, query: "量子色动力学的渐近自由" }, { repo, index }, { minScore: 0.9 });
    const merged = mergeResults(empty, empty, { topK: 6 });
    assertEqual(merged.hits.length, 0);
  });

  it("refused 的语义不变：nearest 只包含未过闸的片段", async () => {
    const { repo, index, ai } = await setupErr();
    const qv = await embedOne(ai, "量子色动力学的渐近自由");
    const r = await retrieve({ queryVector: qv, query: "量子色动力学的渐近自由" }, { repo, index }, { minScore: 0.9 });
    assertEqual(r.hits.length, 0);
    const hitIds = new Set(r.hits.map((h) => h.chunk.id));
    assert(r.nearest.every((n) => !hitIds.has(n.chunk.id)), "nearest 与 hits 不能重叠");
  });
});
