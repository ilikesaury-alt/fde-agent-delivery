/**
 * 构建前把 ONNX Runtime 的 wasm 运行时复制到 public/ort/。
 *
 * 为什么自托管而不是用 CDN：
 *   - 本站开了 COOP/COEP（多线程 WASM 需要跨源隔离），同源自托管最稳
 *   - 不把一个 14.8MB 的二进制的可用性绑在第三方 CDN 上
 *
 * 只复制 **非 jsep** 的两个文件：我们显式用 backend=wasm（WebGPU 需要另一份 29.5MB 运行时，
 * 当前不引入，见 lib/ocr-client.ts 注释）。
 */

import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const SRC = "node_modules/onnxruntime-web/dist";
const DEST = "public/ort";
const FILES = ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"];

mkdirSync(DEST, { recursive: true });
for (const f of FILES) {
  const from = join(SRC, f);
  if (!existsSync(from)) {
    console.error(`[copy-ort] 缺少 ${from} —— onnxruntime-web 版本是否变了？`);
    process.exit(1);
  }
  copyFileSync(from, join(DEST, f));
  console.log(`[copy-ort] ${f} → ${join(DEST, f)}`);
}
