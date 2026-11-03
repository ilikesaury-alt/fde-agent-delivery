-- 产品⑤ 增量 8：批量粗筛的粗分持久化（方案 D）
--
-- 背景：粗筛（批量 10 条/次调用）把明显不行的条目挡在逐条精排之外，省 LLM 调用。
-- 但如果粗分不落库，用户每点一次「刷新」都要把队列里的条目**重新粗筛一遍** ——
-- 那是纯浪费（粗筛本身也是 LLM 调用）。
--
-- 有了这一列，粗分**一次算、多次用**：
--   第一次点击：粗筛 130 条（13 次调用）→ 粗分入库 → 精排 top 20
--   第二次点击：队列里的条目**已有粗分** → 跳过粗筛 → 直接精排下一批 top 20
--   → 多次点击能累积精排量，最终填满精选配额（perSourceMax）
--
-- 为什么不复用 scores 表：scores 存的是**精排分**（score-v1 逐条 prompt），
-- 与粗分不是同一个量纲、也不在同一评估口径下。混在一张表会让「阈值 70」失真
-- （阈值 70 是用精排 prompt 在评测集上标定的）。粗分**只用于排序**。
--
-- coarse_score：0–10 的粗粒度分（NULL = 还没粗筛过）
-- coarse_at：粗筛时刻（毫秒），用于判断粗分新鲜度

ALTER TABLE items ADD COLUMN coarse_score INTEGER;
ALTER TABLE items ADD COLUMN coarse_at INTEGER;

-- 粗分查询：只取「已粗分」的条目按粗分降序（精排阶段用）
CREATE INDEX IF NOT EXISTS idx_items_coarse ON items (score_state, coarse_score DESC);
