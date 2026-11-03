/**
 * lib/coarse.ts —— 批量粗筛（方案 D 的「粗筛」层）
 *
 * 目的：**省 LLM 调用**。逐条精排每条要一次调用，195 条就是 195 次；
 * 而粗筛用**一次调用打包 10 条**，把大部分明显不行的条目挡在精排之外。
 *
 * ── 为什么批量大小取 10 ──
 * RoBatch（arXiv:2605.28268）实测：**AGNews（新闻分类）批量 ≤16 准确率保持，超过就掉**，
 * GSM8K 数学 ≤8，小模型 Qwen3-4B >50 掉得厉害。
 * 而且成本曲线在 8–16 区间已基本压平（无缓存下每百万条：1→8 降 75%，16→64 只再降 21%）。
 * 取 10 = 离 16 的悬崖留 60% 余量，同时落在成本曲线已压平的区间。
 *
 * ── 粗分只用于「排序」，绝不用于阈值判断 ──
 * 阈值 70 是用**逐条精排 prompt**（score-v1）在评测集上标定出来的
 * （Precision 100% / Recall 77.3%）。批量粗筛的分数分布与逐条不同（prompt 更短、
 * 上下文互相干扰），**拿粗分套 70 这个阈值会失真**。
 * 所以：粗分 → 排序 → 取 top K → **逐条精排（score-v1）** → 用精排分判阈值。
 * 这样阈值语义完全不变，评测集不用重做。
 *
 * ── 必须按 id 校验 ──
 * 批量返回可能漏条、串号、截断。漏掉的 id 要**单独重试**（而不是整批丢弃）——
 * 这是批量化的标准做法（nadir 的 RoBatch 实践：validate every answer by id,
 * and retry failures one at a time）。
 */

import { LLM_MESSAGES } from "./llm.ts";

/** 批量粗筛的默认批量大小（见文件头：RoBatch 的 16 悬崖前留余量） */
export const DEFAULT_COARSE_BATCH = 10;

/** 粗分范围：0–10 的粗粒度分（与精排同量纲，便于排序而非判阈值） */
export const COARSE_SCORE_MIN = 0;
export const COARSE_SCORE_MAX = 10;

export type CoarseCandidate = {
  contentKey: string;
  title: string;
  summary: string;
  sourceId: string;
};

export type CoarseResult = {
  contentKey: string;
  /** 粗分 0–10；null 表示这一批没返回它（重试后仍失败） */
  score: number | null;
  /** 失败原因（用于日志与统计） */
  error?: string;
};

/**
 * 粗筛 prompt（刻意做短）。
 *
 * 短的理由：粗筛的任务只是「把明显不行的排到后面」，不需要精排那种四维拆解；
 * prompt 短 → 一次调用打包 10 条的输入成本低得多。
 */
export const COARSE_SYSTEM_PROMPT = `你是 AI 资讯筛选助手。给你若干条资讯标题与摘要，请为每条打一个 0-10 的粗略分。
打分标准（只看标题与摘要，不要推测未提及的信息）：
- 9-10：重大发布/突破性进展，全行业值得关注
- 7-8：明确的技术或产品进展，对从业者有参考价值
- 5-6：常规更新、局部改进
- 3-4：边缘话题、影响有限
- 1-2：无关内容、营销、闲聊
只输出 JSON 数组，每个元素形如 {"id": 1, "score": 7}，id 是输入里的编号，不要输出其它文字。`;

/** 构建粗筛输入：编号列表（标题 + 摘要截断） */
export function buildCoarsePrompt(items: CoarseCandidate[]): string {
  const lines: string[] = [];
  items.forEach((it, i) => {
    const title = it.title.slice(0, 120);
    const summary = it.summary.slice(0, 180).trim();
    lines.push(`[${i + 1}] ${title}`);
    if (summary) lines.push(`    ${summary}`);
  });
  lines.push("");
  lines.push("请给上面每条打分，只输出 JSON 数组。");
  return lines.join("\n");
}

/**
 * 解析粗筛返回。
 *
 * 容错要点：
 *   - 允许 ```json 围栏
 *   - 允许模型返回对象包数组（`{"results":[...]}`）—— 两种形状都收
 *   - **按 id 校验**：不在输入范围内的 id 直接忽略
 *   - 分数 clamp 到 0–10；非数字视为该条失败
 *
 * @returns id → 分数（1-based，与输入编号对应）
 */
export function parseCoarse(content: string, count: number): Map<number, number> {
  const out = new Map<number, number>();
  const text = String(content ?? "").trim();
  if (!text) return out;

  const jsonText = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = jsonText.indexOf("[");
  const objStart = jsonText.indexOf("{");
  const objEnd = jsonText.lastIndexOf("}");
  const objEnd2 = jsonText.lastIndexOf("]");

  let arr: unknown = null;
  if (start >= 0 && objEnd2 > start) {
    try {
      arr = JSON.parse(jsonText.slice(start, objEnd2 + 1));
    } catch {
      arr = null;
    }
  }
  // 模型返回对象包数组的形状
  if (!Array.isArray(arr) && objStart >= 0 && objEnd > objStart) {
    try {
      const obj = JSON.parse(jsonText.slice(objStart, objEnd + 1)) as Record<string, unknown>;
      const inner = obj.results ?? obj.items ?? obj.scores ?? obj.data;
      if (Array.isArray(inner)) arr = inner;
    } catch {
      arr = null;
    }
  }

  if (!Array.isArray(arr)) return out;

  for (const entry of arr) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { id?: unknown; score?: unknown };
    const id = typeof e.id === "number" ? e.id : Number(e.id);
    if (!Number.isInteger(id) || id < 1 || id > count) continue; // id 越界 → 忽略
    const raw = typeof e.score === "number" ? e.score : Number(e.score);
    if (!Number.isFinite(raw)) continue; // 分数不是数字 → 该条失败
    out.set(id, Math.max(COARSE_SCORE_MIN, Math.min(COARSE_SCORE_MAX, raw)));
  }
  return out;
}

/**
 * 批量粗筛：把 items 分批，一次调用一批。
 *
 * 失败策略（分层，**不整批丢弃**）：
 *   1. 某批整体调用失败（网络/上游）→ 该批每条标记失败，不重试整批
 *   2. 某批返回成功但**漏了某些 id** → 漏掉的**单独重试一次**（单条一个调用）
 *   3. 单条重试仍失败 → 该条 score=null（不参与排序，等下次点击再粗筛）
 *
 * @param maxCalls 本次最多允许多少次外部调用（受 subrequest 预算约束）
 */
export async function coarseBatch(
  llm: {
    base: string;
    key: string;
    model: string;
    fetchImpl?: typeof fetch;
  },
  items: CoarseCandidate[],
  opts: { batchSize?: number; maxCalls?: number } = {},
): Promise<CoarseResult[]> {
  const size = Math.max(1, Math.min(opts.batchSize ?? DEFAULT_COARSE_BATCH, 20));
  const results: CoarseResult[] = items.map((it) => ({ contentKey: it.contentKey, score: null }));

  // 局部变量持有 fetch 实现（属性访问不会被 TS narrow）
  const doFetch: typeof fetch = llm.fetchImpl ?? fetch;

  let calls = 0;
  const maxCalls = opts.maxCalls ?? Number.POSITIVE_INFINITY;

  /** 发一次粗筛请求，返回 content（null = 失败） */
  const ask = async (batch: CoarseCandidate[], maxTokens: number): Promise<string | null> => {
    try {
      const res = await doFetch(`${llm.base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${llm.key}` },
        body: JSON.stringify({
          model: llm.model,
          messages: [
            { role: "system", content: COARSE_SYSTEM_PROMPT },
            { role: "user", content: buildCoarsePrompt(batch) },
          ],
          temperature: 0.1,
          max_tokens: maxTokens,
        }),
      });
      calls++;
      if (!res.ok) return null;
      const body = (await res.json().catch(() => null)) as {
        choices?: Array<{ message?: { content?: string } }>;
      } | null;
      return body?.choices?.[0]?.message?.content ?? null;
    } catch {
      calls++;
      return null;
    }
  };

  for (let i = 0; i < items.length; i += size) {
    if (calls >= maxCalls) break; // 预算耗尽 → 剩下的条目保持「无粗分」，下次再粗筛
    const batch = items.slice(i, i + size);
    const offset = i;

    const content = await ask(batch, 400);

    if (content === null) {
      for (let k = 0; k < batch.length; k++) {
        results[offset + k] = {
          contentKey: batch[k]!.contentKey,
          score: null,
          error: LLM_MESSAGES.upstream,
        };
      }
      continue;
    }

    const parsed = parseCoarse(content, batch.length);
    // 漏掉的 id → 单独重试
    for (let k = 0; k < batch.length; k++) {
      const it = batch[k]!;
      const score = parsed.get(k + 1);
      if (score !== undefined) {
        results[offset + k] = { contentKey: it.contentKey, score };
        continue;
      }
      // 单条重试（一次）
      let retryScore: number | undefined;
      if (calls < maxCalls) {
        const c = await ask([it], 100);
        if (c !== null) retryScore = parseCoarse(c, 1).get(1);
      }
      results[offset + k] =
        retryScore === undefined
          ? { contentKey: it.contentKey, score: null, error: "粗筛未返回该条" }
          : { contentKey: it.contentKey, score: retryScore };
    }
  }

  return results;
}
