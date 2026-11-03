/**
 * lib/dedup.ts —— 标题去重（两层：L1 精确标题 + L2 SimHash 指纹）
 *
 * 目的：**省 LLM 调用**。同一个事件被多个源报道时，逐条评分是纯浪费
 * （每次调用都真花钱、都要等秒级响应）。去重放在**送 LLM 之前**，
 * 命中重复的条目直接标 dropped，一次调用都不花。
 *
 * 两层的分工（都是纯 CPU、零 API、零配额）：
 *   L1 归一化标题 + token Jaccard —— 精确、可解释，**同批次内**的主力
 *   L2 SimHash 64 位指纹 + 汉明距离 —— 近似、可持久化，**跨批次**（跨轮次）的主力
 *
 * ── 为什么必须带「数字签名」这道闸 ──
 * 2026-11-03 用 14 个源的真实标题标定（scripts/calibrate-dedup.ts）时发现：
 * 纯相似度会**把不同版本的公告合并**：
 *   "Introducing Gemini 3.8 Flash and 3.8 Flash Cyber"   jaccard 0.800  汉明 6
 *   "Introducing Gemini 3.6 Flash, 3.5 Flash-Lite, ..."  jaccard 0.800  汉明 6
 * 这两条是**不同的模型发布公告**，合并 = 丢一条资讯。
 * 而数字（版本号/型号/金额）是强否定信号：数字不同 → 绝不合并。
 * 加了这道闸之后，Gemini 系列的全部假阳性消失。
 *
 * ── 阈值是标定出来的，不是拍的 ──
 * 同一份真实数据（280 条 / 11 源）上的扫描结果：
 *   jaccard ≥ 0.50 → 合并 4 对（多合并了「Gemini 3.8 Live」两条不同公告）❌
 *   jaccard ≥ 0.55 → 合并 2 对（两对都是真重复）✅
 *   jaccard ≥ 0.667 → 合并 1 对（漏掉 GPT-6.1 Terra 那对，浮点边界）❌
 * 故取 0.55。
 *
 * SimHash 单独用**不安全**：实测汉明 12 的「Quoting Ted Sanders / Quoting Jason Koebler」
 * 是完全不同的文章。所以 L2 必须叠加数字签名闸，且汉明阈值取得很紧。
 */

/* ────────────────────────── 常量 ────────────────────────── */

/** L1：token Jaccard 阈值（真实数据标定，见文件头） */
export const DEFAULT_JACCARD_THRESHOLD = 0.55;

/** L2：SimHash 汉明距离阈值（≤6 时实测只有真重复；12 就有假阳性） */
export const DEFAULT_HAMMING_THRESHOLD = 6;

/** 跨批次比较时最多回看多少条历史（控制 CPU；3 天 ≈ 600 条） */
export const DEFAULT_HISTORY_LIMIT = 800;

/** 跨批次回看天数 */
export const DEFAULT_HISTORY_DAYS = 3;

/**
 * 英文停用词：去掉后「The Download」这类栏目名不会主导相似度。
 * 中文靠 bigram，不做停用词（去掉「的」「了」反而会切碎语义）。
 */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "at", "by", "from",
  "is", "are", "was", "were", "be", "been", "as", "that", "this", "it", "its", "new",
  "how", "why", "what", "when", "who", "will", "can", "has", "have", "not", "but",
  "you", "your", "we", "our", "they", "their", "he", "she", "his", "her",
]);

/* ────────────────────────── 类型 ────────────────────────── */

export type TitleFingerprint = {
  /** 归一化后的标题（小写、标点转空格、去多余空白） */
  norm: string;
  /** 词/字片段集合（L1 用） */
  tokens: string[];
  /** 数字签名：标题里所有数字（版本号等）。**不同则绝不合并** */
  numbers: string;
  /** 64 位 SimHash，拆成两个 uint32（JS 没有便宜的 64 位整数运算） */
  sh: [number, number];
};

/** 参与去重判定的最小信息 */
export type DedupCandidate = {
  /** 条目唯一键（内容 hash） */
  contentKey: string;
  title: string;
  /** 来源 id（用于日志与代表选择） */
  sourceId?: string;
};

/** 一组被判为同一事件的条目；index 0 是代表 */
export type DedupCluster = {
  /** 代表条目的下标（簇内最早出现 / 标题最长的那条） */
  representative: number;
  /** 簇内所有条目的下标 */
  members: number[];
  /** 合并依据（可解释，UI 与日志用） */
  reason: string;
};

export type DedupOptions = {
  jaccardThreshold?: number;
  hammingThreshold?: number;
};

export type DedupResult = {
  /** 去重后的簇（每个簇一条代表参与后续评分） */
  clusters: DedupCluster[];
  /** 代表条目的下标（相对入参顺序），便于直接取用 */
  representatives: number[];
  /** 被合并掉的条目下标 */
  merged: number[];
  /** 簇数 - 1 = 实际省下的条目数 */
  savedCount: number;
};

/* ────────────────────────── L1：归一化与分词 ────────────────────────── */

/**
 * 归一化标题：小写 → 标点转空格 → 压缩空白。
 *
 * ⚠️ **小数点也被当作标点转空格**（"3.8" → "3 8"）—— 这是刻意的：
 * 保留小数点会让它成为一个 token，使「Gemini 3.8 Live」两条不同公告的
 * Jaccard 从 0.50 升到 0.667，从而越过 0.55 阈值被误合并；
 * 而真正的跨源重复（"Introducing GPT-6.1 Terra" / "GPT-6.1 Terra"）
 * 会从 0.667 掉到 0.55 以下。两个真实用例正好卡在阈值两侧 ——
 * 所以版本号信息必须**单独**由「数字签名」承载，而不是混进 token 集。
 *
 * ⚠️ **不要**去掉 "Introducing" / "The Download" 这类前缀 ——
 * 实测数据显示，正是这些共享前缀让「同系列不同公告」落在 jaccard 0.5–0.8 区间，
 * 而数字签名闸负责把它们挡掉。去了前缀反而会放大误合并。
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s　]+/g, " ")
    // ASCII 标点 + 常见中文标点 → 空格
    .replace(/[!-/:-@[-`{-~]/g, " ")
    .replace(/[，。、；：？！“”‘’（）《》【】…—～·「」『』]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 分词：英文按词（去停用词），中文按字符 bigram。
 *
 * 为什么中文要 bigram：中文没有空格分隔，按词需要词典（Worker 里没有），
 * 而 bigram（相邻两字）对标题这种短文本足够稳，且与英文分支可以共存。
 */
export function tokenize(normalized: string): string[] {
  const words = normalized.split(" ").filter((w) => w.length > 1 && !STOPWORDS.has(w));
  const cjk = normalized.replace(/[^\p{Script=Han}]/gu, "");
  const bigrams: string[] = [];
  for (let i = 0; i + 1 < cjk.length; i++) bigrams.push(cjk.slice(i, i + 2));
  return [...words, ...bigrams];
}

/**
 * 数字签名：标题里所有数字（**保留小数点**），去重排序后用逗号连接。
 *
 * ⚠️ 必须从**原始标题**提取，不能从 normalizeTitle 的结果提取 ——
 * 归一化会把 "3.8" 拆成 "3 8"，签名会退化成 "3,8"，
 * 读起来不再是版本号（"3,8" 既可能是 3.8 也可能是 3 和 8 两个数）。
 *
 * 「Introducing Gemini 3.8 Flash」→ "3.8"
 * 「Gemini 3.6 Flash, 3.5 Flash-Lite」→ "3.5,3.6"
 * 数字不同 → 视为不同事件（版本不同）。
 */
export function numberSignature(rawTitle: string): string {
  const nums = rawTitle.match(/\d+(?:\.\d+)*/g) ?? [];
  return [...new Set(nums)].sort().join(",");
}

/* ────────────────────────── L1：Jaccard ────────────────────────── */

/** token 集合的 Jaccard 相似度 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/* ────────────────────────── L2：SimHash ────────────────────────── */

/** FNV-1a 32 位哈希 */
function hash32(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * SimHash：把 token 集合压成 64 位指纹。
 *
 * 原理：每个 token 哈希到 64 位，逐位投票（token 出现则 +1，否则 -1），
 * 每一位取多数。结果的性质：**集合越像，指纹的汉明距离越小**。
 * 好处是**定长可持久化**，跨批次比较只需比 64 位整数，不用重算 token 集。
 */
export function simhash(tokens: string[]): [number, number] {
  const acc = new Int32Array(64);
  for (const t of tokens) {
    const h = hash32(t);
    for (let i = 0; i < 32; i++) {
      acc[i] += (h >>> i) & 1 ? 1 : -1;
      acc[i + 32] += (h >>> (i + 1)) & 1 ? 1 : -1;
    }
  }
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < 32; i++) {
    if (acc[i] > 0) lo |= 1 << i;
    if (acc[i + 32] > 0) hi |= 1 << i;
  }
  return [lo >>> 0, hi >>> 0];
}

/** 32 位 popcount */
function popcount32(x: number): number {
  let v = x >>> 0;
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (Math.imul(v, 0x01010101) >>> 24) & 0xff;
}

/** 两个 64 位指纹的汉明距离（0–64） */
export function hamming64(a: [number, number], b: [number, number]): number {
  return popcount32((a[0] ^ b[0]) >>> 0) + popcount32((a[1] ^ b[1]) >>> 0);
}

/* ────────────────────────── 指纹 ────────────────────────── */

/** 算出一条标题的完整指纹 */
export function fingerprintOf(title: string): TitleFingerprint {
  const norm = normalizeTitle(title);
  const tokens = tokenize(norm);
  // 数字签名从原始标题取（保留小数点，见 numberSignature 注释）
  return { norm, tokens, numbers: numberSignature(title), sh: simhash(tokens) };
}

/* ────────────────────────── 判定 ────────────────────────── */

/**
 * 两条指纹是否属于同一事件。
 *
 * 判定顺序（短路，先便宜的）：
 *   1. 数字签名不同 → **直接否**（版本号不同 = 不同事件，硬闸）
 *   2. 归一化标题完全相同 → **直接是**（最强信号）
 *   3. Jaccard ≥ 阈值 → 是（L1）
 *   4. 汉明 ≤ 阈值 → 是（L2，近似）
 *
 * @returns 合并理由（用于可解释），null 表示不是重复
 */
export function duplicateReason(
  a: TitleFingerprint,
  b: TitleFingerprint,
  opts: DedupOptions = {},
): string | null {
  const jt = opts.jaccardThreshold ?? DEFAULT_JACCARD_THRESHOLD;
  const ht = opts.hammingThreshold ?? DEFAULT_HAMMING_THRESHOLD;

  // 硬闸：数字（版本号）不同，绝不合并
  if (a.numbers !== b.numbers) return null;

  // 最强信号：归一化后完全一样
  if (a.norm.length > 0 && a.norm === b.norm) return "标题完全相同";

  // L1：token 集合高度重叠
  const j = jaccard(new Set(a.tokens), new Set(b.tokens));
  if (j >= jt) return `标题相似度 ${(j * 100).toFixed(0)}%`;

  // L2：指纹接近（跨批次主力，同批次补充）
  const h = hamming64(a.sh, b.sh);
  if (h <= ht) return `标题指纹接近（汉明 ${h}）`;

  return null;
}

/* ────────────────────────── 同批次聚类 ────────────────────────── */

/**
 * 同批次内聚类（L1 + L2）。
 *
 * 性能：先用**数字签名分桶** —— 只有签名相同的才需要互比。
 * 实测 280 条里，签名过滤后只剩 612 个候选对（而非 37,820），
 * 因此全量两两比较完全放得进 Cron 的 10ms CPU 预算。
 *
 * @param items 参与判定的条目（顺序即下标顺序）
 */
export function clusterBySimilarity(
  items: Array<Pick<DedupCandidate, "contentKey" | "title">>,
  opts: DedupOptions = {},
): DedupResult {
  const fps = items.map((it) => fingerprintOf(it.title));

  // 数字签名分桶：桶内才互比
  const buckets = new Map<string, number[]>();
  fps.forEach((fp, idx) => {
    const key = fp.numbers;
    const arr = buckets.get(key);
    if (arr) arr.push(idx);
    else buckets.set(key, [idx]);
  });

  // 并查集：把「互为重复」的条目连成簇
  const parent = items.map((_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r]!;
    while (parent[x] !== r) {
      const next = parent[x]!;
      parent[x] = r;
      x = next;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const reasons = new Map<string, string>();
  for (const idxs of buckets.values()) {
    // 桶内两两比较
    for (let i = 0; i < idxs.length; i++) {
      for (let k = i + 1; k < idxs.length; k++) {
        const a = idxs[i]!;
        const b = idxs[k]!;
        const reason = duplicateReason(fps[a]!, fps[b]!, opts);
        if (!reason) continue;
        union(a, b);
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        if (!reasons.has(key)) reasons.set(key, reason);
      }
    }
  }

  // 汇总成簇
  const groups = new Map<number, number[]>();
  items.forEach((_, i) => {
    const r = find(i);
    const arr = groups.get(r);
    if (arr) arr.push(i);
    else groups.set(r, [i]);
  });

  const clusters: DedupCluster[] = [];
  const representatives: number[] = [];
  const merged: number[] = [];

  for (const members of groups.values()) {
    // 代表：簇内**标题最长**的那条（信息量最大，通常也最完整）
    let rep = members[0]!;
    for (const m of members) {
      if ((items[m]!.title.length > items[rep]!.title.length)) rep = m;
    }
    representatives.push(rep);
    for (const m of members) if (m !== rep) merged.push(m);
    // 理由取该簇内任意一对的理由
    let reason = "同一事件";
    if (members.length > 1) {
      const a = members[0]!;
      const b = members.find((m) => m !== a)!;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      reason = reasons.get(key) ?? "同一事件";
    }
    clusters.push({ representative: rep, members, reason });
  }

  return { clusters, representatives, merged, savedCount: merged.length };
}

/* ────────────────────────── 跨批次判定 ────────────────────────── */

/**
 * 跨批次（跨轮次）重复判定：当前条目 vs 历史条目。
 *
 * 场景：openai 上午发了公告，hn 下午才转载 —— 两轮抓取之间，
 * 同批次聚类抓不到它，但它们是同一个事件，不该评两次分。
 *
 * 判据用 **Jaccard（精确）+ 数字签名闸**，与同批次一致：
 * 实测 "Introducing GPT-6.1 Terra" vs "GPT-6.1 Terra" 的汉明距离是 10，
 * 超出 6 的阈值 —— 若拿汉明做粗筛会把真重复挡掉。
 * 性能不担心：30 条候选 × 800 条历史 × 约 15 次运算 ≈ 36 万次运算，
 * 远在 Cron 的 10ms CPU 预算内。
 */
export function findCrossBatchDuplicate(
  fp: TitleFingerprint,
  history: Array<{ contentKey: string; title: string }>,
  opts: DedupOptions = {},
): { contentKey: string; title: string; reason: string } | null {
  const jt = opts.jaccardThreshold ?? DEFAULT_JACCARD_THRESHOLD;

  for (const h of history) {
    // 数字签名不同 → 不可能是同一事件（先比便宜的字符串）
    if (numberSignature(h.title) !== fp.numbers) continue;

    const hFp = fingerprintOf(h.title);
    const j = jaccard(new Set(fp.tokens), new Set(hFp.tokens));
    if (j < jt) continue;

    return {
      contentKey: h.contentKey,
      title: h.title,
      reason: `与历史条目重复（${(j * 100).toFixed(0)}% 相似）`,
    };
  }
  return null;
}
