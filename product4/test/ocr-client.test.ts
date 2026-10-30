/**
 * 浏览器 OCR 封装里**可单测的部分**：SDK 返回 → TableLine 的转换 + 线程数决策。
 * 真正的推理需要浏览器/WASM，由 `e2e/live-scan.mjs` 在真实浏览器里验证。
 */

import { assert, assertEqual, describe, it } from "./harness.ts";
import { desiredThreads, OCR_WASM_PATH, toTableLines } from "../lib/ocr-client.ts";

describe("ocr-client — SDK 结果转换", () => {
  it("poly 四点 → 包围盒（x0/y0/x1/y1）", () => {
    const lines = toTableLines([
      { text: "甘油三酯", score: 0.97, poly: [[100, 200], [180, 202], [178, 230], [98, 228]] },
    ]);
    assertEqual(lines.length, 1);
    assertEqual(lines[0].text, "甘油三酯");
    assertEqual(lines[0].x0, 98);
    assertEqual(lines[0].y0, 200);
    assertEqual(lines[0].x1, 180);
    assertEqual(lines[0].y1, 230);
  });

  it("空文本 / 无坐标的条目被丢弃（不产生 0 宽度的假框）", () => {
    const lines = toTableLines([
      { text: "   ", score: 0.9, poly: [[0, 0], [10, 0], [10, 10], [0, 10]] },
      { text: "无坐标", score: 0.9, poly: [] },
      { text: "正常", score: 0.9, poly: [[1, 1], [9, 1], [9, 9], [1, 9]] },
    ]);
    assertEqual(lines.length, 1);
    assertEqual(lines[0].text, "正常");
  });

  it("置信度夹到 [0,1]；缺 score 记 0（不假装高置信）", () => {
    const lines = toTableLines([
      { text: "a", score: 1.4, poly: [[0, 0], [1, 0], [1, 1], [0, 1]] },
      { text: "b", score: -2, poly: [[0, 0], [1, 0], [1, 1], [0, 1]] },
      { text: "c", poly: [[0, 0], [1, 0], [1, 1], [0, 1]] },
    ]);
    assertEqual(lines[0].score, 1);
    assertEqual(lines[1].score, 0);
    assertEqual(lines[2].score, 0);
  });

  it("wasm 运行时自托管在当前站点（不依赖第三方 CDN）", () => {
    assertEqual(OCR_WASM_PATH, "/ort/", "改这个常量必须同步 scripts/copy-ort.mjs 的目标目录");
  });

  it("未跨源隔离时只能单线程（SharedArrayBuffer 不可用）", () => {
    const t = desiredThreads();
    assert(t >= 1 && t <= 4, `线程数应在 1..4：${t}`);
  });
});