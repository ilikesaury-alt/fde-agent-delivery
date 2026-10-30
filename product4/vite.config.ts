import { defineConfig } from "vite";
import { voidPlugin } from "void";
import { voidReact } from "@void/react/plugin";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss(), voidPlugin(), voidReact()],
  resolve: {
    // 用 ORT 的「wasm 运行时外置」构建：wasm 二进制由我们自托管在 /ort/，
    // 不让 Vite 再产出一份 14.8MB 的重复资产（实测 dist 52M → 37M）
    conditions: ["onnxruntime-web-use-extern-wasm", "import", "module", "browser", "default"],
    alias: {
      /**
       * 只引 ONNX Runtime 的 **wasm-only** 入口。
       * 默认入口 `ort.bundle.min.mjs` 把 WebGPU/WebGL 后端一起打进包，
       * 还会顺带产出一个 29.5MB 的 `ort-wasm-simd-threaded.jsep.wasm` ——
       * 我们显式用 backend=wasm（lib/ocr-client.ts），这份二进制度量达到总产物的 45%。
       */
      "onnxruntime-web": "onnxruntime-web/wasm",
    },
  },
});