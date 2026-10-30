/**
 * 环境变量声明。Void 会校验并注入。
 * 密钥只在服务端可用（不要用 VITE_ 前缀）。
 */
import { defineEnv, string } from "void/env";

export default defineEnv({
  // 上游 LLM 网关（OpenAI 兼容）—— 用于报告结构化抽取与解读
  MAGPIE_BASE_URL: string(),
  MAGPIE_API_KEY: string(),
  MAGPIE_MODEL: string().default("deepseek-chat"),

  /**
   * 可选：本 Worker 自身的访问令牌。
   * 设置后，所有 /api/* 请求必须带 `Authorization: Bearer <ACCESS_TOKEN>`。
   * 健康数据属于敏感信息：**线上必须设置**，见 CONTEXT A7。
   */
  ACCESS_TOKEN: string().optional(),


  /** 电子版报告文本上限（字符数，默认 60000） */
  MAX_REPORT_CHARS: string().optional(),

  /** 抽取失败重试次数（默认 1，即最多 2 次调用） */
  EXTRACT_RETRY: string().optional(),
});