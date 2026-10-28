/**
 * 检索 —— 双通道召回 + RRF 融合 + 阈值分流。
 *
 * 为什么是两条通道（CONTEXT D20）：
 *   向量通道擅长「语义近似」，但对方括号里的错误码、型号、版本号这类**低频高信息 token**
 *   不敏感（问 `ERR_1101` 与问「绑定缺失」在嵌入空间里可能几乎一样）。
 *   关键词通道正好相反：词面必须对上，但一旦对上，精度极高。
 *   RRF 只看两路名次，不标定权重 —— 这是跨量纲融合最省心也最不容易调错的做法。
 *
 * 阈值仍是产品的**诚实性开关**：不过闸就说「没有依据」，而不是让模型硬编。
 * 混合之后「过闸」的定义变成两者之一：
 *   ① 向量相似度 ≥ minScore；
 *   ② 关键词通道命中罕见词进池，且命中 code-like term 或 ≥2 个选择性词（见 KEYWORD_MIN_SELECTIVE_HITS）。
 * 两道关卡是防「两个常见 bigram 碰巧重合」把拒答率悄悄拉低（§11.5）。
 *
 * 尺度差异（都实测过，不要互相套用）：
 *   真 bge-m3：相关文本 0.52 / 0.65（2026-10-28 线上实测）
 *   本地词袋假嵌入：相关文本 0.05–0.2
 * 所以默认值取「线上安全」；本地 shim 必须显式注入 RETRIEVE_MIN_SCORE=0.05。
 */

import {
  KEYWORD_MIN_SELECTIVE_HITS,
  KEYWORD_POOL_LIMIT,
  KEYWORD_RRF_WEIGHT,
  fuseRrf,
  queryTerms,
  rareDfThreshold,
  scoreKeywordCandidates,
} from "./hybrid.ts";
import type { Chunk, Hit } from "./types.ts";
import type { Repo, VectorIndex } from "./repo.ts";

export const DEFAULT_TOP_K = 6;
/** 默认相似度阈值（线上安全值；本地 shim 必须显式降为 0.05） */
export const DEFAULT_MIN_SCORE = 0.45;
/** 混合检索默认开启（A3 的消融开关是 HYBRID_ENABLED=0） */
export const DEFAULT_HYBRID = true;

export type RetrieveOptions = {
  topK?: number;
  minScore?: number;
  /** 关掉关键词通道（消融对比用；关掉后行为与一期一致） */
  hybrid?: boolean;

};

export type RetrieveInput = {
  /** 查询向量（多轮时它是**改写后**查询的向量，不是原始问题的） */
  queryVector: number[];
  /** 查询原文（关键词通道用；缺省则只走向量通道） */
  query?: string;
};

export type RetrieveResult = {
  /** 过闸的命中（按 RRF 降序），用于生成回答 */
  hits: Hit[];
  /**
   * **没过闸**但融合分最高的若干条，用于拒答时给用户「最接近的内容」。
   * 语义必须是「没通过闸的」，否则拒答时展示的却是高分片段，自相矛盾（cross-review N5）。
   */
  nearest: Hit[];
  topK: number;
  minScore: number;
  hybrid: boolean;
  /** 观测用：两路各召回多少（step detail 与排障看这个） */
  vectorHits: number;
  keywordHits: number;
};

/** 每个文档只查一次状态（避免 top-k × 文档 的 N+1） */
function makeReadyChecker(repo: Repo): (docId: string) => Promise<boolean> {
  const cache = new Map<string, boolean>();
  return async (docId: string) => {
    const cached = cache.get(docId);
    if (cached !== undefined) return cached;
    const doc = await repo.getDocument(docId);
    const ok = doc?.status === "ready";
    cache.set(docId, ok);
    return ok;
  };
}

/**
 * 检索并分流。
 *
 * 关键过滤（cross-review B3/B4）：**只允许 status=ready 的文档参与检索**。
 * 原因：向量写入失败、并发导入产生孤儿 chunk、文档被标记 failed 时，
 * chunk 行可能短暂存在但文档不可用；不过滤会让「失败文档」继续被引用。
 */
export async function retrieve(
  input: RetrieveInput | number[],
  deps: { repo: Repo; index: VectorIndex },
  opts: RetrieveOptions = {},
): Promise<RetrieveResult> {
  const req: RetrieveInput = Array.isArray(input) ? { queryVector: input } : input;
  const topK = opts.topK ?? DEFAULT_TOP_K;
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const terms = opts.hybrid === false ? [] : queryTerms(req.query ?? "");
  const hybrid = opts.hybrid !== false && terms.length > 0;

  // 向量池：混合模式下多取几倍做融合（RRF 需要一点「备选」才有意义）
  const vectorPool = hybrid ? Math.max(topK * 4, KEYWORD_POOL_LIMIT) : topK;
  const matches = await deps.index.query(req.queryVector, vectorPool);
  const isReady = makeReadyChecker(deps.repo);

  const chunkById = new Map<string, Chunk>();
  const vectorRank = new Map<string, { rank: number; score: number }>();

  if (matches.length) {
    const chunks = await deps.repo.getChunksByIds(matches.map((m) => m.id));
    for (const c of chunks) chunkById.set(c.id, c);
    let rank = 0;
    for (const m of matches) {
      const chunk = chunkById.get(m.id);
      if (!chunk) continue; // 索引残影（chunk 已删）
      if (!(await isReady(chunk.docId))) continue;
      rank += 1;
      vectorRank.set(m.id, { rank, score: m.score });
    }
  }

  // 关键词池
  const keywordRank = new Map<
    string,
    {
      rank: number;
      score: number;
      coverage: number;
      minDf: number;
      codeMatched: boolean;
      selectiveHits: number;
    }
  >();
  /** 融合用的两路子列表：命中 code-like term 的给与向量同等权重，泛词命中按 0.4 */
  const codeIds: string[] = [];
  const genericIds: string[] = [];
  let rareDf = 0;
  if (hybrid) {
    const [rows, stats] = await Promise.all([
      deps.repo.searchTerms(terms),
      deps.repo.chunkStats(),
    ]);
    rareDf = rareDfThreshold(stats.n);
    // 入池判据：**命中罕见词**（df ≤ rareDf）为主。覆盖率只作诊断信息：
    // 小语料里「处理/应该」这类泛词的 df 也只有 4，按比例算「选择性」会失效，
    // 硬要它进分母就会把正确命中压到 0.5（实测 q21）。罕见词规则是这套语料规模下更稳的判据。
    const candidates = scoreKeywordCandidates(rows, stats)
      .filter((c) => c.minDf <= rareDf)
      .slice(0, KEYWORD_POOL_LIMIT);

    if (candidates.length) {
      const missing = candidates.map((c) => c.chunkId).filter((id) => !chunkById.has(id));
      if (missing.length) {
        for (const c of await deps.repo.getChunksByIds(missing)) chunkById.set(c.id, c);
      }
      let rank = 0;
      for (const c of candidates) {
        const chunk = chunkById.get(c.chunkId);
        if (!chunk) continue; // 倒排孤儿（chunk 已删但 term 没清干净）
        if (!(await isReady(chunk.docId))) continue;
        rank += 1;
        keywordRank.set(c.chunkId, {
          rank,
          score: c.score,
          coverage: c.coverage,
          minDf: c.minDf,
          codeMatched: c.codeMatched,
          selectiveHits: c.selectiveHits,
        });
        (c.codeMatched ? codeIds : genericIds).push(c.chunkId);
      }
    }
  }

  // 融合：向量 1.0；关键词拆两路 —— 命中 code-like term（错误码/型号）给 1.0，
  // 只有泛词命中给 KEYWORD_RRF_WEIGHT(0.4)。理由：前者是关键词通道存在的目的，
  // 后者只是兜底（实测泛词命中抢排序会把 q06 的 Recall 打下来）。
  const fused = fuseRrf([
    { source: "vector", ids: [...vectorRank.entries()].sort((a, b) => a[1].rank - b[1].rank).map(([id]) => id) },
    { source: "keyword", ids: codeIds, weight: 1 },
    { source: "keyword", ids: genericIds, weight: KEYWORD_RRF_WEIGHT },
  ]);

  const ids = [...fused.keys()];
  const scored: Array<Hit & { engaged: boolean }> = [];
  for (const id of ids) {
    const chunk = chunkById.get(id);
    if (!chunk) continue;
    const v = vectorRank.get(id);
    const k = keywordRank.get(id);
    const sources: Hit["sources"] = [];
    if (v) sources.push("vector");
    if (k) sources.push("keyword");
    // 过闸判据：向量分过线，或关键词通道满足「三道条件」（见 lib/hybrid.ts 常量注释）
    const keywordEngaged =
      k != null && (k.codeMatched || k.selectiveHits >= KEYWORD_MIN_SELECTIVE_HITS);
    const engaged = (v != null && v.score >= minScore) || keywordEngaged;
    scored.push({
      chunk,
      score: v?.score ?? 0,
      sources,
      keywordScore: k?.score,
      coverage: k?.coverage,
      minDf: k?.minDf,
      rrf: fused.get(id),
      engaged,
    });
  }

  // 排序口径（eval 驱动修正，2026-10-28）：**加权 RRF**（向量 1.0 / 关键词 0.4）。
  // 纯等权 RRF 实测会把「词面碰巧对上」的片段顶到 top1（q06 Recall 100%→91.7%）；
  // 加权后向量保主排序，关键词仍能把含罕见词（错误码/型号）的片段拉到前面。
  // 常量见 lib/hybrid.ts KEYWORD_RRF_WEIGHT。
  const ranked = scored
    .filter((h) => h.engaged)
    .sort((a, b) => (b.rrf ?? 0) - (a.rrf ?? 0) || b.score - a.score || a.chunk.id.localeCompare(b.chunk.id));

  // 名额保障（review 发现 #5）：向量池被放大到 4×topK，纯关键词命中（向量分为 0）
  // 在同分比较里永远输给向量命中，于是「关键词救回」在大语料上会被静默挤出 topK。
  // 这里给「关键词独立救回」的片段留 1 个名额；排序仍按融合分，不改变优先级语义。
  const rescued = ranked.find((h) => (h.sources ?? []).every((src) => src === "keyword"));
  let picked = ranked.slice(0, topK);
  if (rescued && !picked.includes(rescued) && topK > 1) {
    picked = [...picked.slice(0, topK - 1), rescued];
  }

  const hits: Hit[] = picked.map(({ engaged: _e, ...h }) => {
    void _e;
    return h;
  });

  // nearest 仍按融合分给「最接近但没过闸」的，供拒答时用户自查
  scored.sort(
    (a, b) => (b.rrf ?? 0) - (a.rrf ?? 0) || b.score - a.score || a.chunk.id.localeCompare(b.chunk.id),
  );
  const nearest: Hit[] = scored
    .filter((h) => !h.engaged)
    .slice(0, 3)
    .map(({ engaged: _e, ...h }) => {
      void _e;
      return h;
    });

  return {
    hits,
    nearest,
    topK,
    minScore,
    hybrid,
    vectorHits: vectorRank.size,
    keywordHits: keywordRank.size,
  };
}