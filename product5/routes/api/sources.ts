/**
 * GET /api/sources —— 订阅源清单 + 各源健康历史
 *
 * 回答两个问题：
 *   1. 现在哪些源是坏的？（快照：lastHealth / lastError / lastItemCount / baseline）
 *   2. 某个源**什么时候开始坏的**？（历史：source_health 表）
 *
 * 为什么要有历史：feed 失效是常态（CONTEXT D10）。只有快照的话，用户看到「这个源坏了」
 * 但不知道「昨天还好好的」还是「烂了三个月」——后者说明该换源而不是重试。
 *
 * 查询参数：
 *   ?history=20   每个源返回最近 N 条历史（默认 20，上限 100）
 *   ?source=hn    只看某个源的历史
 */

import { defineHandler } from "void";

import { authorize, intEnv, jsonResponse, resolveStore } from "../../lib/http.ts";
import { DEFAULT_SOURCES } from "../../lib/sources.ts";
import type { FeedSource } from "../../lib/types.ts";

export const GET = defineHandler(async (c) => {
  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  const store = resolveStore(c);
  if (!store) return jsonResponse(200, { storage: "disabled", sources: [] });

  const historyLimit = intEnv(c.req.query("history"), 20);
  const only = c.req.query("source");

  try {
    const states = await store.listSourceStates();
    const stateById = new Map(states.map((s) => [s.sourceId, s]));

    // 以配置源为准（配置是全集；库里的行只是运行快照）
    const configured: FeedSource[] = only
      ? DEFAULT_SOURCES.filter((s) => s.id === only)
      : DEFAULT_SOURCES;

    const sources = await Promise.all(
      configured.map(async (s) => {
        const state = stateById.get(s.id);
        const history = await store.healthHistory(s.id, historyLimit);
        return {
          id: s.id,
          name: s.name,
          url: s.url,
          lang: s.lang,
          verified: s.verified,
          lastCheckedAt: state?.lastCheckedAt ?? null,
          lastHealth: state?.lastHealth ?? null,
          lastError: state?.lastError ?? null,
          lastItemCount: state?.lastItemCount ?? 0,
          baselineCount: state?.baselineCount ?? null,
          /** 连续失败次数（从历史尾部往前数；用于「已坏 N 次」） */
          consecutiveFailures: countConsecutiveFailures(history),
          history: history.map((h) => ({
            level: h.level,
            error: h.error,
            itemCount: h.itemCount,
            elapsedMs: h.elapsedMs,
            checkedAt: h.checkedAt,
          })),
        };
      }),
    );

    return jsonResponse(200, { storage: "ok", count: sources.length, sources });
  } catch {
    return jsonResponse(200, {
      storage: "unavailable",
      sources: [],
      message: "存储暂不可用（表可能尚未初始化）。",
    });
  }
});

/**
 * 连续失败次数：history 是**倒序**（最新在前），从索引 0 往回数连续的 broken。
 * 遇到第一个非 broken 就停 —— 那次成功之后又坏过，说明不是「一直坏」。
 */
function countConsecutiveFailures(
  history: Array<{ level: string }>,
): number {
  let n = 0;
  for (const h of history) {
    if (h.level === "broken") n++;
    else break;
  }
  return n;
}