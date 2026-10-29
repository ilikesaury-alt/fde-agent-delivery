import { assert, assertEqual, describe, it } from "./harness.ts";
import {
  KEYWORD_MIN_SELECTIVE_HITS,
  KEYWORD_RRF_WEIGHT,
  MAX_TERMS_PER_CHUNK,
  RRF_K,
  bm25Score,
  extractTerms,
  fuseRrf,
  queryTerms,
  scoreKeywordCandidates,
  tokenize,
  type TermHit,
} from "../lib/hybrid.ts";

describe("hybrid — 分词", () => {
  it("中文按双字 bigram，英文/数字按词", () => {
    const tokens = tokenize("部署用 wrangler deploy ERR_1101");
    assert(tokens.includes("部署"), `应有 部署: ${tokens.join(",")}`);
    assert(tokens.includes("wrangler"), "应保留英文词");
    assert(tokens.includes("deploy"), "应保留英文词");
    assert(tokens.includes("err_1101"), "错误码应作为整体 token（下划线/数字保留）");
  });

  it("过滤结构停用词（它们在任何文档里都高频）", () => {
    const tokens = tokenize("这个功能可以做什么");
    assert(!tokens.includes("这个"), "停用 bigram 不应入库");
    assert(!tokens.includes("可以"), "停用 bigram 不应入库");
    assert(!tokens.includes("什么"), "停用 bigram 不应入库");
    assert(tokens.includes("功能"), `业务词必须保留: ${tokens.join(",")}`);
  });

  it("单字不进倒排（噪声大、区分度低）", () => {
    assertEqual(tokenize("配额"), ["配额"]);
    assertEqual(tokenize("a b"), [], "单字母不构成 term");
  });
});

describe("hybrid — term 抽取与体积约束", () => {
  it("按 tf 降序，且不超过 MAX_TERMS_PER_CHUNK", () => {
    // 注意：文本不能让第二个词与「部署」tf 打平（如「回滚点」会产生 bigram「回滚」），
    // 否则排序由 tie-break 决定 —— tie-break 是平台无关的码点序，测试期望会随文本而变。
    const text = "部署 部署 部署 回滚 回滚 配额 绑定 模型 计费 向量 检索 索引 分词 融合 权重 阈值 拒答 引用 片段 文档 知识库 导入 导出 备份 恢复 迁移 校验 版本号 演练";
    const terms = extractTerms(text);
    assert(terms.length <= MAX_TERMS_PER_CHUNK, `实际 ${terms.length}`);
    assertEqual(terms[0].term, "部署", "最高 tf 的 term 排第一");
    assert(terms[0].tf >= terms[1].tf, "必须按 tf 降序");
  });

  it("同一 term 只出现一次（去重后计数）", () => {
    const terms = extractTerms("配额 配额 配额");
    assertEqual(terms.length, 1);
    assertEqual(terms[0].tf, 3);
  });

  it("查询 term 去重且限量", () => {
    assertEqual(queryTerms("部署 部署 部署"), ["部署"]);
    assertEqual(queryTerms("配额", 0).length, 0, "max=0 时返回空");
  });
});

describe("hybrid — BM25", () => {
  it("tf 越高分越高；dl 越短（相对 avgdl）分越高", () => {
    const base = { dl: 100, avgdl: 100, df: 2, n: 10 };
    const low = bm25Score({ ...base, tf: 1 });
    const high = bm25Score({ ...base, tf: 5 });
    assert(high > low, `tf 提升应加分: ${low} → ${high}`);

    const longDoc = bm25Score({ tf: 2, dl: 400, avgdl: 100, df: 2, n: 10 });
    const shortDoc = bm25Score({ tf: 2, dl: 50, avgdl: 100, df: 2, n: 10 });
    assert(shortDoc > longDoc, `短文档应更相关: ${longDoc} → ${shortDoc}`);
  });

  it("df 越小 idf 越大（罕见词的信号更强）", () => {
    const rare = bm25Score({ tf: 1, dl: 100, avgdl: 100, df: 1, n: 100 });
    const common = bm25Score({ tf: 1, dl: 100, avgdl: 100, df: 80, n: 100 });
    assert(rare > common, `罕见词应得分更高: ${rare} vs ${common}`);
  });

  it("tf=0 或 n=0 时返回 0（不产生 NaN）", () => {
    assertEqual(bm25Score({ tf: 0, dl: 1, avgdl: 1, df: 1, n: 1 }), 0);
    assertEqual(bm25Score({ tf: 1, dl: 1, avgdl: 1, df: 1, n: 0 }), 0);
  });
});

describe("hybrid — 候选打分与覆盖率", () => {
  const hits: TermHit[] = [
    { term: "err_1101", chunkId: "c1", tf: 2, dl: 60 },
    { term: "绑定", chunkId: "c1", tf: 1, dl: 60 },
    { term: "绑定", chunkId: "c2", tf: 3, dl: 50 },
  ];
  const stats = { n: 2, avgdl: 55 };

  it("加权覆盖率：命中库内全部 term → 1.0", () => {
    const scored = scoreKeywordCandidates(hits, stats);
    const c1 = scored.find((c) => c.chunkId === "c1");
    assert(Math.abs((c1?.coverage ?? 0) - 1) < 1e-9, `c1 命中库内全部 term: ${c1?.coverage}`);
    assertEqual(c1?.minDf, 1, "err_1101 只在一段里出现 → df=1（罕见词）");
  });

  it("选择性命中数：c1 命中 2 个，c2 只命中 1 个（过闸要看这个数）", () => {
    const scored = scoreKeywordCandidates(hits, stats);
    const c1 = scored.find((c) => c.chunkId === "c1")!;
    const c2 = scored.find((c) => c.chunkId === "c2")!;
    assertEqual(c1.selectiveHits, 2, "c1 命中 err_1101 与 绑定");
    assertEqual(c2.selectiveHits, 1, "c2 只命中 绑定");
    assert(c2.selectiveHits < KEYWORD_MIN_SELECTIVE_HITS, "单命中不足以单独过闸");
    assertEqual(c1.codeMatched, true, "c1 命中了 code-like term");
    assertEqual(c2.codeMatched, false, "c2 只有中文泛词");
  });

  it("idf 加权：命中罕见词比命中泛词分到的覆盖率高", () => {
    const rare: TermHit[] = [
      { term: "err_1101", chunkId: "c1", tf: 1, dl: 60 },
      { term: "错误", chunkId: "c1", tf: 1, dl: 60 },
      { term: "错误", chunkId: "c2", tf: 1, dl: 60 },
      { term: "错误", chunkId: "c3", tf: 1, dl: 60 },
    ];
    const scored = scoreKeywordCandidates(rare, stats);
    const hitRare = scored.find((c) => c.chunkId === "c1")!;
    const hitCommon = scored.find((c) => c.chunkId === "c2")!;
    assert(hitRare.coverage > hitCommon.coverage, `罕见词应权重更高: ${hitRare.coverage} vs ${hitCommon.coverage}`);
  });

  it("空倒排 / 无查询词 → 空结果", () => {
    assertEqual(scoreKeywordCandidates([], stats).length, 0);
  });
});

describe("hybrid — RRF 融合", () => {
  it("两路都命中的 id 拿到两段名次分之和（关键词权重 0.4）", () => {
    const fused = fuseRrf([
      { source: "vector", ids: ["c2", "c1"] },
      { source: "keyword", ids: ["c1"] },
    ]);
    assert(fused.get("c1")! > fused.get("c2")!, "c1 在关键词通道排第 1，融合后应领先");
    const expectedC1 = 1 / (RRF_K + 2) + KEYWORD_RRF_WEIGHT / (RRF_K + 1);
    assert(Math.abs(fused.get("c1")! - expectedC1) < 1e-9, `公式不符: ${fused.get("c1")} vs ${expectedC1}`);
  });

  it("只有一路时融合分等于该路名次倒数（关键词按 0.4 加权）", () => {
    const fused = fuseRrf([{ source: "keyword", ids: ["a", "b"] }]);
    assertEqual(fused.get("a"), KEYWORD_RRF_WEIGHT / (RRF_K + 1));
    assertEqual(fused.get("b"), KEYWORD_RRF_WEIGHT / (RRF_K + 2));
  });

  it("关键词权重 <1：纯关键词命中的名次分低于纯向量命中（不抢排序）", () => {
    const fused = fuseRrf([
      { source: "vector", ids: ["v"] },
      { source: "keyword", ids: ["k"] },
    ]);
    assert(fused.get("v")! > fused.get("k")!, `向量应占优: ${fused.get("v")} vs ${fused.get("k")}`);
    assert(KEYWORD_RRF_WEIGHT < 1);
  });
});