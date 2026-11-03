-- 产品⑤ 增量 7（源扩充）：清理陈旧源状态 + baseline 封顶
--
-- 背景：
--   1. 源列表从 6 个扩到 14 个，maxItems 从 40 降到 15。
--      `sources.baseline_count` 记的是「历史上抓到过多少条」，
--      于是旧源残留着 40（maxItems=40 时代），而现在只取 15 条
--      → 骤降判定「15 < 40×0.4」恒成立 → **所有源都被误报 degraded**。
--      （代码侧已修：比较前把 baseline 封顶到当前取样上限；这里把存量数据也对齐。）
--   2. `hf-blog` 已从源列表移除（该 feed 不提供任何摘要，预筛必然全丢）。
--      它的快照行会继续出现在 /api/sources 的历史里，让 UI 显示一个不存在的源。
--
-- 注意：
--   - 只删 `sources` 快照行，**不删 source_health 历史**：历史是「这个源什么时候坏的」的证据
--     （D10 的设计意图），留着比删掉更有价值；只是它不再出现在当前源清单里。
--   - 不删 `items` 里的历史条目：它们已经评分入库，是精选/日报的历史事实。
--   - baseline 封顶到 15：与当前 FEED_MAX_ITEMS 默认值一致（若线上配了别的值，
--     抓取时的封顶逻辑会自动按实际值兜底）。

-- ① 移除已不在源列表中的源（hf-blog）
DELETE FROM sources WHERE id = 'hf-blog';

-- ② baseline 封顶到当前取样上限（15）—— 避免陈旧 baseline 造成误报 degraded
UPDATE sources SET baseline_count = 15 WHERE baseline_count IS NOT NULL AND baseline_count > 15;

-- ③ 基线低于 5 条的源不参与骤降判定（与 healthOf 的「baseline ≥ 5」门槛保持一致），
--    这里把 0/1/2 这类无意义的基线归零，避免 UI 显示「基线 2 条」这种看不懂的数字
UPDATE sources SET baseline_count = NULL WHERE baseline_count IS NOT NULL AND baseline_count < 5;
