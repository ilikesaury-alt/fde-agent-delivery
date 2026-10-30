/**
 * 构建后清理「用不到但会被一起上传」的资产。
 *
 * 具体案例：PaddleOCR.js 的包内自带一个**预打包 worker**（`assets/worker-entry-*.js`，11.3MB），
 * 里面内联了 jsep 版 ONNX Runtime。我们用的是自己开的 Worker（lib/ocr-worker.ts），
 * `worker: false` 走 inline 管线，**永远不会加载这个文件** —— 但 Vite 仍会把它当资产产出。
 * 删掉它省 11MB 部署体积；若将来改用 SDK 自带 worker，必须同时删掉这条清理。
 */

import { readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIR = "dist/client/assets";
if (!existsSync(DIR)) process.exit(0);

let removed = 0;
for (const name of readdirSync(DIR)) {
  if (/^worker-entry-.*\.js(\.map)?$/.test(name)) {
    rmSync(join(DIR, name));
    removed++;
    console.log(`[prune] 删除未使用的 SDK 预打包 worker：${name}`);
  }
}
if (removed === 0) console.log("[prune] 没有需要清理的资产");
