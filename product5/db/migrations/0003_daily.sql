-- 产品⑤ 增量 4：日报表
-- 口径见 product5/CONTEXT.md D6/D11 与 lib/digest.ts
--
-- 设计要点：
--   1. date 是 **UTC 日期（YYYY-MM-DD）** 作主键：Cron 按 UTC 调度，日报一天一份。
--      重跑同一天 = 覆盖（日报是「该日的最新结论」，不是追加日志）。
--   2. markdown 全文落库：日报是交付物，要能原样回看/转发，而不是每次重新拼。
--   3. counts / model / prompt_version 落库：回答「这份日报是哪版阈值与模型出的」。
--   4. 另存一份 headline/selected 的 stats，便于后续做「日报质量随时间」的观察。

CREATE TABLE IF NOT EXISTS daily (
  date            TEXT    PRIMARY KEY,
  markdown        TEXT    NOT NULL,
  threshold       REAL    NOT NULL,
  per_source_max  INTEGER NOT NULL,
  top_n           INTEGER NOT NULL,
  fetched         INTEGER NOT NULL DEFAULT 0,
  kept            INTEGER NOT NULL DEFAULT 0,
  scored          INTEGER NOT NULL DEFAULT 0,
  above_threshold INTEGER NOT NULL DEFAULT 0,
  selected        INTEGER NOT NULL DEFAULT 0,
  skipped_quota   INTEGER NOT NULL DEFAULT 0,
  model           TEXT    NOT NULL,
  prompt_version  TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_daily_created ON daily (created_at DESC);