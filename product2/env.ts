import { defineEnv, string } from "void/env";

/**
 * 环境变量声明。Void 会校验并注入。
 * 密钥只在服务端可用（不要用 VITE_ 前缀）。
 */
export default defineEnv({
  // 上游 LLM 网关（OpenAI 兼容）
  MAGPIE_BASE_URL: string(),
  // 上游密钥。本地 magpie 可为空；公网模型 API 必填。
  MAGPIE_API_KEY: string(),
  MAGPIE_MODEL: string().default("deepseek-chat"),

  /**
   * 可选：本 Worker 自身的访问令牌。
   * 设置后，所有 /api/* 请求必须带 `Authorization: Bearer <ACCESS_TOKEN>`。
   * 留空则不校验（仅建议在完全私有时使用）。
   */
  ACCESS_TOKEN: string().optional(),
});
