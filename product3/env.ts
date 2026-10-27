/**
 * 环境变量声明。Void 会校验并注入。
 * 密钥只在服务端可用（不要用 VITE_ 前缀）。
 */
import { defineEnv, string } from "void/env";

export default defineEnv({
  // 上游 LLM 网关（OpenAI 兼容）—— 用于生成回答
  MAGPIE_BASE_URL: string(),
  MAGPIE_API_KEY: string(),
  MAGPIE_MODEL: string().default("deepseek-chat"),

  /**
   * 可选：本 Worker 自身的访问令牌。
   * 设置后，所有 /api/* 请求必须带 `Authorization: Bearer <ACCESS_TOKEN>`。
   */
  ACCESS_TOKEN: string().optional(),

  /** 检索 top-k（默认 6）。评测时可覆盖。 */
  RETRIEVE_TOP_K: string().optional(),
  /** 相似度阈值（默认 0.35）。低于该值视为「无依据」→ 拒答。评测驱动标定。 */
  RETRIEVE_MIN_SCORE: string().optional(),
});
