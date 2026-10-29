/**
 * 错误码与用户文案（单一权威源，路由直接映射 HTTP 状态）。
 * 与产品①②③ 同口径：上游细节只进服务端日志，不回传前端。
 */

export const ERR = {
  tokenMissing: "访问令牌缺失或错误。",
  emptyText: "报告文本为空，请先上传报告或粘贴文本。",
  tooLong: "报告文本过长，请拆分或精简后重试。",
  extractFailed: "报告解析失败：未能从文本中识别出指标，请检查文本是否完整后重试。",
  extractInvalid: "报告解析结果不完整（缺少检测日期或指标），请重试或改用手工录入。",
  notFound: "记录不存在。",
  badRequest: "请求参数不合法。",
  aiBindingMissing: "AI 绑定缺失，扫描件识别不可用，请改走电子版 PDF 或手工录入。",
  ocrUpstream: "扫描件识别服务暂时不可用，请稍后重试。",
  ocrQuota: "扫描件识别配额已用尽，请稍后重试或改用手工录入。",
  ocrEmpty: "未能从图片中识别出文字，请确认图片清晰、方向正确。",
  ocrBadImage: "图片格式不支持或内容为空，请重新导出为 JPG/PNG 后重试。",
  ocrTooLarge: "图片过大，请降低分辨率后重试。",
  interpretFailed: "解读服务暂时不可用，请稍后重试。",
} as const;

export type ErrCode = keyof typeof ERR;

/** 抽取阶段错误（code 决定路由状态码） */
export class ExtractError extends Error {
  code: ErrCode;
  constructor(code: ErrCode, message?: string) {
    super(message ?? ERR[code]);
    this.name = "ExtractError";
    this.code = code;
  }
}

export class OcrError extends Error {
  code: ErrCode;
  constructor(code: ErrCode, message?: string) {
    super(message ?? ERR[code]);
    this.name = "OcrError";
    this.code = code;
  }
}

/**
 * 配额类上游错误的通用识别（不同网关措辞不同）。
 * 接受任意错误对象：Workers AI 抛的是 Error（含 message），网关调用抛的是我们自己的错误。
 * 先看显式 status（429/402），再看文案措辞。
 */
export function isQuotaError(err: unknown): boolean {
  if (err == null) return false;
  const e = err as { status?: unknown; message?: unknown; code?: unknown };
  const status = Number(e.status);
  if (status === 429 || status === 402) return true;
  const text = `${typeof e.message === "string" ? e.message : ""} ${typeof e.code === "string" ? e.code : ""} ${String(err)}`;
  return /quota|rate.?limit|too many requests|exceeded|额度|配额|限流/i.test(text);
}