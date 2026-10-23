/**
 * 本地构建：tsc 编译 src/ → dist/（自动把 .ts 相对 import 改写为 .js）
 * 规避沙箱对 esbuild service 进程的限制；wrangler 部署时无需此步。
 * 用法：node scripts/build.mjs
 */

import { execFileSync } from "node:child_process";
import { rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(root, "dist");

if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });

// tsc 同步执行（不 spawn 常驻 service），rewriteRelativeImportExtensions 负责改扩展名
execFileSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"],
  { cwd: root, stdio: "inherit" },
);

console.log(`[build] dist ready at ${distDir}`);
