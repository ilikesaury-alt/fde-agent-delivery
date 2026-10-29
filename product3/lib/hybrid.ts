/**
 * 混合检索的关键词通道 —— 分词 / TF 抽取 / BM25 / RRF 融合。
 *
 * 为什么需要它（CONTEXT D20）：向量检索对「专有名词、错误码、型号码、版本号」
 * 这类低语义密度 token 不敏感 —— 问 `ERR_1101` 和问「绑定缺失」在嵌入空间里可能
 * 差不多，但用户要的答案只在含 `1101` 的那一段里。关键词通道补的正是这个缺口。
 *
 * 三个设计约束（都来自 §11.5 高风险表）：
 *  1. **体积**：每 chunk 只存 tf 最高的 MAX_TERMS_PER_CHUNK 个 term（不是全部 bigram）。
 *  2. **精度**：两道关卡——**入池**要求命中罕见词（df 足够低，见 rareDfThreshold），
 *     **过闸**还要求命中「有区分度的信号」：命中了 code-like term（错误码/型号），
 *     或至少命中 2 个选择性 query term（见 SELECTIVE_DF_RATIO）。否则「问什么都能命中几个常见 bigram」，
 *     拒答率会被悄悄拉低。
 *  3. **可测**：全部是纯函数，不碰 IO —— 倒排读写交给 `Repo`，本地用内存实现跑同一套单测。
 *
 * 融合用 RRF（Reciprocal Rank Fusion）而不是加权求和：两路分数量纲完全不同
 * （cosine 0–1 vs BM25 无上界），RRF 只看名次，不需要标定权重。
 */

import type { HitSource } from "./types.ts";

/** 每 chunk 入倒排的 term 上限（控 D1 体积，见 migration 0004 注释） */
export const MAX_TERMS_PER_CHUNK = 24;
/**
 * 关键词通道「过闸」需要的**选择性命中数**（命中 code-like term 时不受此限）。
 *
 * 为什么不用覆盖率单道闸（review 发现 #4）：覆盖率的分母只含「库内出现过的选择性词」，
 * 于是「只命中一个词、其余查询词全库都没有」的片段会算出 coverage=1.0 ——
 * 问「报销审批流程」时，只含「报销」的无关片段也能以满分过闸。
 * 改成「命中项够多/够硬」：命中 code-like term（错误码/型号，信号最强）**或**
 * 至少命中 2 个选择性词，才允许作为回答依据。
 * idf 加权覆盖率仍然计算（`coverage` 字段），但只作诊断与排障。
 */
export const KEYWORD_MIN_SELECTIVE_HITS = 2;

/**
 * 「罕见词」的 df 上限比例。
 *
 * 关键词通道的职责是抓专有名词/错误码这类**低频高信息** token，而不是常见 bigram。
 * 仅靠覆盖率挡不住「两个常见词凑巧都在一段里」，所以再加一条：命中项里至少有一个
 * 罕见词（df ≤ max(2, ⌈n × 此比例⌉)）。用相对比例而不是绝对分值，是因为库量为 1 篇时
 * BM25 的 idf 天然很小，绝对分阀值会把正确命中误杀。
 */
export const KEYWORD_MAX_DF_RATIO = 0.05;

/** 某个库规模下「罕见词」的 df 阈值（小库至少允许 df ≤ 2） */
export function rareDfThreshold(n: number): number {
  return Math.max(2, Math.ceil(n * KEYWORD_MAX_DF_RATIO));
}

/**
 * 「选择性词」的 df 上限比例：只有这类词参与加权覆盖率的分母。
 *
 * 为什么要排除泛词：`ERR_3307 应该怎么处理？` 里「处理」在语料的多段都出现（df 高），
 * 它和错误码一起进分母时，即使错误码被精确命中，覆盖率也只有 0.5（被 0.6 门槛挡掉）。
 * 泛词没有区分度，本来就不该决定「这段是不是用户要的」——分母只留选择性词后，
 * 该查询的覆盖率回到 1.0，而 `报错 计费`（两个都是选择性词、各只命中一个）仍是 0.5 被挡。
 */
export const SELECTIVE_DF_RATIO = 0.2;

/** 某个库规模下「选择性词」的 df 阈值（小库至少允许 df ≤ 2） */
export function selectiveDfThreshold(n: number): number {
  return Math.max(2, Math.ceil(n * SELECTIVE_DF_RATIO));
}
/** RRF 名次平滑常数（原论文默认 60） */
export const RRF_K = 60;
/**
 * RRF 中关键词通道的权重（<1 表示它只负责「兜底召回」、不抢排序）。
 *
 * 为什么不是等权：等权 RRF 实测把「词面碰巧对上」的片段压到 top1，
 * 让 q06（计费类问题）的 Recall 从 100% 掉到 91.7%。评测驱动下调到 0.4 后，
 * 向量保持主排序、关键词仍能把错误码类片段顶上来（见 CONTEXT §11.1 消融记录）。
 */
export const KEYWORD_RRF_WEIGHT = 0.4;
/** 关键词通道进融合池的候选上限 */
export const KEYWORD_POOL_LIMIT = 20;
/** 单次倒排查询返回行数上限（防常见 bigram 把结果集撑爆） */
export const TERM_ROWS_LIMIT = 5000;

/**
 * 中文停用 bigram：这些词在任何文档里都高频，进倒排只会制造噪声。
 * 只放「结构词」，不放业务词（例如「部署」「回滚」必须保留）。
 */
const STOP_BIGRAMS = new Set([
  "的了",
  "了的",
  "是一",
  "是一",
  "这个",
  "那个",
  "这些",
  "那些",
  "可以",
  "如果",
  "因为",
  "所以",
  "但是",
  "而且",
  "以及",
  "并且",
  "不是",
  "没有",
  "什么",
  "怎么",
  "如何",
  "为什",
  "么样",
  "我们",
  "你们",
  "他们",
  "它们",
  "一个",
  "一些",
  "这样",
  "那样",
  "就是",
  "还是",
  "或者",
  "需要",
  "进行",
  "通过",
  "对于",
  "关于",
  "根据",
  "按照",
  "以下",
  "以上",
  "如下",
  "其中",
  "其他",
  "这个",
  "时候",
  "问题",
  "情况",
  // 问题套话：实测把「是什么意思」类词计入覆盖率会让正确命中被判为低覆盖
  "是什",
  "么意",
  "意思",
  "是怎",
  "哪些",
  "哪个",
  "多少",
  "多久",
  "是否",
  "能否",
  "请问",
  "帮我",
  "告诉",
  "里面",
  "一下",
  "之后",
  "之前",
  "起来",
  // 情态/副词类：无检索信号，但在小语料里 df 极低（会被误判成「罕见词」）
  "应该",
  "必须",
  "可能",
  "建议",
  "注意",
  "一般",
  "通常",
  "目前",
  "已经",
  "仍然",
  "只需",
  "只要",
  "之一",
  "之类",
  "大约",
  "主要",
]);

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "are",
  "was",
  "not",
  "you",
  "all",
  "can",
  "has",
  "have",
  "how",
  "what",
  "when",
  "which",
  "will",
  "our",
  "its",
  "but",
  "any",
  "may",
]);

/**
 * 分词：英文/数字按摩空白切词（长度 ≥2），中文按双字 bigram。
 *
 * ⚠️ 必须与 `e2e/ai-shim.mjs` / `test/fakes.ts` 的假嵌入分词**同源**，
 * 否则「关键词通道」和「向量通道」在本地看到的是两种文本观，测试结论会漂。
 * 差别只在于这里过滤停用词（倒排精度需要），假嵌入不需要。
 */
export function tokenize(text: string): string[] {
  const norm = text.toLowerCase().replace(/\s+/g, " ");
  const out: string[] = [];
  for (const m of norm.matchAll(/[a-z0-9_]{2,}/g)) {
    const t = m[0];
    if (!STOP_WORDS.has(t)) out.push(t);
  }
  for (const seg of norm.matchAll(/[\u4e00-\u9fff]+/g)) {
    const s = seg[0];
    for (let i = 0; i + 1 < s.length; i++) {
      const t = s.slice(i, i + 2);
      if (!STOP_BIGRAMS.has(t)) out.push(t);
    }
  }
  return out;
}

export type TermFrequency = { term: string; tf: number };

/**
 * 抽取一个 chunk 的入库 term：按 tf 降序取前 MAX_TERMS_PER_CHUNK。
 *
 * 注意这里是**截断**而非采样：被丢掉的通常是「只出现一次的长尾 bigram」，
 * 而查询命中的往往就是 tf 高的主题词；这是用一点召回换体积的自觉取舍。
 */
/** 拉丁/数字/下划线词（错误码、型号、版本号、英文术语）—— 这些是关键词通道的价值来源，**必须始终保留** */
const CODE_LIKE_RE = /^[a-z0-9_]{2,}$/;
/** 每 chunk 最多保留多少个 code-like term（绝大多数 chunk 远不到这个数） */
export const MAX_CODE_TERMS_PER_CHUNK = 8;
/**
 * code-like term 在关键词打分里的加权（×2）。
 *
 * 动机（实测 q21）：小语料里「应该」这类泛词的 df 也可能 = 1，按 BM25 它甚至比错误码
 * 分更高（tf 更多），于是「ERR_3307 怎么处理」命中的是含「应该」的那段而不是含错误码的那段。
 * 错误码/型号是关键词通道存在**的全部理由**（CONTEXT D20），给它们加权是把这个目的落实。
 */
export const CODE_TERM_BOOST = 2;

/**
 * 抽取一个 chunk 的入库 term。
 *
 * 顺序：先收所有 code-like term（错误码/型号/英文词，最多 MAX_CODE_TERMS_PER_CHUNK 个），
 * 再用剩余额度按 tf 降序补中文 bigram。
 *
 * tie-break 用 Unicode 码点比较而不是 localeCompare：localeCompare 不带 locale 参数时
 * 结果依赖运行环境的默认 locale（Windows zh-CN 拼音序 vs Linux C 码点序），
 * tf 打平时的排序会跨平台不同 → 单测在 CI 上挂（实测：期望「部署」实际「回滚」）。
 * 检索 term 排序只需要确定性（便于测试与对账），不需要字典序语义。
 *
 * 为什么不能只看 tf：一个 chunk 里 `ERR_1101` 只出现 1 次，而「报错」「绑定」出现 2 次，
 * 纯按 tf 截断会把错误码挤掉 —— 那样混合检索就救不回它本来要救的东西（实测踩过）。
 */
export function extractTerms(text: string, max = MAX_TERMS_PER_CHUNK): TermFrequency[] {
  const counts = new Map<string, number>();
  for (const t of tokenize(text)) counts.set(t, (counts.get(t) ?? 0) + 1);

  const all = [...counts.entries()]
    .map(([term, tf]) => ({ term, tf }))
    .sort((a, b) => b.tf - a.tf || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));

  const code = all.filter((t) => CODE_LIKE_RE.test(t.term)).slice(0, MAX_CODE_TERMS_PER_CHUNK);
  const rest = all.filter((t) => !CODE_LIKE_RE.test(t.term));
  return [...code, ...rest].slice(0, max);
}

/** 查询 term（去重、限量；顺序保留以便测试可读） */
export function queryTerms(query: string, max = MAX_TERMS_PER_CHUNK): string[] {
  if (max <= 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokenize(query)) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

export type TermHit = {
  term: string;
  chunkId: string;
  tf: number;
  /** 该 chunk 的文本长度（BM25 的文档长度代理：LENGTH(text)） */
  dl: number;
};

export type KeywordCandidate = {
  chunkId: string;
  score: number;
  /** idf 加权的命中覆盖率 0–1（诊断字段） */
  coverage: number;
  /** 命中项里最小的 df（越小越罕见；用于 rare 判定） */
  minDf: number;
  /** 是否命中了 code-like term（错误码/型号/英文词）—— 这类命中在融合时给更高权重 */
  codeMatched: boolean;
  /** 命中的「选择性 term」（df ≤ selectiveDfThreshold）个数，过闸用 */
  selectiveHits: number;
};

/** BM25 单 term 打分（k1/b 取标准值；idf 用 Robertson/Sparck Jones 平滑式） */
export function bm25Score(opts: {
  tf: number;
  dl: number;
  avgdl: number;
  df: number;
  n: number;
  k1?: number;
  b?: number;
}): number {
  const { tf, dl, avgdl, df, n } = opts;
  const k1 = opts.k1 ?? 1.2;
  const b = opts.b ?? 0.75;
  if (!(tf > 0) || n <= 0) return 0;
  const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
  const denom = tf + k1 * (1 - b + (b * (avgdl > 0 ? dl : 0)) / (avgdl > 0 ? avgdl : 1));
  return idf * ((tf * (k1 + 1)) / denom);
}

/**
 * 倒排行 → 候选打分（按 chunk 聚合）。
 *
 * df 的口径：本次查询结果里「含该 term 的不同 chunk 数」。由于倒排查询有
 * TERM_ROWS_LIMIT 上限，df 是**截断后的近似值** —— 对排序够用，且避免了
 * 「为算 df 再扫全表」的额外往返（这是自觉取舍，写在注释里而不是藏着）。
 */
export function scoreKeywordCandidates(
  termHits: TermHit[],
  stats: { n: number; avgdl: number },
): KeywordCandidate[] {
  if (!termHits.length) return [];

  const dfByTerm = new Map<string, Set<string>>();
  for (const h of termHits) {
    const set = dfByTerm.get(h.term) ?? new Set<string>();
    set.add(h.chunkId);
    dfByTerm.set(h.term, set);
  }

  const perChunk = new Map<
    string,
    { score: number; terms: Set<string>; dl: number; minDf: number; codeMatched: boolean }
  >();
  for (const h of termHits) {
    const df = dfByTerm.get(h.term)?.size ?? 1;
    const s = bm25Score({ tf: h.tf, dl: h.dl, avgdl: stats.avgdl, df, n: stats.n });
    const isCode = CODE_LIKE_RE.test(h.term);
    const cur = perChunk.get(h.chunkId) ?? {
      score: 0,
      terms: new Set<string>(),
      dl: h.dl,
      minDf: df,
      codeMatched: false,
    };
    cur.score += isCode ? s * CODE_TERM_BOOST : s;
    cur.terms.add(h.term);
    cur.dl = h.dl;
    cur.minDf = Math.min(cur.minDf, df);
    if (isCode) cur.codeMatched = true;
    perChunk.set(h.chunkId, cur);
  }

  // 选择性 term 的 idf（覆盖率诊断用；过闸靠 selectiveHits / codeMatched）
  const selectiveDf = selectiveDfThreshold(stats.n);
  const idfByTerm = new Map<string, number>();
  for (const [term, chunks] of dfByTerm) {
    const df = chunks.size;
    if (df > selectiveDf) continue; // 泛词不参与（它们不决定相关性）
    const n = Math.max(stats.n, df);
    idfByTerm.set(term, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
  }
  const totalIdf = [...idfByTerm.values()].reduce((a, b) => a + b, 0);
  const hasSignal = totalIdf > 0 || dfByTerm.size > 0;

  if (!hasSignal) return [];

  return [...perChunk.entries()]
    .map(([chunkId, v]) => {
      const matchedIdf = [...v.terms].reduce((sum, t) => sum + (idfByTerm.get(t) ?? 0), 0);
      const selectiveHits = [...v.terms].filter((t) => idfByTerm.has(t)).length;
      return {
        chunkId,
        score: v.score,
        coverage: totalIdf > 0 ? matchedIdf / totalIdf : 0,
        minDf: v.minDf,
        codeMatched: v.codeMatched,
        selectiveHits,
      };
    })
    .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId));
}

/**
 * RRF 融合：每路给一个 id 名次列表，返回 id → 融合分。
 * 只取名次，不取原始分 —— 这就是它能跨量纲工作的原因。
 */
export function fuseRrf(
  lists: Array<{ source: HitSource; ids: string[]; weight?: number }>,
  k = RRF_K,
): Map<string, number> {
  const fused = new Map<string, number>();
  for (const list of lists) {
    const weight = list.weight ?? (list.source === "keyword" ? KEYWORD_RRF_WEIGHT : 1);
    list.ids.forEach((id, i) => {
      const rank = i + 1;
      fused.set(id, (fused.get(id) ?? 0) + weight / (k + rank));
    });
  }
  return fused;
}