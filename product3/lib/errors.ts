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
  sourceInvalid: "source 必须是 paste / file / pdf / url 之一。"
} as const;
