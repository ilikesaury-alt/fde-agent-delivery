/**
 * 面向用户的错误文案 —— 单一真源。
 *
 * 原则（沿用产品①②）：文案直接可展示；不泄露堆栈 / 上游原始响应体 / 密钥；
 * 同类错误不同原因要能区分（否则用户无法自查，排障时也看不出症结）。
 */

export function embedErrorText(code: "quota" | "upstream" | "empty"): string {
  switch (code) {
    case "quota":
      return "今日嵌入额度已用尽（Workers AI 免费额度），请明日再试或升级套餐。";
    case "empty":
      return "没有可索引的内容，请检查文档是否为空。";
    default:
      return "文档索引服务暂不可用，请稍后重试。";
  }
}

export function ocrErrorText(code: "quota" | "upstream" | "empty" | "bad_image" | "too_large"): string {
  switch (code) {
    case "quota":
      return "今日 OCR 识别额度已用尽（Workers AI 免费额度），请明日再试，或改用文字粘贴导入。";
    case "bad_image":
      return "图片格式不正确，只支持 png / jpeg / webp 的 base64 数据。";
    case "too_large":
      return "单页图片过大，请降低清晰度后重试。";
    case "empty":
      return "该页未识别出文字：请换一页重试，或用文字粘贴方式录入。";
    default:
      return "OCR 服务暂不可用，请稍后重试，或改用文字粘贴导入。";
  }
}

export const ERR = {
  badJson: "请求体必须是 JSON。",
  missingField: (f: string) => `缺少字段 ${f}。`,
  emptyText: "内容不能为空，请粘贴文本或上传文件。",
  emptyQuestion: "请输入问题。",
  tooLong: (n: number, max: number) =>
    `内容过长（${n.toLocaleString("zh-CN")} 字，上限 ${max.toLocaleString("zh-CN")} 字），请拆分后再导入。`,
  docNotFound: "文档不存在或已删除。",
  urlInvalid: "链接格式不正确，只支持 http/https 公网地址。",
  urlPrivate: "出于安全考虑，不能导入内网、回环或本机地址。",
  urlFetchFailed: "抓取失败：目标页面无法访问或无正文内容。",
  noLlmConfig: "AI 服务暂不可用：未配置模型服务凭据，请检查配置后重试。",
  llmUnauthorized: "AI 服务凭据无效，请检查配置后重试。",
  llmRateLimited: "请求过于频繁，请稍后再试。",
  llmFailed: "AI 服务暂不可用，请检查配置或稍后重试。",
  llmEmpty: "AI 返回结果为空，请重试。",
  embedQuota: embedErrorText("quota"),
  embedFailed: embedErrorText("upstream"),
  tooManyChunks: (n: number, max: number) =>
    `文档切分后片段过多（${n} 个，上限 ${max} 个），请拆分文档后再导入。`,
  libraryFull: (max: number) => `知识库已达容量上限（${max} 个片段），请先删除部分文档。`,
  vectorVerifyFailed: "索引写入校验失败（部分片段未生效），请重试。",
  questionTooLong: "问题过长，请精简后再问。",
  docListFailed: "读取文档列表失败，请稍后重试。",
  docDeleteFailed: "删除失败，请稍后重试。",
  docDeleteVectorLeft: (n: number) => `文档已删除，但有 ${n} 个片段向量清理失败，请稍后重试删除。`,
  historyFailed: "读取问答历史失败，请稍后重试。",
  indexWriteFailed: "索引写入失败，请稍后重试。",
  aiBindingMissing: "检索服务未就绪（缺少 Workers AI 绑定），请检查部署配置。",
  sourceInvalid: "source 必须是 paste / file / pdf / url 之一。",
  // ── 二期：会话 / OCR / 索引探针 ──────────────────────────────
  conversationNotFound: "会话不存在或已删除，请新建会话后重试。",
  convListFailed: "读取会话列表失败，请稍后重试。",
  convDeleteFailed: "删除会话失败，请稍后重试。",
  messageListFailed: "读取会话消息失败，请稍后重试。",
  ocrPageLimit: (n: number, max: number) =>
    `单次最多识别 ${max} 页（本次请求 ${n} 页），请分批后再试。`,
  ocrQuota: ocrErrorText("quota"),
  ocrFailed: ocrErrorText("upstream"),
  ocrEmpty: ocrErrorText("empty"),
  ocrBadImage: ocrErrorText("bad_image"),
  ocrTooLarge: ocrErrorText("too_large"),
  probeNoChunks: "该文档没有可探测的片段（可能尚未切分完成）。",
  probeNotVisible: "暂时还检索不到该文档的向量（索引仍在写入），请稍后再试。",
} as const;
