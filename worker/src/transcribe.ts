/**
 * ASR 预留接口（MVP 不实现）
 * 后续接入 Whisper / 通义 / 飞书等语音转写服务时在此实现。
 * 注意：若转写计算较重，需评估 Cloudflare Workers CPU 限制，
 * 可能应改为调用外部转写 API 或迁移到 Cloudflare Container。
 */

export class NotImplementedError extends Error {
  constructor(message = "语音转写功能尚未开放（MVP 暂不支持音频/视频，请提交文本）。") {
    super(message);
    this.name = "NotImplementedError";
  }
}

/** 预留：音频/视频 → 文本。MVP 阶段直接抛 NotImplementedError。 */
export async function transcribe(): Promise<string> {
  throw new NotImplementedError();
}
