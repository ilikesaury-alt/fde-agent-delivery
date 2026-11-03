-- 产品⑤ 增量 7（审查修复）：评分队列状态机 + 认领租约
--
-- 修复的审查发现：
--   A-1 评分队列「新优先 + 无跳过」→ 旧条目永久饿死（ORDER BY published_at DESC LIMIT 10，
--       每小时插新条目 → 队头永远是最新的 10 条，其余条目再也不会被选中）
--   A-3 prefilter 是死代码 → 噪音全送 LLM，浪费预算
--   B-2/B-5 listUnscored 无「认领」语义 → cron 与 POST 并发时同一批被评两次（双倍花费）
--
-- 设计：
--   score_state 四态，语义互斥且可统计：
--     pending  —— 等待评分（含失败后重试）
--     dropped  —— 本地预筛判定为噪音，**不送 LLM**（省预算，且可解释）
--     scored   —— 已评分（scores 表有对应行）
--     dead     —— 连续失败超过上限，放弃（避免无限重试烧钱）
--   score_attempts 只统计**真实 LLM 尝试次数**（预筛 drop 不计入）。
--   claimed_at 是租约：认领后 N 分钟内不再被别的 worker 选中；过期自动可被重新认领
--   （用「租约」而不是「锁」：worker 崩溃不会导致队列永久卡死）。

ALTER TABLE items ADD COLUMN score_state TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE items ADD COLUMN score_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN claimed_at INTEGER;
ALTER TABLE items ADD COLUMN last_error TEXT;

-- 队列查询的支撑索引：先按状态，再按「尝试次数少的优先」（保证旧条目不会被新条目饿死）
CREATE INDEX IF NOT EXISTS idx_items_queue ON items (score_state, score_attempts, published_at DESC);

-- 已评分条目的 state 回填（历史数据里 scores 有行的就是 scored）
-- 注意：这条是幂等的（只更新仍为 pending 的），可安全重跑
UPDATE items SET score_state = 'scored'
 WHERE score_state = 'pending'
   AND content_key IN (SELECT content_key FROM scores);