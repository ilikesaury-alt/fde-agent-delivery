/**
 * PDF 文本抽取（**仅浏览器端**）。
 *
 * 为什么放前端（CONTEXT D2）：
 *   Worker 里解析 PDF 要吃掉内存与 CPU 预算（首页 SSR 与 API 共用同一个 isolate），
 *   而且中文 PDF 常需字体映射，解析器体积不小。前端用 pdf.js 抽成纯文本后
 *   再走同一条「文本 → 切分 → 嵌入」管道，Worker 侧零改动。
 *
 * 边界（CONTEXT §7.2）：**扫描件（图片型 PDF）抽不出文本** → 明确提示需 OCR，
 * 不做「假装成功」。OCR 已列为二期。
 */

export type PdfExtractResult = {
  text: string;
  /** 页数，用于提示与配额判断 */
  pages: number;
};

export class PdfExtractError extends Error {
  readonly code: "unreadable" | "encrypted" | "no_text";
  constructor(code: PdfExtractError["code"], message: string) {
    super(message);
    this.name = "PdfExtractError";
    this.code = code;
  }
}

/** 抽取页与页之间用空行分隔，保留段落感（切分器按空行分段） */
export async function extractPdfText(file: File): Promise<PdfExtractResult> {
  // 动态 import：pdf.js 体积大，只在用户真的选了 PDF 时才加载
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const data = new Uint8Array(await file.arrayBuffer());

  let pdf: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;
  try {
    pdf = await pdfjs.getDocument({ data, useWorkerFetch: true }).promise;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/password/i.test(msg)) {
      throw new PdfExtractError("encrypted", "该 PDF 有密码保护，请先解除密码后再导入。");
    }
    throw new PdfExtractError("unreadable", "无法读取该 PDF，文件可能已损坏。");
  }

  const parts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((it) => ("str" in it ? it.str : ""))
      .join("")
      // pdf.js 抽出的中文常在词间插入空格，压缩掉多余空白但保留换行
      .replace(/[ \t]{2,}/g, " ")
      .trim();
    if (text) parts.push(text);
  }

  const text = parts.join("\n\n").trim();
  if (!text) {
    throw new PdfExtractError(
      "no_text",
      "该 PDF 未抽取到文字（可能是扫描件/图片型 PDF）。请改用 OCR 工具转换后再导入。",
    );
  }
  return { text, pages: pdf.numPages };
}
