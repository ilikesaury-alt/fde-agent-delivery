/**
 * 本地开发服务器 — 用 miniflare 直接起 Worker（不经 wrangler CLI，规避 esbuild service 限制）
 * 用法：node scripts/dev.mjs
 * 然后访问 http://127.0.0.1:8787/health
 *
 * ⚠️ 已知限制（DSH Windows 沙箱）：
 * miniflare 需要 spawn workerd 子进程；在禁止 child_process.spawn 的沙箱中无法本地运行。
 * 表现：Error: spawn EPERM at Runtime.updateConfig。
 * 解法：在未受限的本地终端运行本脚本；或直接用 `npx wrangler dev`（需 esbuild，同样受此限制）。
 * 部署到 Cloudflare（wrangler deploy）不受影响。
 */

import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// 从 wrangler.toml 读取非敏感 [vars]（密钥请用环境变量注入）
function loadVars() {
  const vars = {};
  const tomlPath = join(root, "wrangler.toml");
  if (!existsSync(tomlPath)) return vars;
  const text = readFileSync(tomlPath, "utf8");
  const inVars = /\[vars\]([\s\S]*?)(\n\[|$)/.exec(text);
  if (!inVars) return vars;
  for (const line of inVars[1].split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"(.*)"\s*$/.exec(line);
    if (m) vars[m[1]] = m[2];
  }
  return vars;
}

// 用 v4 风格选项（与 wrangler.toml 对齐），再由官方转换函数转成内部格式
const options = convertV4MiniflareOptions({
  port: 8787,
  host: "127.0.0.1",
  name: "meeting-digest-worker",
  compatibilityDate: "2025-10-14",
  compatibilityFlags: ["nodejs_compat"],
  modules: [
    {
      type: "ESModule",
      path: join(root, "dist", "index.js"),
    },
  ],
  // 相对 import 基于 dist/ 解析
  modulesRoot: join(root, "dist"),
  bindings: {
    ...loadVars(),
    // 真实密钥从这里注入（环境变量优先），绝不进仓库
    MAGPIE_API_KEY: process.env.MAGPIE_API_KEY ?? "",
  },
});

const mf = new Miniflare(options);

await mf.ready;
console.log("[dev] miniflare worker listening on http://127.0.0.1:8787");
console.log("[dev] try: curl http://127.0.0.1:8787/health");

// 保持进程存活
await new Promise(() => {});
