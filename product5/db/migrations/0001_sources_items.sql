-- 产品⑤ 初始表：订阅源状态 / 条目 / 源健康历史
-- 口径见 product5/CONTEXT.md 增量 2 与 lib/types.ts
--
-- 设计要点（每条对应一个真实失败模式）：
--   1. items.content_key 是**去重唯一键**（归一化 URL 的 hash）。跨源转载同链接只留一条，
--      靠数据库唯一约束兜底，而不是靠内存 Set（重启/多实例就失效）。
--   2. items 只存**每条资讯的当前态**（title/link/summary），不存历史版本 —— 资讯改标题是常态，
--      我们只关心「第一次见到」与「最近一次见到」（first_seen_at / last_seen_at）。
--   3. sources 的 last_* 字段是**快照**，source_health 才是**历史**：
--      UI 看快照（O(1)），排查看历史（能回答「这个源什么时候开始坏的」）。
--   4. baseline_count 记录历史正常条目数，用于判定「条目骤降」（D10 degraded）。
--      首次抓到即写入；此后只在新值显著更高时抬升，避免坏源把基线一起拉低。
--   5. published_at 用毫秒整数且**可空** —— 解析不出时间就不猜（NULL），排序时 NULL 靠后。

CREATE TABLE IF NOT EXISTS sources (
  id               TEXT    PRIMARY KEY,
  name             TEXT    NOT NULL,
  url              TEXT    NOT NULL,
  lang             TEXT    NOT NULL,
  verified         INTEGER NOT NULL DEFAULT 0,   -- 是否 M0 实测可用（0/1）
  last_checked_at  INTEGER,                      -- 毫秒
  last_health      TEXT,                         -- ok | degraded | broken
  last_error       TEXT,                         -- 失败分类（FeedErrorCode）
  last_item_count  INTEGER NOT NULL DEFAULT 0,
  baseline_count   INTEGER,                      -- 历史正常条目数（判骤降）
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  content_key   TEXT    PRIMARY KEY,             -- 归一化 URL 的 hash（去重键）
  id            TEXT    NOT NULL,                -- 源自 feed 的 id/guid（追溯用）
  source_id     TEXT    NOT NULL,
  title         TEXT    NOT NULL,
  link          TEXT    NOT NULL,
  published_at  INTEGER,                         -- 毫秒；解析不出为 NULL
  summary       TEXT    NOT NULL DEFAULT '',
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_published ON items (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_source ON items (source_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_last_seen ON items (last_seen_at DESC);

CREATE TABLE IF NOT EXISTS source_health (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id   TEXT    NOT NULL,
  level       TEXT    NOT NULL,
  error       TEXT,
  item_count  INTEGER NOT NULL,
  elapsed_ms  INTEGER,
  checked_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_health_source ON source_health (source_id, checked_at DESC);