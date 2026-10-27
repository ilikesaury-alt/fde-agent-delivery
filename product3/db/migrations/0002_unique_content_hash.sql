-- 0002：并发导入同一内容时的兜底（cross-review B4）
-- 两个标签页/连点「导入并索引」会让两边都读到 findByHash=null，各建一份文档并双扣配额。
-- 唯一索引让第二个写入直接失败，配合 lib/ingest.ts 的「插入后回查赢家」逻辑转为幂等跳过。
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_content_hash ON documents (content_hash);
