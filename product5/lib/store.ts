/**
 * lib/store.ts —— 存储层（D1 实现 + 内存实现同接口）
 *
 * 为什么两份实现都在 lib/：本地 E2E/单测要跑完整链路（沙箱起不了 workerd），
 * 内存版是「本地可验证」的一等公民，不是测试专用假货（与产品③④ 同口径）。
 *
 * 设计纪律：
 *  - 去重靠**数据库唯一约束**（content_key = 归一化 URL 的 hash），不靠内存 Set ——
 *    重启/多实例下内存去重会失效，而资讯去重恰恰是跨请求的。
 *  - 入库失败**不拖垮抓取**：路由层捕获后降级（persisted=null + 错误字段），
 *    因为「抓到但没存上」比「整页 500」对用户更有用。
 *  - 语句按**绑定变量数**切批（D1 单条 SQL 绑定上限 100，产品③ 踩过线上 502）。
 */

import { hashId, normalizeUrl } from "./rss.ts";
import type { FeedSource, RawItem, SourceHealth } from "./types.ts";

/**
 * D1 绑定（只用到 store.ts 实际调用的子集）。
 *
 * 为什么要自己定义而不是用 `D1Database`：本仓的 `D1Like` 被四处当**结构类型**使用
 * （lib/http.ts · crons/*），而本地 e2e/d1-shim.mjs 的替身**不是**完整的 D1Database
 * （没有 raw() / meta 等）。定义一个窄接口能让替身与真实 D1 同时满足。
 *
 * `batch` 是**可选的**：真实 D1 有它，本地替身也实现了；
 * 但它可缺席 —— 这时写入路径回退到逐条 prepare().run()（功能不变，只是慢）。
 *
 * 为什么要 batch：Cloudflare 官方 limits —— D1 的**内部** subrequest 上限 1,000/次
 * （外部 50/次），而 `db.batch()` **整批只计 1 个 query**。
 * 扩源后一轮要写 200+ 条条目 + 14 源快照，逐条发会瞬间打满内部预算。
 */
export type D1Like = {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
      first<T = unknown>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
  /**
   * 可选：批量执行（整批计 1 个内部 subrequest）。
   * 参数用 `unknown[]` 接收 —— 真实 D1 收 D1PreparedStatement[]，本地替身收自己那套，
   * 这里不绑定具体形状，由调用方负责传入「已 bind 好的语句对象」。
   */
  batch?: (stmts: unknown[]) => Promise<Array<{ meta?: { changes?: number } } | undefined>>;
};

/** 每条资讯的持久化形态 */
export type StoredItem = {
  contentKey: string;
  /** 评分尝试次数（审查 A-1 修复：用于决定重试还是标 dead） */
  scoreAttempts?: number;
  /** 评分队列状态 */
  scoreState?: "pending" | "scored" | "dropped" | "dead";
  id: string;
  sourceId: string;
  title: string;
  link: string;
  publishedAt: number | null;
  summary: string;
  firstSeenAt: number;
  lastSeenAt: number;
};

export type SourceState = {
  sourceId: string;
  lastCheckedAt: number | null;
  lastHealth: string | null;
  lastError: string | null;
  lastItemCount: number;
  baselineCount: number | null;
};

export type HealthRow = {
  sourceId: string;
  level: string;
  error: string | null;
  itemCount: number;
  elapsedMs: number | null;
  checkedAt: number;
};

export type HealthRecord = {
  source: FeedSource;
  health: SourceHealth;
  /** 该源抓取耗时（毫秒），可空 */
  elapsedMs?: number;
};

export type SaveItemsResult = { inserted: number; duplicates: number };

/** 一条评分结果（落库形态） */
export type ScoreRow = {
  contentKey: string;
  relevance: number;
  novelty: number;
  usefulness: number;
  authority: number;
  total: number;
  reason: string;
  model: string;
  promptVersion: string;
};

export type RankedItem = StoredItem & { total: number; reason: string; scoredAt: number };

/** 一份日报（落库形态） */
export type DigestRecord = {
  date: string;
  markdown: string;
  threshold: number;
  perSourceMax: number;
  topN: number;
  counts: {
    fetched: number;
    kept: number;
    deduped?: number;
    scored: number;
    aboveThreshold: number;
    selected: number;
    skippedQuota: number;
  };
  model: string;
  promptVersion: string;
  /** 数据窗口（UTC 毫秒），审查 A-2 修复 */
  windowStart?: number;
  windowEnd?: number;
  /** 生成标识与来源，审查 B-3 修复（并发追溯） */
  generationId?: string;
  generationSource?: string;
  previousSelected?: number | null;
};

/** D1 实现里「通用部分」的类型：日报方法是后挂的，避免基对象声明重复要求 */
export type StoreBase = Omit<Store, "saveDigest" | "getDigest" | "listDigests" | "countItems" | "countScores">;

export type DigestSlim = {
  date: string;
  selected: number;
  threshold: number;
  updatedAt: number;
};

export type Store = {
  /** 读各源快照（baseline 用于判定「条目骤降」） */
  listSourceStates(): Promise<SourceState[]>;
  /** 入库条目，返回新增/重复数（去重靠 content_key 唯一约束） */
  saveItems(items: RawItem[], now?: number): Promise<SaveItemsResult>;
  /** 记录一次抓取的源健康（写历史 + 更新快照 + 抬升 baseline） */
  recordRun(records: HealthRecord[], now?: number): Promise<void>;
  /** 读持久化条目（增量 5 的 UI 与 /api/items 用） */
  recentItems(opts?: { limit?: number; sourceId?: string }): Promise<StoredItem[]>;
  /** 读某源健康历史（排查「什么时候开始坏的」） */
  healthHistory(sourceId: string, limit?: number): Promise<HealthRow[]>;
  /** 写评分（同一条只留最新一次：重评分是常态） */
  saveScores(rows: ScoreRow[], now?: number): Promise<number>;
  /**
   * 认领一批待评分条目（审查 A-1 / B-2 修复）。
   *
   * 与原 `listUnscored` 的区别：
   *   1. **按 score_attempts 升序**（不是 published_at 降序）—— 旧条目先评，避免新条目把队列饿死；
   *   2. **原子认领**（写 claimed_at 租约），并发的 cron 与手动请求不会拿到同一批；
   *   3. 租约过期（默认 10 分钟）的条目可被重新认领 —— worker 崩溃不会让队列永久卡死。
   */
  claimForScoring(limit: number, opts?: { leaseMs?: number; now?: number }): Promise<StoredItem[]>;
  /** 标记条目为已评分 / 丢弃 / 死亡，并记录尝试次数与错误 */
  markScored(
    results: Array<{
      contentKey: string;
      /** pending = 失败但未超上限，回到队列等下一轮重试 */
      state: "scored" | "dropped" | "dead" | "pending";
      error?: string;
    }>,
    now?: number,
  ): Promise<void>;
  /** 读达到阈值的条目（按总分倒序）—— 精选的数据源 */
  listTopScored(opts: { threshold: number; limit?: number }): Promise<RankedItem[]>;
  /**
   * 读**某个时间窗口内**达到阈值的条目（日报专用，审查 A-2 修复）。
   *
   * 窗口按 `first_seen_at` 判定：日报语义是「今天新出现的资讯」，
   * 而不是「全库累计的高分条目」—— 否则第 1 天与第 30 天的日报几乎逐字相同。
   */
  listTopScoredInWindow(opts: {
    threshold: number;
    sinceMs: number;
    untilMs: number;
    limit?: number;
  }): Promise<RankedItem[]>;
  /** 窗口内的计数（日报口径，审查 A-4 修复：不再复用全库 countItems） */
  windowStats(sinceMs: number, untilMs: number, threshold: number): Promise<{
    fetched: number;
    kept: number;
    deduped: number;
    scored: number;
    aboveThreshold: number;
  }>;
  /** 队列状态分布（运维/验收用：能看到有多少条 pending / dropped / dead） */
  queueStats(): Promise<Record<string, number>>;
  /** 写日报（同一天重跑 = 覆盖：日报是「该日最新结论」而非追加日志） */
  saveDigest(record: DigestRecord, now?: number): Promise<void>;
  getDigest(date: string): Promise<DigestRecord | null>;
  /** 日报列表（只给索引字段，不拉全文） */
  listDigests(limit?: number): Promise<DigestSlim[]>;
  /** 库内条目总数 / 已评分总数（日报口径统计用） */
  countItems(): Promise<number>;
  countScores(): Promise<number>;
};

export function contentKeyOf(item: Pick<RawItem, "link">): string {
  return hashId(normalizeUrl(item.link));
}

function timeOf(publishedAt: string | null): number | null {
  if (!publishedAt) return null;
  const ms = Date.parse(publishedAt);
  return Number.isFinite(ms) ? ms : null;
}

/* ─────────────────────────── 内存实现 ─────────────────────────── */

export function createMemoryStore(): Store & { _size(): { items: number; health: number; scores: number } } {
  const items = new Map<string, StoredItem>();
  const sources = new Map<string, SourceState>();
  const health: HealthRow[] = [];
  const scores = new Map<string, ScoreRow & { scoredAt: number }>();
  // 评分队列状态（审查 A-1 修复）：状态 / 尝试次数 / 租约 / 最后错误
  const itemState = new Map<string, "pending" | "scored" | "dropped" | "dead">();
  const itemAttempts = new Map<string, number>();
  const itemClaimedAt = new Map<string, number>();
  const itemLastError = new Map<string, string>();
  const digests = new Map<string, DigestRecord & { updatedAt: number }>();

  return {
    async listSourceStates() {
      return [...sources.values()];
    },

    async saveItems(raw, now = Date.now()) {
      let inserted = 0;
      let duplicates = 0;
      for (const item of raw) {
        const key = contentKeyOf(item);
        const existing = items.get(key);
        if (existing) {
          duplicates++;
          existing.lastSeenAt = now;
          // 标题/摘要可能被源站修订：以最新为准，但 first_seen_at 不动
          existing.title = item.title;
          existing.summary = item.summary;
          continue;
        }
        inserted++;
        items.set(key, {
          contentKey: key,
          id: item.id,
          sourceId: item.sourceId,
          title: item.title,
          link: item.link,
          publishedAt: timeOf(item.publishedAt),
          summary: item.summary,
          firstSeenAt: now,
          lastSeenAt: now,
        });
      }
      return { inserted, duplicates };
    },

    async recordRun(records, now = Date.now()) {
      for (const r of records) {
        health.push({
          sourceId: r.source.id,
          level: r.health.level,
          error: r.health.error ?? null,
          itemCount: r.health.itemCount,
          elapsedMs: r.elapsedMs ?? null,
          checkedAt: now,
        });
        const prev = sources.get(r.source.id);
        const baseline =
          r.health.level === "ok"
            ? Math.max(prev?.baselineCount ?? 0, r.health.itemCount)
            : (prev?.baselineCount ?? null);
        sources.set(r.source.id, {
          sourceId: r.source.id,
          lastCheckedAt: now,
          lastHealth: r.health.level,
          lastError: r.health.error ?? null,
          lastItemCount: r.health.itemCount,
          baselineCount: baseline,
        });
      }
    },

    async recentItems(opts = {}) {
      const limit = opts.limit ?? 50;
      return [...items.values()]
        .filter((i) => (opts.sourceId ? i.sourceId === opts.sourceId : true))
        .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0) || b.lastSeenAt - a.lastSeenAt)
        .slice(0, limit);
    },

    async healthHistory(sourceId, limit = 20) {
      return health
        .filter((h) => h.sourceId === sourceId)
        .sort((a, b) => b.checkedAt - a.checkedAt)
        .slice(0, limit);
    },

    async saveScores(rows, now = Date.now()) {
      for (const r of rows) scores.set(r.contentKey, { ...r, scoredAt: now });
      return rows.length;
    },

    async claimForScoring(limit, opts = {}) {
      const now = opts.now ?? Date.now();
      const leaseMs = opts.leaseMs ?? 10 * 60_000;
      const eligible = [...items.values()]
        .filter((i) => {
          const st = itemState.get(i.contentKey) ?? "pending";
          if (st !== "pending") return false;
          const claimed = itemClaimedAt.get(i.contentKey);
          // 未被认领，或租约已过期（worker 崩溃后自动回收）
          return claimed === undefined || now - claimed > leaseMs;
        })
        // 关键（审查 A-1）：按尝试次数升序，让旧条目先被评，避免被新条目饿死
        // ⚠️ 2026-11-03 修正：同 attempts 时**取最旧**（published_at ASC）而非最新。
        //    原为 DESC → 永远先评最新条目，旧条目持续积压（线上实测 pending 394 条只增不减）。
        //    必须与 D1 版的 ORDER BY 保持一致，否则两个 Store 实现行为分叉。
        .sort((a, b) => {
          const da = itemAttempts.get(a.contentKey) ?? 0;
          const db = itemAttempts.get(b.contentKey) ?? 0;
          if (da !== db) return da - db;
          return (a.publishedAt ?? 0) - (b.publishedAt ?? 0);
        })
        .slice(0, limit);

      for (const it of eligible) itemClaimedAt.set(it.contentKey, now);
      return eligible;
    },

    async markScored(results, now = Date.now()) {
      for (const r of results) {
        itemState.set(r.contentKey, r.state);
        itemClaimedAt.delete(r.contentKey);
        if (r.state === "scored") {
          itemAttempts.set(r.contentKey, (itemAttempts.get(r.contentKey) ?? 0) + 1);
          itemLastError.delete(r.contentKey);
        } else if (r.state === "pending") {
          itemAttempts.set(r.contentKey, (itemAttempts.get(r.contentKey) ?? 0) + 1);
          if (r.error) itemLastError.set(r.contentKey, r.error);
        } else if (r.error) {
          itemLastError.set(r.contentKey, r.error);
        }
      }
      void now;
    },

    async listTopScoredInWindow(opts) {
      const out: RankedItem[] = [];
      for (const sc of scores.values()) {
        if (sc.total < opts.threshold) continue;
        const item = items.get(sc.contentKey);
        if (!item) continue;
        if (item.firstSeenAt < opts.sinceMs || item.firstSeenAt >= opts.untilMs) continue;
        out.push({ ...item, total: sc.total, reason: sc.reason, scoredAt: sc.scoredAt });
      }
      return out.sort((a, b) => b.total - a.total).slice(0, Math.max(1, opts.limit ?? 200));
    },

    async windowStats(sinceMs, untilMs, threshold) {
      let fetched = 0;
      let scored = 0;
      let above = 0;
      for (const item of items.values()) {
        if (item.firstSeenAt < sinceMs || item.firstSeenAt >= untilMs) continue;
        fetched++;
        const sc = scores.get(item.contentKey);
        if (sc) {
          scored++;
          if (sc.total >= threshold) above++;
        }
      }
      // 窗口内「去重丢弃数」无法从存储反推（只有 ingest 时知道），由调用方传入或记 0
      return { fetched, kept: fetched, deduped: 0, scored, aboveThreshold: above };
    },

    async queueStats() {
      const out: Record<string, number> = { pending: 0, scored: 0, dropped: 0, dead: 0 };
      for (const item of items.values()) {
        const st = itemState.get(item.contentKey) ?? (scores.has(item.contentKey) ? "scored" : "pending");
        out[st] = (out[st] ?? 0) + 1;
      }
      return out;
    },

    async listTopScored(opts) {
      const out: RankedItem[] = [];
      for (const sc of scores.values()) {
        if (sc.total < opts.threshold) continue;
        const item = items.get(sc.contentKey);
        if (!item) continue;
        out.push({ ...item, total: sc.total, reason: sc.reason, scoredAt: sc.scoredAt });
      }
      return out.sort((a, b) => b.total - a.total).slice(0, Math.max(1, opts.limit ?? 20));
    },

    async saveDigest(record, now = Date.now()) {
      digests.set(record.date, { ...record, updatedAt: now });
    },

    async getDigest(date) {
      const d = digests.get(date);
      return d ? { ...d } : null;
    },

    async listDigests(limit = 20) {
      return [...digests.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit)
        .map((d) => ({ date: d.date, selected: d.counts.selected, threshold: d.threshold, updatedAt: d.updatedAt }));
    },

    async countItems() {
      return items.size;
    },

    async countScores() {
      return scores.size;
    },

    _size() {
      return { items: items.size, health: health.length, scores: scores.size };
    },
  };
}

/* ─────────────────────────── D1 实现 ─────────────────────────── */

/** 单条 SQL 绑定变量上限 100（产品③ 线上踩过 502）；每行 8 列 → 每批 10 行留余量 */
const ROWS_PER_CHUNK = 10;

type ItemRow = {
  content_key: string;
  score_state?: string;
  score_attempts?: number;
  claimed_at?: number | null;
  last_error?: string | null;
  id: string;
  source_id: string;
  title: string;
  link: string;
  published_at: number | null;
  summary: string;
  first_seen_at: number;
  last_seen_at: number;
};

export function createD1Store(db: D1Like): Store {
  const base: StoreBase = {
    async listSourceStates() {
      const res = await db
        .prepare(
          `SELECT id, last_checked_at, last_health, last_error, last_item_count, baseline_count FROM sources`,
        )
        .bind()
        .all<{
          id: string;
          last_checked_at: number | null;
          last_health: string | null;
          last_error: string | null;
          last_item_count: number;
          baseline_count: number | null;
        }>();
      return (res.results ?? []).map((r) => ({
        sourceId: r.id,
        lastCheckedAt: r.last_checked_at ?? null,
        lastHealth: r.last_health ?? null,
        lastError: r.last_error ?? null,
        lastItemCount: r.last_item_count ?? 0,
        baselineCount: r.baseline_count ?? null,
      }));
    },

    async saveItems(raw, now = Date.now()) {
      if (raw.length === 0) return { inserted: 0, duplicates: 0 };

      // 同一批内也要先去重（同一链接可能在多个源里同时出现）
      const unique = new Map<string, RawItem>();
      for (const item of raw) unique.set(contentKeyOf(item), item);
      const rows = [...unique.entries()];

      // ⚠️ 2026-11-03 重构写入路径以走 db.batch()。
      // 原因：扩源到 14 源后，一轮要写 200+ 条条目 + 14 条源快照。
      //   逐条 prepare().run() = 200+ 次 D1 往返 → 打满内部 subrequest 预算
      //   （官方 limits：D1 内部 1,000/次，但外部只有 50/次，且 batch 整批只计 1 个）。
      // 现在：**所有 INSERT / UPDATE 拼成一批**交给 db.batch()（计 1 个 query）。
      //
      // 单条 SQL 最多 100 个绑定参数（D1 官方限制），本 INSERT 有 9 列 → 每条最多 11 行。
      const INSERT_SQL = `INSERT OR IGNORE INTO items
         (content_key, id, source_id, title, link, published_at, summary, first_seen_at, last_seen_at)
         VALUES `;
      const UPDATE_SQL = `UPDATE items SET last_seen_at = ?, title = ?, summary = ? WHERE content_key = ?`;

      const stmts: Array<{ sql: string; values: unknown[] }> = [];
      for (let i = 0; i < rows.length; i += ROWS_PER_CHUNK) {
        const chunk = rows.slice(i, i + ROWS_PER_CHUNK);
        const placeholders = chunk.map(() => "(?,?,?,?,?,?,?,?,?)").join(",");
        const values = chunk.flatMap(([key, item]) => [
          key,
          item.id,
          item.sourceId,
          item.title,
          item.link,
          timeOf(item.publishedAt),
          item.summary,
          now,
          now,
        ]);
        stmts.push({ sql: INSERT_SQL + placeholders, values });
      }

      // 已存在的条目：更新 last_seen_at + title/summary（源站会修订标题），first_seen_at 不动
      //
      // 审查 B-4：原实现 D1 只 UPDATE last_seen_at，而内存实现会覆盖 title/summary ——
      // 两个「同接口」实现语义不同，导致「单测/本地 E2E 看到新标题、线上永远是首见版本」。
      // 现在 D1 也更新 title/summary，两边一致。
      for (const [key, item] of rows) {
        stmts.push({ sql: UPDATE_SQL, values: [now, item.title, item.summary, key] });
      }

      let inserted = 0;
      if (db.batch) {
        // 真实 D1 签名：batch 收 D1PreparedStatement[]，每个语句自己 .bind()
        const prepared = stmts.map((s) => db.prepare(s.sql).bind(...s.values));
        const res = await db.batch(prepared);
        // batch 按语句顺序返回结果：前 N 条是 INSERT（分片数），其余是 UPDATE
        const insertCount = Math.ceil(rows.length / ROWS_PER_CHUNK);
        for (const r of res.slice(0, insertCount)) inserted += r?.meta?.changes ?? 0;
      } else {
        // 回退路径（无 batch 的 D1 替身）：逐条执行，语义一致
        for (const s of stmts) {
          const res = (await db.prepare(s.sql).bind(...s.values).run()) as {
            meta?: { changes?: number };
          } | undefined;
          if (s.sql.startsWith("INSERT")) inserted += res?.meta?.changes ?? 0;
        }
      }

      return { inserted, duplicates: rows.length - inserted };
    },

    async recordRun(records, now = Date.now()) {
      // ⚠️ 2026-11-03：改为 batch —— 14 源 × 2 条 = 28 次往返 → 1 个 batch。
      // 与 saveItems 同一理由（Cloudflare 官方 limits：batch 整批只计 1 个内部 subrequest）。
      const HEALTH_SQL = `INSERT INTO source_health (source_id, level, error, item_count, elapsed_ms, checked_at)
         VALUES (?,?,?,?,?,?)`;
      const SOURCE_SQL = `INSERT INTO sources
         (id, name, url, lang, verified, last_checked_at, last_health, last_error, last_item_count, baseline_count, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           url = excluded.url,
           lang = excluded.lang,
           verified = excluded.verified,
           last_checked_at = excluded.last_checked_at,
           last_health = excluded.last_health,
           last_error = excluded.last_error,
           last_item_count = excluded.last_item_count,
           baseline_count = CASE
             WHEN excluded.last_health = 'ok'
               THEN MAX(COALESCE(sources.baseline_count, 0), excluded.last_item_count)
             ELSE sources.baseline_count
           END,
           updated_at = excluded.updated_at`;

      const stmts: Array<{ sql: string; values: unknown[] }> = [];
      for (const r of records) {
        stmts.push({
          sql: HEALTH_SQL,
          values: [
            r.source.id,
            r.health.level,
            r.health.error ?? null,
            r.health.itemCount,
            r.elapsedMs ?? null,
            now,
          ],
        });

        // baseline 只在「正常且更多」时抬升（避免坏源把基线一起拉低）
        stmts.push({
          sql: SOURCE_SQL,
          values: [
            r.source.id,
            r.source.name,
            r.source.url,
            r.source.lang,
            r.source.verified ? 1 : 0,
            now,
            r.health.level,
            r.health.error ?? null,
            r.health.itemCount,
            r.health.level === "ok" ? r.health.itemCount : null,
            now,
            now,
          ],
        });
      }
      if (stmts.length === 0) return;

      if (db.batch) {
        const prepared = stmts.map((s) => db.prepare(s.sql).bind(...s.values));
        await db.batch(prepared);
      } else {
        for (const s of stmts) await db.prepare(s.sql).bind(...s.values).run();
      }
    },

    async recentItems(opts = {}) {
      const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
      const sql = opts.sourceId
        ? `SELECT * FROM items WHERE source_id = ? ORDER BY COALESCE(published_at, 0) DESC, last_seen_at DESC LIMIT ?`
        : `SELECT * FROM items ORDER BY COALESCE(published_at, 0) DESC, last_seen_at DESC LIMIT ?`;
      const stmt = db.prepare(sql);
      const res = opts.sourceId
        ? await stmt.bind(opts.sourceId, limit).all<ItemRow>()
        : await stmt.bind(limit).all<ItemRow>();
      return (res.results ?? []).map(rowToItem);
    },

    async saveScores(rows, now = Date.now()) {
      if (rows.length === 0) return 0;
      let written = 0;
      const placeholders = "(?,?,?,?,?,?,?,?,?,?)";
      // 10 列 × 9 行 = 90 < 100（D1 绑定上限）
      for (let i = 0; i < rows.length; i += 9) {
        const chunk = rows.slice(i, i + 9);
        const sql =
          `INSERT INTO scores
             (content_key, relevance, novelty, usefulness, authority, total, reason, model, prompt_version, scored_at)
           VALUES ${chunk.map(() => placeholders).join(",")}
           ON CONFLICT(content_key) DO UPDATE SET
             relevance = excluded.relevance,
             novelty = excluded.novelty,
             usefulness = excluded.usefulness,
             authority = excluded.authority,
             total = excluded.total,
             reason = excluded.reason,
             model = excluded.model,
             prompt_version = excluded.prompt_version,
             scored_at = excluded.scored_at`;
        const values = chunk.flatMap((r) => [
          r.contentKey,
          r.relevance,
          r.novelty,
          r.usefulness,
          r.authority,
          r.total,
          r.reason,
          r.model,
          r.promptVersion,
          now,
        ]);
        await db.prepare(sql).bind(...values).run();
        written += chunk.length;
      }
      return written;
    },

    async claimForScoring(limit, opts = {}) {
      const now = opts.now ?? Date.now();
      const leaseMs = opts.leaseMs ?? 10 * 60_000;
      const leaseCutoff = now - leaseMs;
      const capped = Math.max(1, Math.min(limit, 50));

      // ① 先选出候选（未认领或租约已过期），按 attempts 升序 —— 旧条目先评，避免饿死
      //
      // ⚠️ 2026-11-03 修正排序：原为 `score_attempts ASC, published_at DESC`，
      // 看起来「旧条目先评」，但实际上 attempts 相同的条目（绝大多数是 0）会按
      // **发布时间倒序**取，也就是**永远先评最新、最旧的一直排最后** →
      // 队列会持续堆积（实测 pending 394 条且只增不减），旧条目饿死。
      //
      // 改成 `published_at ASC`（最旧优先）：因为 attempts 升序已把「该重试的失败条目」
      // 顶到前面，同 attempts 时取最旧 —— 两个目标（重试优先 + 旧条目不饿死）同时满足。
      const res = await db
        .prepare(
          `SELECT content_key FROM items
            WHERE score_state = 'pending'
              AND (claimed_at IS NULL OR claimed_at < ?)
            ORDER BY score_attempts ASC, COALESCE(published_at, 0) ASC
            LIMIT ?`,
        )
        .bind(leaseCutoff, capped)
        .all<{ content_key: string }>();

      const keys = (res.results ?? []).map((r) => r.content_key);
      if (keys.length === 0) return [];

      // ② 原子认领（只认领仍未被别人拿走的行）—— 并发下 cron 与手动不会拿到同一批
      const marks = keys.map(() => "?").join(",");
      await db
        .prepare(`UPDATE items SET claimed_at = ? WHERE content_key IN (${marks})`)
        .bind(now, ...keys)
        .run();

      // ③ 回读完整行（保持认领顺序）
      const rows = await db
        .prepare(`SELECT * FROM items WHERE content_key IN (${marks})`)
        .bind(...keys)
        .all<ItemRow>();
      const byKey = new Map((rows.results ?? []).map((r) => [r.content_key, rowToItem(r)]));
      return keys.map((k) => byKey.get(k)).filter((x): x is StoredItem => Boolean(x));
    },

    async markScored(results, now = Date.now()) {
      // 按状态分组批量更新（每类一条 SQL，避免 N 次往返吃 subrequest 预算）
      const scored = results.filter((r) => r.state === "scored").map((r) => r.contentKey);
      const dropped = results.filter((r) => r.state === "dropped").map((r) => r.contentKey);
      const dead = results.filter((r) => r.state === "dead").map((r) => r.contentKey);
      const retry = results.filter((r) => r.state === "pending");

      const chunk = async (keys: string[], state: string, incAttempts: boolean) => {
        for (let i = 0; i < keys.length; i += 90) {
          const slice = keys.slice(i, i + 90);
          const marks = slice.map(() => "?").join(",");
          await db
            .prepare(
              `UPDATE items
                  SET score_state = ?, claimed_at = NULL, last_error = NULL,
                      score_attempts = score_attempts ${incAttempts ? "+ 1" : ""}
                WHERE content_key IN (${marks})`,
            )
            .bind(state, ...slice)
            .run();
        }
      };

      await chunk(scored, "scored", true);
      await chunk(dropped, "dropped", false);
      await chunk(dead, "dead", false);

      // 失败但未超上限 → 回到 pending 并 +1 尝试次数（租约释放，下轮可重试）
      for (const r of retry) {
        await db
          .prepare(
            `UPDATE items SET score_state = 'pending', claimed_at = NULL,
                    score_attempts = score_attempts + 1, last_error = ?
              WHERE content_key = ?`,
          )
          .bind(r.error ?? null, r.contentKey)
          .run();
      }
      void now;
    },

    async listTopScoredInWindow(opts) {
      const res = await db
        .prepare(
          `SELECT i.*, s.total AS score_total, s.reason AS score_reason, s.scored_at AS score_at
             FROM scores s JOIN items i ON i.content_key = s.content_key
            WHERE s.total >= ?
              AND i.first_seen_at >= ? AND i.first_seen_at < ?
            ORDER BY s.total DESC, COALESCE(i.published_at, 0) DESC
            LIMIT ?`,
        )
        .bind(opts.threshold, opts.sinceMs, opts.untilMs, Math.max(1, Math.min(opts.limit ?? 200, 500)))
        .all<ItemRow & { score_total: number; score_reason: string; score_at: number }>();
      return (res.results ?? []).map((r) => ({
        ...rowToItem(r),
        total: r.score_total,
        reason: r.score_reason ?? "",
        scoredAt: r.score_at,
      }));
    },

    async windowStats(sinceMs, untilMs, threshold) {
      const win = `first_seen_at >= ? AND first_seen_at < ?`;
      const fetchedRow = await db
        .prepare(`SELECT COUNT(*) AS n FROM items WHERE ${win}`)
        .bind(sinceMs, untilMs)
        .first<{ n: number }>();
      const scoredRow = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM scores s JOIN items i ON i.content_key = s.content_key
            WHERE i.${win}`,
        )
        .bind(sinceMs, untilMs)
        .first<{ n: number }>();
      const aboveRow = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM scores s JOIN items i ON i.content_key = s.content_key
            WHERE i.${win} AND s.total >= ?`,
        )
        .bind(sinceMs, untilMs, threshold)
        .first<{ n: number }>();
      const fetched = Number(fetchedRow?.n ?? 0);
      return {
        fetched,
        kept: fetched,
        // 窗口内被去重丢弃的条数无法从存储反推（只有 ingest 时知道），由调用方补
        deduped: 0,
        scored: Number(scoredRow?.n ?? 0),
        aboveThreshold: Number(aboveRow?.n ?? 0),
      };
    },

    async queueStats() {
      const res = await db
        .prepare(`SELECT score_state, COUNT(*) AS n FROM items GROUP BY score_state`)
        .bind()
        .all<{ score_state: string; n: number }>();
      const out: Record<string, number> = {};
      for (const r of res.results ?? []) out[r.score_state] = Number(r.n);
      return out;
    },

    async listTopScored(opts) {
      const res = await db
        .prepare(
          `SELECT i.*, s.total AS score_total, s.reason AS score_reason, s.scored_at AS score_at
             FROM scores s JOIN items i ON i.content_key = s.content_key
            WHERE s.total >= ?
            ORDER BY s.total DESC, COALESCE(i.published_at, 0) DESC
            LIMIT ?`,
        )
        .bind(opts.threshold, Math.max(1, Math.min(opts.limit ?? 20, 1000)))
        .all<ItemRow & { score_total: number; score_reason: string; score_at: number }>();
      return (res.results ?? []).map((r) => ({
        ...rowToItem(r),
        total: r.score_total,
        reason: r.score_reason ?? "",
        scoredAt: r.score_at,
      }));
    },

    async healthHistory(sourceId, limit = 20) {
      const res = await db
        .prepare(
          `SELECT source_id, level, error, item_count, elapsed_ms, checked_at
             FROM source_health WHERE source_id = ? ORDER BY checked_at DESC LIMIT ?`,
        )
        .bind(sourceId, Math.max(1, Math.min(limit, 200)))
        .all<{
          source_id: string;
          level: string;
          error: string | null;
          item_count: number;
          elapsed_ms: number | null;
          checked_at: number;
        }>();
      return (res.results ?? []).map((r) => ({
        sourceId: r.source_id,
        level: r.level,
        error: r.error ?? null,
        itemCount: r.item_count,
        elapsedMs: r.elapsed_ms ?? null,
        checkedAt: r.checked_at,
      }));
    },
  };
  return attachDigestMethods(base, db);
}

/* ── 日报（D1） ── */
function attachDigestMethods(store: StoreBase, db: D1Like): Store {
  return {
    ...store,
    async saveDigest(record, now = Date.now()) {
      await db
        .prepare(
          `INSERT INTO daily
             (date, markdown, threshold, per_source_max, top_n, fetched, kept, deduped, scored,
              above_threshold, selected, skipped_quota, model, prompt_version,
              window_start, window_end, generation_id, generation_source, previous_selected,
              created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(date) DO UPDATE SET
             markdown = excluded.markdown,
             threshold = excluded.threshold,
             per_source_max = excluded.per_source_max,
             top_n = excluded.top_n,
             fetched = excluded.fetched,
             kept = excluded.kept,
             deduped = excluded.deduped,
             scored = excluded.scored,
             above_threshold = excluded.above_threshold,
             selected = excluded.selected,
             skipped_quota = excluded.skipped_quota,
             model = excluded.model,
             prompt_version = excluded.prompt_version,
             window_start = excluded.window_start,
             window_end = excluded.window_end,
             generation_id = excluded.generation_id,
             generation_source = excluded.generation_source,
             previous_selected = excluded.previous_selected,
             updated_at = excluded.updated_at`
        )
        .bind(
          record.date,
          record.markdown,
          record.threshold,
          record.perSourceMax,
          record.topN,
          record.counts.fetched,
          record.counts.kept,
          record.counts.deduped ?? 0,
          record.counts.scored,
          record.counts.aboveThreshold,
          record.counts.selected,
          record.counts.skippedQuota,
          record.model,
          record.promptVersion,
          record.windowStart ?? null,
          record.windowEnd ?? null,
          record.generationId ?? null,
          record.generationSource ?? "cron",
          record.previousSelected ?? null,
          now,
          now,
        )
        .run();
    },

    async getDigest(date) {
      const row = await db
        .prepare(`SELECT * FROM daily WHERE date = ?`)
        .bind(date)
        .first<{
          date: string;
          markdown: string;
          threshold: number;
          per_source_max: number;
          top_n: number;
          fetched: number;
          kept: number;
          scored: number;
          above_threshold: number;
          selected: number;
          skipped_quota: number;
          model: string;
          prompt_version: string;
        }>();
      if (!row) return null;
      return {
        date: row.date,
        markdown: row.markdown,
        threshold: row.threshold,
        perSourceMax: row.per_source_max,
        topN: row.top_n,
        counts: {
          fetched: row.fetched,
          kept: row.kept,
          deduped: (row as { deduped?: number }).deduped ?? 0,
          scored: row.scored,
          aboveThreshold: row.above_threshold,
          selected: row.selected,
          skippedQuota: row.skipped_quota,
        },
        model: row.model,
        promptVersion: row.prompt_version,
        windowStart: (row as { window_start?: number }).window_start ?? undefined,
        windowEnd: (row as { window_end?: number }).window_end ?? undefined,
        generationId: (row as { generation_id?: string }).generation_id ?? undefined,
        generationSource: (row as { generation_source?: string }).generation_source ?? undefined,
        previousSelected: (row as { previous_selected?: number }).previous_selected ?? null,
      };
    },

    async listDigests(limit = 20) {
      const res = await db
        .prepare(`SELECT date, selected, threshold, updated_at FROM daily ORDER BY date DESC LIMIT ?`)
        .bind(Math.max(1, Math.min(limit, 100)))
        .all<{ date: string; selected: number; threshold: number; updated_at: number }>();
      return (res.results ?? []).map((r) => ({
        date: r.date,
        selected: r.selected,
        threshold: r.threshold,
        updatedAt: r.updated_at,
      }));
    },

    async countItems() {
      const row = await db.prepare(`SELECT COUNT(*) AS n FROM items`).bind().first<{ n: number }>();
      return Number(row?.n ?? 0);
    },

    async countScores() {
      const row = await db.prepare(`SELECT COUNT(*) AS n FROM scores`).bind().first<{ n: number }>();
      return Number(row?.n ?? 0);
    },
  };
}

function rowToItem(r: ItemRow): StoredItem {
  return {
    contentKey: r.content_key,
    scoreAttempts: r.score_attempts ?? 0,
    scoreState: (r.score_state as StoredItem["scoreState"]) ?? "pending",
    id: r.id,
    sourceId: r.source_id,
    title: r.title,
    link: r.link,
    publishedAt: r.published_at ?? null,
    summary: r.summary,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
  };
}