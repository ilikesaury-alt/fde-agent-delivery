import { defineEnv, string } from "void/env";

/**
 * 环境变量声明。Void 会校验并注入。
 * 密钥只在服务端可用（不要用 VITE_ 前缀）。
 */
export default defineEnv({
  // magpie 中转（OpenAI 兼容）
  MAGPIE_BASE_URL: string(),
  MAGPIE_API_KEY: string(),
  MAGPIE_MODEL: string().default("deepseek-chat"),
  // 可选：收紧 CORS
  ALLOWED_ORIGIN: string().optional(),
});
