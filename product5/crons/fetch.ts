/**
 * Cron：抓取（每小时 :05，UTC）
 *
 * 为什么按阶段拆成三个 Cron：Free 套餐**每次 Cron 的 CPU 只有 10ms**、subrequest 上限 50/次。
 * 「抓取 + 评分 + 生成日报」塞进一次调度必然超预算：
 *   抓取（本文件 :05）→ 评分（:20）→ 日报（每天 00:30）
 * 每次只做一件事，单次预算可控；任一步失败也不会连带其它步骤。
 */

import { defineScheduled } from "void";

import { ingestFeeds } from "../lib/ingest.ts";
import { createD1Store, type D1Like } from "../lib/store.ts";
import { DEFAULT_SOURCES } from "../lib/sources.ts";

export const cron = "5 * * * *";

export default defineScheduled(async (_controller, env) => {
  const e = env as {
    DB?: D1Like;
    FEED_MAX_ITEMS?: string;
    FEED_TIMEOUT_MS?: string;
  };

  if (!e.DB) {
    console.warn("[cron:fetch] 缺少 DB 绑定，跳过（抓取结果无处落库）");
    return;
  }

  const result = await ingestFeeds({
    env: { FEED_MAX_ITEMS: e.FEED_MAX_ITEMS, FEED_TIMEOUT_MS: e.FEED_TIMEOUT_MS },
    sources: DEFAULT_SOURCES,
    store: createD1Store(e.DB),
    maxItems: Number.parseInt(e.FEED_MAX_ITEMS ?? "40", 10) || 40,
    timeoutMs: Number.parseInt(e.FEED_TIMEOUT_MS ?? "12000", 10) || 12000,
    concurrency: 3,
  });

  console.log(
    `[cron:fetch] 抓取 ${result.counts.fetched} / 去重 ${result.counts.kept} / ` +
      `新增 ${result.persisted?.inserted ?? 0} / 判重 ${result.persisted?.duplicates ?? 0} / ` +
      `失败源 ${result.failures.length} / ${result.elapsedMs}ms`,
  );
});