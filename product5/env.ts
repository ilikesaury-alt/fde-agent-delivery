/**
 * 环境变量声明（Void 会校验并注入）。
 * 密钥只在服务端可用 —— 不要用 VITE_ 前缀。
 */
import { defineEnv, string } from "void/env";

export default defineEnv({
  // 上游 LLM 网关（OpenAI 兼容）—— 评分与日报生成（增量 3 起使用）
  MAGPIE_BASE_URL: string(),
  MAGPIE_API_KEY: string(),
  MAGPIE_MODEL: string().default("deepseek-chat"),

  /**
   * 可选：本站访问令牌。设置后 /api/* 需 `Authorization: Bearer <ACCESS_TOKEN>`。
   * 演示站可不设；一旦公开分享，建议设。
   */
  ACCESS_TOKEN: string().optional(),

  /** 单源单次最多取多少条（默认 40）—— 受 subrequest/CPU 预算约束 */
  FEED_MAX_ITEMS: string().optional(),

  /** 单源抓取超时毫秒（默认 8000） */
  FEED_TIMEOUT_MS: string().optional(),
});