import { assert, assertEqual, assertThrows, describe, it } from "./harness.ts";
import { FAKE_OCR_MODEL, createFakeAI } from "./fakes.ts";
import {
  DEFAULT_OCR_MODEL,
  MAX_OCR_IMAGE_CHARS,
  MAX_OCR_PAGES,
  OCR_PROMPT,
  OcrError,
  extractOcrText,
  normalizeImage,
  normalizeOcrText,
  ocrPage,
} from "../lib/ocr.ts";
import { PDF_MAX_OCR_PAGES } from "../lib/pdf.ts";

const IMG = "data:image/jpeg;base64," + Buffer.from("x".repeat(300)).toString("base64");

describe("ocr — 常量对账（防两处漂移）", () => {
  it("默认模型与本地替身一致", () => {
    assertEqual(DEFAULT_OCR_MODEL, FAKE_OCR_MODEL);
  });

  it("前端渲染页数上限与后端页数上限一致", () => {
    assertEqual(PDF_MAX_OCR_PAGES, MAX_OCR_PAGES);
  });

  it("提示词明确要求「只输出文字」（否则会把图片描述当正文）", () => {
    assert(OCR_PROMPT.includes("只输出"), OCR_PROMPT);
    assert(/不要总结|不要解释/.test(OCR_PROMPT));
  });
});

describe("ocr — 入参校验", () => {
  it("接受 png/jpeg/webp 的 data URL", () => {
    for (const mime of ["png", "jpeg", "jpg", "webp"]) {
      const url = `data:image/${mime};base64,AAAA`;
      assertEqual(normalizeImage(url), url);
    }
  });

  it("拒绝远程 URL（不新增 SSRF 面）", async () => {
    await assertThrows(
      () => normalizeImage("https://example.com/a.jpg"),
      (e) => e instanceof OcrError && e.code === "bad_image",
    );
  });

  it("拒绝非图片 data URL / 空值", async () => {
    await assertThrows(
      () => normalizeImage("data:text/plain;base64,AAAA"),
      (e) => e instanceof OcrError && e.code === "bad_image",
    );
    await assertThrows(
      () => normalizeImage(undefined),
      (e) => e instanceof OcrError && e.code === "bad_image",
    );
  });

  it("超大图片 → too_large", async () => {
    const huge = `data:image/jpeg;base64,${"A".repeat(MAX_OCR_IMAGE_CHARS)}`;
    await assertThrows(
      () => normalizeImage(huge),
      (e) => e instanceof OcrError && e.code === "too_large",
    );
  });
});

describe("ocr — 返回体容错解析", () => {
  it("覆盖各视觉模型的返回形状", () => {
    assertEqual(extractOcrText({ answer: "a" }), "a");
    assertEqual(extractOcrText({ response: "b" }), "b");
    assertEqual(extractOcrText({ result: { answer: "c" } }), "c");
    assertEqual(extractOcrText({ result: { response: "d" } }), "d");
    assertEqual(extractOcrText({ description: "e" }), "e");
    assertEqual(extractOcrText("f"), "f");
  });

  it("无文字 → OcrError(empty)（不能当成功返回空串）", async () => {
    await assertThrows(
      () => extractOcrText({ answer: "   " }),
      (e) => e instanceof OcrError && e.code === "empty",
    );
  });

  it("去掉「图片中的文字如下：」这类引导语与代码围栏", () => {
    assertEqual(normalizeOcrText("图片中的文字如下：\n正文第一行"), "正文第一行");
    assertEqual(normalizeOcrText("```\n正文\n```"), "正文");
    assertEqual(normalizeOcrText("a\n\n\n\nb"), "a\n\nb", "多余空行压缩");
  });
});

describe("ocr — 调用与错误映射", () => {
  it("正常路径：llama vision 入参形状是 { image: 字节数组, prompt }", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ai = {
      async run(model: string, input: Record<string, unknown>) {
        seen.push({ model, ...input });
        return { description: "扫描件正文" };
      },
    };
    const text = await ocrPage(ai, IMG, {});
    assertEqual(text, "扫描件正文");
    assertEqual(seen[0].model, DEFAULT_OCR_MODEL);
    const image = seen[0].image as number[];
    assert(Array.isArray(image) && image.length > 0, `image 应是非空字节数组: ${typeof seen[0].image}`);
    assert(typeof seen[0].prompt === "string" && (seen[0].prompt as string).length > 20, "prompt 应为完整 OCR 指令");
  });

  it("模型可被环境变量覆盖（中文质量不足时换模型，含 moondream 形状回切）", async () => {
    let modelSeen = "";
    let shape = "";
    await ocrPage(
      {
        async run(model: string, input: Record<string, unknown>) {
          modelSeen = model;
          shape = "task" in input ? "query" : "messages";
          return { answer: "x" };
        },
      },
      IMG,
      { model: "@cf/moondream/moondream3.1-9B-A2B" },
    );
    assertEqual(modelSeen, "@cf/moondream/moondream3.1-9B-A2B");
    assertEqual(shape, "query", "moondream 走 query 形状（保留适配，恢复后可切回）");
  });

  it("配额错误 → OcrError(quota)（路由映射 429）", async () => {
    await assertThrows(
      () =>
        ocrPage(
          {
            async run() {
              throw new Error("429 neuron quota exceeded");
            },
          },
          IMG,
        ),
      (e) => e instanceof OcrError && e.code === "quota",
    );
  });

  it("其它上游错误 → OcrError(upstream)（路由映射 502）", async () => {
    await assertThrows(
      () =>
        ocrPage(
          {
            async run() {
              throw new Error("500 internal");
            },
          },
          IMG,
        ),
      (e) => e instanceof OcrError && e.code === "upstream",
    );
  });

  it("用假 AI 跑通正常路径（与单测替身同源）", async () => {
    const ai = createFakeAI({ ocr: { text: "第 1 页正文" } });
    assertEqual(await ocrPage(ai, IMG), "第 1 页正文");
  });
});