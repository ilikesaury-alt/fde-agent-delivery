-- 产品④ 初始表：体检报告 / 指标行
-- 口径见 product4/CONTEXT.md「已确认方案」与 lib/types.ts
--
-- 设计要点（每条都对应一个真实失败模式）：
--   1. reports 存 raw_text 全文 —— 单用户自托管，原文是复核与追责的唯一依据（A6 source_quote）。
--   2. metrics 每条带 source_quote —— 让「数值」永远能对回报告原文的一行，抽取错误可人工发现。
--   3. ref_low/ref_high 可空 + ref_text 必存原文 —— 参考范围格式千奇百怪（`60-100`/`≤100`/
--      文字描述），解析不出就**不判异常**（status='unknown'），宁缺毋滥（D4 + 高风险应对）。
--   4. standard_name 与 raw_name 双写 —— 不同医院叫法不同（甘油三酯/TG/Triglyceride），
--      趋势按 standard_name 聚合；没归一的开放指标按 raw_name 聚合，避免趋势断裂。
--   5. profile_id 预留 —— 首发单人（'default'），多成员二期开 UI 不改表（D1）。

CREATE TABLE IF NOT EXISTS reports (
  id            TEXT    PRIMARY KEY,
  profile_id    TEXT    NOT NULL DEFAULT 'default',
  source_type   TEXT    NOT NULL,            -- 'pdf' | 'ocr' | 'manual'
  file_name     TEXT,                        -- 原始文件名（manual 为 NULL）
  check_date    TEXT    NOT NULL,            -- 检测日期 YYYY-MM-DD（取自报告，非上传时间）
  hospital      TEXT,                        -- 出具机构（可空）
  raw_text      TEXT    NOT NULL,            -- 报告原文（OCR 结果经人工校对后的文本）
  metric_count  INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

-- 时间线默认按检测日期倒序（趋势与列表都看它）
CREATE INDEX IF NOT EXISTS idx_reports_check_date ON reports (profile_id, check_date DESC);
CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports (created_at DESC);

-- 指标行：一次报告 N 条
CREATE TABLE IF NOT EXISTS metrics (
  id             TEXT    PRIMARY KEY,
  report_id      TEXT    NOT NULL,
  profile_id     TEXT    NOT NULL DEFAULT 'default',
  standard_name  TEXT    NOT NULL,           -- 归一后的标准指标名（趋势聚合键）
  raw_name       TEXT    NOT NULL,           -- 报告原文写的名字（展示与追溯）
  value_num      REAL,                       -- 数值（定性指标如「阴性」为 NULL）
  value_text     TEXT    NOT NULL,           -- 原文值（含「<0.01」「阴性」这类非数值）
  unit           TEXT,                       -- 单位（可空：百分比类指标常无单位）
  ref_low        REAL,                       -- 参考下限（解析不出为 NULL）
  ref_high       REAL,                       -- 参考上限（解析不出为 NULL）
  ref_text       TEXT,                       -- 参考范围原文（永远保留）
  status         TEXT    NOT NULL DEFAULT 'unknown', -- 'normal'|'high'|'low'|'unknown'
  source_quote   TEXT,                       -- 报告原文中该指标对应的片段（人工复核锚点）
  created_at     INTEGER NOT NULL,
  FOREIGN KEY (report_id) REFERENCES reports (id) ON DELETE CASCADE
);

-- 趋势查询：某标准指标跨报告按检测日期取点
CREATE INDEX IF NOT EXISTS idx_metrics_trend ON metrics (profile_id, standard_name);
CREATE INDEX IF NOT EXISTS idx_metrics_report ON metrics (report_id);