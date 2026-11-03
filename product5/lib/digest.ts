/**
 * lib/digest.ts —— 日报生成（纯函数，可单测、不触网）
 *
 * 固定 6 板块（沿用产品① 「固定板块」的思路，但内容物是跨源资讯）：
 *   ① 概览  ② 头条  ③ 值得一看  ④ 分源视角  ⑤ 源健康  ⑥ 口径与免责
 *
 * 为什么必须有「分源视角」和「多样性配额」（CONTEXT D11）：
 *   线上实测 top5 全是 arxiv-cs-ai（该源日更 40 篇、权威度天然高）。
 *   只按分数排序 → 日报会退化成「arXiv 摘要列表」，雷达就失去了「多源」的意义。
 *   规则：**同一源最多占精选的 1/3**，溢出名额顺延给次高分条目，并在日报里明示让位条数。
 *
 * 纪律：
 *  - 不编造：理由缺失就不写理由段；没有头条就明确写「今日无头条级资讯」
 *  - 可追溯：板块⑥ 固定写阈值 / 模型 / prompt 版本 —— 之后的分数可比性依赖它
 *  - 时间口径：`date` 是 UTC 日期（与 Cron 的 UTC 调度一致），不混用本地时区
 */

export type DigestItem = {
  title: string;
  link: string;
  sourceId: string;
  total: number;
  reason: string;
  publishedAt: number | null;
};

export type DigestSourceState = {
  id: string;
  name: string;
  level: string;
  itemCount: number;
  error?: string | null;
};

export type DigestCounts = {
  /** 窗口内新入库条目数（审查 A-4：不再复用全库 countItems） */
  fetched: number;
  /** 去重后条目数 */
  kept: number;
  /** 窗口内被去重丢弃的条数（ingest 时记录，缺省 0） */
  deduped?: number;
  /** 已评分条目数（当日库内总量） */
  scored: number;
  /** 过阈值条目数（配额前） */
  aboveThreshold: number;
  /** 最终入选条目数（配额后） */
  selected: number;
};

export type DigestInput = {
  /** UTC 日期 YYYY-MM-DD */
  date: string;
  /** 已评分条目（任意顺序；本函数内部按分数排序） */
  items: DigestItem[];
  threshold: number;
  topN: number;
  /** 单源入选上限（D11：topN 的 1/3，至少 1） */
  perSourceMax: number;
  counts: DigestCounts;
  sources: DigestSourceState[];
  model: string;
  promptVersion: string;
  /** 数据窗口（UTC 毫秒），写在日报头部让人知道「这是哪段时间的资讯」 */
  windowStart?: number;
  windowEnd?: number;
};

export type QuotaResult = {
  kept: DigestItem[];
  /** 因单源配额让位的条数（日报里明示，避免读者以为漏抓） */
  skippedByQuota: number;
  /** 因 topN 截断而落选的条数 */
  skippedByLimit: number;
};

/**
 * 阈值过滤 + 单源配额 + topN。
 * 顺序语义：先按分数降序，再逐条尝试入池（配额满则跳过），直到 topN 满。
 * 这样「让位」总是让给分数次高的**其它源**条目，而不是简单截断。
 */
export function selectWithQuota(
  items: DigestItem[],
  opts: { threshold: number; topN: number; perSourceMax: number },
): QuotaResult {
  const perSourceMax = Math.max(1, opts.perSourceMax);
  const topN = Math.max(0, opts.topN);
  const above = items
    .filter((i) => i.total >= opts.threshold)
    .sort((a, b) => b.total - a.total || (b.publishedAt ?? 0) - (a.publishedAt ?? 0));

  const kept: DigestItem[] = [];
  const perSource = new Map<string, number>();
  let skippedByQuota = 0;

  for (const item of above) {
    if (kept.length >= topN) break;
    const used = perSource.get(item.sourceId) ?? 0;
    if (used >= perSourceMax) {
      skippedByQuota++;
      continue;
    }
    perSource.set(item.sourceId, used + 1);
    kept.push(item);
  }

  // 剩余「过阈值但因 topN 落选」的条数（配额让位的不重复计入）
  const skippedByLimit = Math.max(0, above.length - kept.length - skippedByQuota);
  return { kept, skippedByQuota, skippedByLimit };
}

function fmtDate(ms: number | null): string {
  if (!ms) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function sourceNameOf(sources: DigestSourceState[], id: string): string {
  return sources.find((s) => s.id === id)?.name ?? id;
}

function bullet(item: DigestItem, sources: DigestSourceState[]): string {
  const reason = item.reason ? ` —— ${item.reason}` : "";
  return `- **[${item.total}] [${item.title}](${item.link})**${reason}\n  ${sourceNameOf(sources, item.sourceId)} · ${fmtDate(item.publishedAt)}`;
}

/** 头条级门槛：比精选阈值高 15 分（阈值 70 → 头条 85），随阈值联动不写死 */
export const HEADLINE_MARGIN = 15;

export function buildDigest(input: DigestInput): {
  markdown: string;
  quota: QuotaResult;
  headlineThreshold: number;
} {
  const headlineThreshold = input.threshold + HEADLINE_MARGIN;
  const quota = selectWithQuota(input.items, {
    threshold: input.threshold,
    topN: input.topN,
    perSourceMax: input.perSourceMax,
  });

  const headlines = quota.kept.filter((i) => i.total >= headlineThreshold);
  const rest = quota.kept.filter((i) => i.total < headlineThreshold);

  /** 分源视角：每个源给 1 条最高分（覆盖「只看头条会漏掉某个源」的盲区） */
  const bySource = new Map<string, DigestItem>();
  for (const item of [...input.items].sort((a, b) => b.total - a.total)) {
    if (item.total < input.threshold) continue;
    if (!bySource.has(item.sourceId)) bySource.set(item.sourceId, item);
  }

  const healthy = input.sources.filter((s) => s.level === "ok").length;
  const broken = input.sources.filter((s) => s.level === "broken");

  const lines: string[] = [];
  lines.push(`# AI 资讯雷达日报 · ${input.date}`);
  lines.push("");

  /* ① 概览 */
  lines.push("## 一、今日概览");
  lines.push("");
  if (input.windowStart && input.windowEnd) {
    lines.push(
      `- 数据窗口：${new Date(input.windowStart).toISOString().slice(0, 16).replace("T", " ")} ~ ` +
        `${new Date(input.windowEnd).toISOString().slice(0, 16).replace("T", " ")} UTC（按首次见到时间）`,
    );
  }
  lines.push(
    `- 窗口内新入库 **${input.counts.fetched}** 条 → 去重后 **${input.counts.kept}** 条` +
      (input.counts.deduped ? `（重复丢弃 ${input.counts.deduped} 条）` : "") +
      ` → 已评分 **${input.counts.scored}** 条`,
  );
  lines.push(
    `- 达到阈值（**${input.threshold}**）**${input.counts.aboveThreshold}** 条 → 入选 **${quota.kept.length}** 条` +
      (quota.skippedByQuota > 0 ? `（单源配额让位 ${quota.skippedByQuota} 条）` : ""),
  );
  lines.push(`- 源健康：${healthy}/${input.sources.length} 正常`);
  lines.push("");

  /* ② 头条 */
  lines.push(`## 二、头条（≥ ${headlineThreshold} 分）`);
  lines.push("");
  if (headlines.length === 0) {
    lines.push("_今日无头条级资讯。_");
  } else {
    for (const item of headlines) lines.push(bullet(item, input.sources));
  }
  lines.push("");

  /* ③ 值得一看 */
  lines.push(`## 三、值得一看（${input.threshold}–${headlineThreshold - 1} 分）`);
  lines.push("");
  if (rest.length === 0) {
    lines.push("_今日无其它入选资讯。_");
  } else {
    for (const item of rest) lines.push(bullet(item, input.sources));
  }
  lines.push("");

  /* ④ 分源视角 */
  lines.push("## 四、分源视角（每源最高分一条）");
  lines.push("");
  if (bySource.size === 0) {
    lines.push("_今日没有达到阈值的资讯。_");
  } else {
    for (const s of input.sources) {
      const item = bySource.get(s.id);
      if (!item) continue;
      lines.push(
        `- **${s.name}**：[${item.title}](${item.link})（${item.total} 分）`,
      );
    }
  }
  lines.push("");

  /* ⑤ 源健康 */
  lines.push("## 五、源健康");
  lines.push("");
  for (const s of input.sources) {
    const tag = s.level === "ok" ? "正常" : s.level === "degraded" ? "异常（条目骤降）" : "不可用";
    lines.push(
      `- ${s.name}：**${tag}**（${s.itemCount} 条）${s.error ? ` · 错误 \`${s.error}\`` : ""}`,
    );
  }
  if (broken.length > 0) {
    lines.push("");
    lines.push(`> ⚠️ ${broken.length} 个源本次不可用，日报内容可能因此不完整。`);
  }
  lines.push("");

  /* ⑥ 口径与免责 */
  lines.push("## 六、口径说明");
  lines.push("");
  lines.push(
    `- 评分：四维（相关性 0.4 / 新颖性 0.2 / 实用度 0.2 / 权威度 0.2）加权，满分 100`,
  );
  lines.push(`- 阈值：**${input.threshold}**（评测集标定：Precision 100% / Recall 77.3%，见 \`eval/report.md\`）`);
  lines.push(`- 模型：\`${input.model}\` · prompt：\`${input.promptVersion}\``);
  lines.push(`- 多样性：同一源最多 ${input.perSourceMax} 条（topN ${input.topN} 的 1/3），避免单源垄断`);
  if (input.windowStart && input.windowEnd) {
    lines.push(
      `- 窗口：按**首次见到时间**落在当日 UTC 区间内（不是发布时间 —— 源站时间常滞后/时区混乱）`,
    );
  }
  lines.push("- 生成时间：" + new Date().toISOString());
  lines.push("");

  return { markdown: lines.join("\n"), quota, headlineThreshold };
}