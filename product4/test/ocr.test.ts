/** OCR（入参形状按模型族 + 5016 自愈 + 空返回不能当成功） */

import { assert, assertEqual, assertThrows, describe, it } from "./harness.ts";
import {
  buildAgreeInput,
  buildVisionInput,
  extractOcrText,
  MAX_OCR_IMAGE_CHARS,
  normalizeImage,
  normalizeOcrText,
  ocrPage,
  type AILike,
} from "../lib/ocr.ts";
import { OcrError } from "../lib/errors.ts";

const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

describe("ocr — 图片入参校验", () => {
  it("只接受 data URL（不接受远程 URL —— 避免新 SSRF 面）", async () => {
    assertEqual(normalizeImage(JPEG), JPEG);
    await assertThrows(() => normalizeImage("https://evil/x.jpg"), (e) => e instanceof OcrError && e.code === "ocrBadImage");
    await assertThrows(() => normalizeImage(""), (e) => e instanceof OcrError && e.code === "ocrBadImage");
    await assertThrows(() => normalizeImage(null), (e) => e instanceof OcrError && e.code === "ocrBadImage");
  });

  it("超大图 → ocrTooLarge", async () => {
    const huge = `data:image/jpeg;base64,${"A".repeat(MAX_OCR_IMAGE_CHARS)}`;
    await assertThrows(() => normalizeImage(huge), (e) => e instanceof OcrError && e.code === "ocrTooLarge");
  });
});

describe("ocr — 入参形状按模型族", () => {
  it("llama-3.2-vision → 字节数组 + prompt（messages 形状会报 5016）", () => {
    const input = buildVisionInput("@cf/meta/llama-3.2-11b-vision-instruct", JPEG, "p") as {
      image: number[];
      prompt: string;
      max_tokens: number;
    };
    assert(Array.isArray(input.image), "图片必须是字节数组");
    assertEqual(input.prompt, "p");
    assertEqual(input.max_tokens, 2048);
    assert(!("messages" in input), "llama 不能用 messages 形状");
  });

  it("chat 形状模型 → messages + image_url", () => {
    const input = buildVisionInput("@cf/qwen/qwen2.5-vl", JPEG, "p") as { messages: unknown[] };
    assert(Array.isArray(input.messages));
  });

  it("moondream → query 形状", () => {
    const input = buildVisionInput("@cf/moondream/moondream3.1-9B-A2B", JPEG, "p") as { task: string };
    assertEqual(input.task, "query");
  });

  it("agree 形状按族匹配", () => {
    assertEqual(buildAgreeInput("@cf/meta/llama-3.2-11b-vision-instruct"), { prompt: "agree" });
    const chat = buildAgreeInput("@cf/qwen/qwen2.5-vl") as { messages: unknown[] };
    assert(Array.isArray(chat.messages));
  });
});

describe("ocr — 返回形状容错", () => {
  it("覆盖 answer/description/choices/response/纯字符串", () => {
    assertEqual(extractOcrText({ answer: "文本A" }), "文本A");
    assertEqual(extractOcrText({ description: "文本B" }), "文本B");
    assertEqual(extractOcrText({ choices: [{ message: { content: "文本C" } }] }), "文本C");
    assertEqual(extractOcrText({ response: "文本D" }), "文本D");
    assertEqual(extractOcrText("文本E"), "文本E");
  });

  it("空对象 → ocrEmpty（HTTP 200 但空返回是真实踩过的坑）", async () => {
    await assertThrows(() => extractOcrText({}), (e) => e instanceof OcrError && e.code === "ocrEmpty");
    await assertThrows(() => extractOcrText({ answer: "   " }), (e) => e instanceof OcrError && e.code === "ocrEmpty");
  });

  it("剥离模型引导语（「图片中的文字如下：」）", () => {
    assertEqual(normalizeOcrText("图片中的文字如下：\n甘油三酯 2.31"), "甘油三酯 2.31");
    assertEqual(normalizeOcrText("```\n文本\n```"), "文本");
  });
});

describe("ocr — 调用与 5016 自愈", () => {
  it("正常返回 → 文本", async () => {
    const ai: AILike = { async run() { return { description: "甘油三酯 2.31" }; } };
    assertEqual(await ocrPage(ai, JPEG), "甘油三酯 2.31");
  });

  it("首次 5016 → 提交 agree 后重试成功（自愈）", async () => {
    const calls: string[] = [];
    const ai: AILike = {
      async run(_model, input) {
        const isAgree = (input as { prompt?: string }).prompt === "agree";
        calls.push(isAgree ? "agree" : "vision");
        if (isAgree) return {};
        if (calls.filter((c) => c === "vision").length === 1) throw new Error("5016 license not agreed");
        return { description: "识别成功" };
      },
    };
    assertEqual(await ocrPage(ai, JPEG), "识别成功");
    assertEqual(calls, ["vision", "agree", "vision"], "顺序：主调 → 同意 → 重试");
  });

  it("配额错误 → ocrQuota（路由映射 429）", async () => {
    const ai: AILike = { async run() { throw new Error("quota exceeded"); } };
    await assertThrows(() => ocrPage(ai, JPEG), (e) => e instanceof OcrError && e.code === "ocrQuota");
  });

  it("其它上游错误 → ocrUpstream（不是 empty，不能骗用户说没字）", async () => {
    const ai: AILike = { async run() { throw new Error("internal server error"); } };
    await assertThrows(() => ocrPage(ai, JPEG), (e) => e instanceof OcrError && e.code === "ocrUpstream");
  });

  it("模型返回空对象 → ocrEmpty", async () => {
    const ai: AILike = { async run() { return {}; } };
    await assertThrows(() => ocrPage(ai, JPEG), (e) => e instanceof OcrError && e.code === "ocrEmpty");
  });
});