-- 产品③ 初始表：文档 / 片段 / 问答历史
-- 口径见 lib/types.ts 与 product3/CONTEXT.md「数据模型」

-- 一篇导入的文档（粘贴/上传/URL/PDF 抽取后的纯文本）
CREATE TABLE IF NOT EXISTS documents (
  id            TEXT    PRIMARY KEY,
  source        TEXT    NOT NULL,            -- 'paste' | 'file' | 'url' | 'pdf'
  source_ref    TEXT,                        -- URL 或文件名（paste 为 NULL）
  title         TEXT    NOT NULL DEFAULT '',
  content_hash  TEXT    NOT NULL,            -- sha256(规范化正文)：幂等判据
  status        TEXT    NOT NULL,            -- 'pending' | 'indexing' | 'ready' | 'failed'
  chunk_count   INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  created_at    INTEGER NOT NULL
);

-- 重复导入判定：同来源同内容
CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents (content_hash);
CREATE INDEX IF NOT EXISTS idx_documents_created_at ON documents (created_at DESC);

-- 切分后的片段（向量本体在 Vectorize，这里存元数据与原文）
CREATE TABLE IF NOT EXISTS chunks (
  id            TEXT    PRIMARY KEY,         -- = vector_id（Vectorize 主键）
  doc_id        TEXT    NOT NULL,
  idx           INTEGER NOT NULL,            -- 文档内序号
  heading_path  TEXT    NOT NULL DEFAULT '', -- 「3.2 部署」：引用锚点可读化
  text          TEXT    NOT NULL,            -- 片段原文（引用展示用）
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks (doc_id, idx);

-- 问答历史（回看用）
CREATE TABLE IF NOT EXISTS qa_history (
  id            TEXT    PRIMARY KEY,
  question      TEXT    NOT NULL,
  answer_json   TEXT,                        -- { answer, citations[], refused }
  cited_doc_ids TEXT,                        -- JSON 数组
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_qa_created_at ON qa_history (created_at DESC);
