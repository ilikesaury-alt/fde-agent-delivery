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

export type D1Like = {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
      first<T = unknown>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
};

/** 每条资讯的持久化形态 */
export type StoredItem = {
  contentKey: string;
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
    scored: number;
    aboveThreshold: number;
    selected: number;
    skippedQuota: number;
  };
  model: string;
  promptVersion: string;
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
  /** 读**未评分**条目（评分批次的输入；靠 LEFT JOIN 而不是内存过滤） */
  listUnscored(limit?: number): Promise<StoredItem[]>;
  /** 读达到阈值的条目（按总分倒序）—— 精选与日报的数据源 */
  listTopScored(opts: { threshold: number; limit?: number }): Promise<RankedItem[]>;
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

    async listUnscored(limit = 50) {
      return [...items.values()]
        .filter((i) => !scores.has(i.contentKey))
        .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
        .slice(0, limit);
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

      let inserted = 0;
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
        const res = (await db
          .prepare(
            `INSERT OR IGNORE INTO items
               (content_key, id, source_id, title, link, published_at, summary, first_seen_at, last_seen_at)
             VALUES ${placeholders}`,
          )
          .bind(...values)
          .run()) as { meta?: { changes?: number } } | undefined;
        inserted += res?.meta?.changes ?? 0;
      }

      // 已存在的条目：只更新 last_seen_at（first_seen_at 不动，它是「第一次见到」的事实）
      for (let i = 0; i < rows.length; i += 90) {
        const keys = rows.slice(i, i + 90).map(([k]) => k);
        const marks = keys.map(() => "?").join(",");
        await db
          .prepare(`UPDATE items SET last_seen_at = ? WHERE content_key IN (${marks})`)
          .bind(now, ...keys)
          .run();
      }

      return { inserted, duplicates: rows.length - inserted };
    },

    async recordRun(records, now = Date.now()) {
      for (const r of records) {
        await db
          .prepare(
            `INSERT INTO source_health (source_id, level, error, item_count, elapsed_ms, checked_at)
             VALUES (?,?,?,?,?,?)`,
          )
          .bind(r.source.id, r.health.level, r.health.error ?? null, r.health.itemCount, r.elapsedMs ?? null, now)
          .run();

        // baseline 只在「正常且更多」时抬升（避免坏源把基线一起拉低）
        await db
          .prepare(
            `INSERT INTO sources
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
               updated_at = excluded.updated_at`,
          )
          .bind(
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
          )
          .run();
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

    async listUnscored(limit = 50) {
      const res = await db
        .prepare(
          `SELECT i.* FROM items i
             LEFT JOIN scores s ON s.content_key = i.content_key
            WHERE s.content_key IS NULL
            ORDER BY COALESCE(i.published_at, 0) DESC, i.last_seen_at DESC
            LIMIT ?`,
        )
        .bind(Math.max(1, Math.min(limit, 200)))
        .all<ItemRow>();
      return (res.results ?? []).map(rowToItem);
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
        .bind(opts.threshold, Math.max(1, Math.min(opts.limit ?? 20, 200)))
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
             (date, markdown, threshold, per_source_max, top_n, fetched, kept, scored,
              above_threshold, selected, skipped_quota, model, prompt_version, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(date) DO UPDATE SET
             markdown = excluded.markdown,
             threshold = excluded.threshold,
             per_source_max = excluded.per_source_max,
             top_n = excluded.top_n,
             fetched = excluded.fetched,
             kept = excluded.kept,
             scored = excluded.scored,
             above_threshold = excluded.above_threshold,
             selected = excluded.selected,
             skipped_quota = excluded.skipped_quota,
             model = excluded.model,
             prompt_version = excluded.prompt_version,
             updated_at = excluded.updated_at`,
        )
        .bind(
          record.date,
          record.markdown,
          record.threshold,
          record.perSourceMax,
          record.topN,
          record.counts.fetched,
          record.counts.kept,
          record.counts.scored,
          record.counts.aboveThreshold,
          record.counts.selected,
          record.counts.skippedQuota,
          record.model,
          record.promptVersion,
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
          scored: row.scored,
          aboveThreshold: row.above_threshold,
          selected: row.selected,
          skippedQuota: row.skipped_quota,
        },
        model: row.model,
        promptVersion: row.prompt_version,
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