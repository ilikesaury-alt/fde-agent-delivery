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
  const e = env as unknown as {
    DB?: D1Like;
    FEED_MAX_ITEMS?: string;
    FEED_TIMEOUT_MS?: string;
    /** 每轮抓取的源数上限（配合 CPU 预算） */
    FEED_SOURCE_LIMIT?: string;
  };

  if (!e.DB) {
    console.warn("[cron:fetch] 缺少 DB 绑定，跳过（抓取结果无处落库）");
    return;
  }

  // 审查 B-6：包 try/catch，失败要让 Cloudflare 记成失败而不是静默成功
  try {
    // 源数上限：外部 subrequest 预算 50/次（Free 套餐），14 个源 × 1 次 fetch = 14 次，
    // 留给 D1 与余量已足够；但源数可配，以便在 CPU 吃紧时先跑一部分。
    const sourceLimit = Number.parseInt(e.FEED_SOURCE_LIMIT ?? "14", 10) || 14;
    const sources = DEFAULT_SOURCES.slice(0, Math.max(1, sourceLimit));

    const result = await ingestFeeds({
      env: { FEED_MAX_ITEMS: e.FEED_MAX_ITEMS, FEED_TIMEOUT_MS: e.FEED_TIMEOUT_MS },
      sources,
      store: createD1Store(e.DB),
      // 单源取 15 条：实测解析耗时随条目数线性增长（与文档大小几乎无关），
      // 14 源在 maxItems=15 时合计 ≈19ms CPU，maxItems=40 时 ≈35ms ——
      // Cron 的 CPU 预算只有 10ms（Workers Free），必须压低。
      maxItems: Number.parseInt(e.FEED_MAX_ITEMS ?? "15", 10) || 15,
      timeoutMs: Number.parseInt(e.FEED_TIMEOUT_MS ?? "12000", 10) || 12000,
      concurrency: 3,
    });

    console.log(
      `[cron:fetch] 抓取 ${result.counts.fetched} / 去重 ${result.counts.kept} / ` +
        `新增 ${result.persisted?.inserted ?? 0} / 判重 ${result.persisted?.duplicates ?? 0} / ` +
        `失败源 ${result.failures.length} / 健康写入 ${result.healthRecorded ? "ok" : "失败"} / ${result.elapsedMs}ms`,
    );

    // 审查 A-5：存储失败不能静默 —— 打出错误让 Cloudflare 记录
    if (result.storage === "failed") {
      console.error(`[cron:fetch] 存储写入失败：${result.persistError ?? "未知原因"}`);
      throw new Error("storage failed");
    }
  } catch (err) {
    console.error(`[cron:fetch] 失败：${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
});