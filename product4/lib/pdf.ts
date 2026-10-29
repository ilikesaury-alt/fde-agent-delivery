/**
 * PDF 文本抽取（**仅浏览器端**）。
 *
 * 为什么放前端（CONTEXT D2）：
 *   Worker 里解析 PDF 要吃掉内存与 CPU 预算（首页 SSR 与 API 共用同一个 isolate），
 *   而且中文 PDF 常需字体映射，解析器体积不小。前端用 pdf.js 抽成纯文本后
 *   再走同一条「文本 → 切分 → 嵌入」管道，Worker 侧零改动。
 *
 * 边界（CONTEXT §7.2）：**扫描件（图片型 PDF）抽不出文本** → 交给 OCR 通道
 * （二期 `renderPdfPages` 把页面渲染成 JPEG，Worker 侧 `lib/ocr.ts` 调视觉模型识别）。
 * 仍然不做「假装成功」：抽不出文字就说抽不出，让用户选「OCR 识别」或粘贴。
 */

/** 与 lib/ocr.ts 的 MAX_OCR_PAGES 必须一致（单测有一条对账） */
export const PDF_MAX_OCR_PAGES = 5;

export type PdfPageImage = {
  /** 1-based 页号（OCR 路由与失败提示都用它对齐） */
  page: number;
  /** JPEG data URL（只认 data URL，不让 Worker 去 fetch 任意地址） */
  dataUrl: string;
};

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
/** 载入 PDF 文档（抽文本与渲染页图共用；pdf.js 体积大，调用方负责动态 import 的时机） */
async function loadPdf(file: File) {
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const data = new Uint8Array(await file.arrayBuffer());
  return { pdfjs, data };
}

export async function extractPdfText(file: File): Promise<PdfExtractResult> {
  // 动态 import：pdf.js 体积大，只在用户真的选了 PDF 时才加载
  const { pdfjs, data } = await loadPdf(file);

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
      "该 PDF 未抽取到文字（可能是扫描件/图片型 PDF）。请改用「扫描件识别」或粘贴文本。",
    );
  }
  return { text, pages: pdf.numPages };
}

/**
 * 把 PDF 前 N 页渲染成 JPEG data URL（**仅浏览器**，需要 canvas）。
 *
 * 为什么渲染放前端：Worker 里没有 canvas/DOM，pdf.js 渲染不出页面图像；
 * 而扫描件里根本没有文字层，后端能做的只有「收到图片 → 识别」。
 * scale=2 是清晰度与体积的折中（A4 页 2 A4 ≈ 200–400KB JPEG，视觉模型够看）。
 */
export async function renderPdfPages(
  file: File,
  opts: { maxPages?: number; scale?: number; quality?: number } = {},
): Promise<PdfPageImage[]> {
  if (typeof document === "undefined") {
    throw new PdfExtractError("unreadable", "OCR 渲染只能在浏览器内进行。");
  }
  const maxPages = opts.maxPages ?? PDF_MAX_OCR_PAGES;
  const scale = opts.scale ?? 2;
  const quality = opts.quality ?? 0.8;

  const { pdfjs, data } = await loadPdf(file);
  let pdf: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;
  try {
    pdf = await pdfjs.getDocument({ data, useWorkerFetch: true }).promise;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/password/i.test(msg)) throw new PdfExtractError("encrypted", "该 PDF 有密码保护，请先解除密码。");
    throw new PdfExtractError("unreadable", "无法读取该 PDF，文件可能已损坏。");
  }

  const pages = Math.min(pdf.numPages, maxPages);
  const out: PdfPageImage[] = [];
  for (let i = 1; i <= pages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new PdfExtractError("unreadable", "浏览器不支持 canvas，无法渲染 PDF 页面。");
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    out.push({ page: i, dataUrl: canvas.toDataURL("image/jpeg", quality) });
    // 主动释放：一页 A4@scale2 的位图约 30MB，连渲 5 页不释放会 OOM
    canvas.width = 0;
    canvas.height = 0;
    page.cleanup();
  }
  return out;
}
