-- 产品⑤ 增量 3：评分结果表
-- 口径见 product5/CONTEXT.md D5 与 lib/score.ts
--
-- 设计要点：
--   1. content_key 既是主键又是 items 外键（同一条资讯只保留**最新一次**评分）——
--      重评分是常态（换模型 / 调 prompt / 阈值重标定），存历史会让标定口径漂移。
--   2. 四个维度分开存，不存「总分」以外的东西：总分可由维度重算（weights 改了要能复算）。
--      total 仍然落库，因为排序/筛选走 SQL，重算成本不该摊到每次查询。
--   3. model + prompt_version 落库：标定报告必须能回答「这份分数是哪版 prompt 打的」。
--   4. 未评分条目**不写入本表**（不要塞 0 分）：NULL 表示「没评过」，0 分表示「评了但很差」，
--      两者在统计上完全不同。

CREATE TABLE IF NOT EXISTS scores (
  content_key     TEXT    PRIMARY KEY,
  relevance       INTEGER NOT NULL,
  novelty         INTEGER NOT NULL,
  usefulness      INTEGER NOT NULL,
  authority       INTEGER NOT NULL,
  total           REAL    NOT NULL,
  reason          TEXT    NOT NULL DEFAULT '',
  model           TEXT    NOT NULL,
  prompt_version  TEXT    NOT NULL,
  scored_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scores_total ON scores (total DESC);
CREATE INDEX IF NOT EXISTS idx_scores_scored_at ON scores (scored_at DESC);