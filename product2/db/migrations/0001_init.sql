-- 产品② 初始表：生成任务（一次流水线运行 = 一条历史记录）
-- 字段口径见 lib/types.ts：GenerationJob
CREATE TABLE IF NOT EXISTS jobs (
  id             TEXT    PRIMARY KEY,
  created_at     INTEGER NOT NULL,
  source_type    TEXT    NOT NULL,           -- 'url' | 'text'
  source_url     TEXT,                       -- source_type='url' 时有值
  source_excerpt TEXT    NOT NULL DEFAULT '',-- 列表展示用摘要
  source_text    TEXT    NOT NULL DEFAULT '',-- 原始素材全文（重新生成复用）
  material_brief TEXT,                       -- 超长素材压缩后的要点
  note_json      TEXT,                       -- XhsNote JSON；失败为 NULL
  status         TEXT    NOT NULL,           -- 'succeeded' | 'failed'
  error          TEXT                        -- status='failed' 时的原因
);

-- 历史列表按时间倒序查询
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs (created_at DESC);
