-- 产品⑤ 增量 7（审查修复）：日报窗口口径 + 生成来源追溯
--
-- 修复的审查发现：
--   A-2 日报无日期窗口 → 「每日日报」= 全库累计 top200，第 1 天与第 30 天几乎逐字相同
--   A-4 日报计数自相矛盾：fetched 与 kept 都传 countItems() → 第一行恒为「抓取 N → 去重后 N」；
--       aboveThreshold 被 listTopScored(limit:200) 硬顶在 200
--   B-3 同一天 cron:digest 与 POST /api/digest 并发 → 后写者静默胜出，无法追溯当天按哪个阈值发布
--
-- 设计：
--   window_start / window_end 记录这份日报的**数据窗口**（UTC 毫秒）。
--   日报语义改为「窗口内首次见到的条目」，而不是「全库累计」。
--   fetched / kept / deduped 各自独立计数（不再复用同一个 countItems）。
--   generation_id + source 记录「谁生成的」（cron / manual），用于并发追溯。
--   previous_selected 记录覆盖前的入选数 —— 覆盖写时若数量骤降可告警（防误覆盖）。

ALTER TABLE daily ADD COLUMN window_start INTEGER;
ALTER TABLE daily ADD COLUMN window_end INTEGER;
ALTER TABLE daily ADD COLUMN deduped INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily ADD COLUMN generation_id TEXT;
ALTER TABLE daily ADD COLUMN generation_source TEXT NOT NULL DEFAULT 'cron';
ALTER TABLE daily ADD COLUMN previous_selected INTEGER;