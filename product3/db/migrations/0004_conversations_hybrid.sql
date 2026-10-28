-- 0004：二期 —— 多轮会话 + 关键词倒排索引
-- 口径见 product3/CONTEXT.md §11（D18–D21、A1–A7）
--
-- 幂等约束（A7）：只做 CREATE TABLE / CREATE INDEX IF NOT EXISTS，不 ALTER 既有表。
-- 因此 BM25 需要的「文档长度」不额外加列，改用 chunks.text 的字符长度（LENGTH(text)）作代理。

-- 会话（一次连续追问 = 一个会话；标题取首问截断）
CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT    PRIMARY KEY,
  title       TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations (updated_at DESC);

-- 会话内的一轮问答（二期的新真源；qa_history 停止写入，仅兼容读）
CREATE TABLE IF NOT EXISTS messages (
  id               TEXT    PRIMARY KEY,
  conversation_id  TEXT    NOT NULL,
  question         TEXT    NOT NULL,
  answer_json      TEXT,                        -- AskResult（含 citations / refused / nearest）
  cited_doc_ids    TEXT,                        -- JSON 数组
  refused          INTEGER NOT NULL DEFAULT 0,
  retrieval_query  TEXT    NOT NULL DEFAULT '', -- 规则改写后真正用于检索的查询（可观测）
  created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at DESC);

-- 关键词倒排（中文双字 bigram + 英文/数字词）
-- 每 chunk 最多 24 个 term（见 lib/hybrid.ts MAX_TERMS_PER_CHUNK），控体积：
-- 4000 chunk 上限 × 24 ≈ 9.6 万行，D1 免费额度无压力。
CREATE TABLE IF NOT EXISTS chunk_terms (
  term      TEXT    NOT NULL,
  chunk_id  TEXT    NOT NULL,
  tf        INTEGER NOT NULL,
  PRIMARY KEY (term, chunk_id)
);

CREATE INDEX IF NOT EXISTS idx_terms_chunk ON chunk_terms (chunk_id);