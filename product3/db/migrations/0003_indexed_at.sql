-- 0003：记录「向量写入被平台接受」的时刻。
-- Vectorize 的 upsert 是异步的（返回 mutationId 即入队，检索可见性有延迟），
-- 因此不能用「写完立刻回读」判失败；这里记录验收时间，便于线上对账与排障。
ALTER TABLE documents ADD COLUMN indexed_at INTEGER;
