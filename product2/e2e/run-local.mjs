/**
 * 本地启动器：补齐 env 后启动 shim。
 * 优先级：进程已有的环境变量 > product2/.env.local > product1/.env（复用同一 magpie 凭据）
 *
 * 便利行为：若 .env 里的 MAGPIE_BASE_URL 指向 cloudflared 临时隧道而隧道未开，
 * 自动改用本地 magpie 网关（127.0.0.1:3425/v1），省得每次手动改。
 *
 * 用法：node --import ./e2e/bootstrap.mjs e2e/run-local.mjs [port] [--no-fallback]
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = /^([A-Za-z_0-9]+)\s*=\s*(.*)$/.exec(trimmed);
    if (!m) continue;
    env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

const root = new URL("..", import.meta.url);
const local = loadEnvFile(fileURLToPath(new URL("./.env.local", root)));
const product1 = loadEnvFile(fileURLToPath(new URL("../product1/.env", root)));
// 注意：不复用 product1 的 MAGPIE_MODEL —— 那是产品①的生产模型名，
// 本地网关未必有（实测 group/cheap-first 直接 400 benefit not found）。
const merged = { MAGPIE_BASE_URL: product1.MAGPIE_BASE_URL, MAGPIE_API_KEY: product1.MAGPIE_API_KEY, ...local };

for (const key of ["MAGPIE_BASE_URL", "MAGPIE_API_KEY", "MAGPIE_MODEL", "ACCESS_TOKEN"]) {
  if (!process.env[key] && merged[key]) process.env[key] = merged[key];
}

process.env.MAGPIE_MODEL ||= "auto/minimax-m3.1-flash";

const noFallback = process.argv.includes("--no-fallback");
if (!noFallback && process.env.MAGPIE_BASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.MAGPIE_BASE_URL)) {
  try {
    await fetch(`${process.env.MAGPIE_BASE_URL.replace(/\/+$/, "")}/models`, {
      headers: { authorization: `Bearer ${process.env.MAGPIE_API_KEY}` },
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    console.log(`[run-local] 隧道不可达，回退到本地 magpie 网关 http://127.0.0.1:3425/v1`);
    process.env.MAGPIE_BASE_URL = "http://127.0.0.1:3425/v1";
  }
}

console.log(`[run-local] model=${process.env.MAGPIE_MODEL} base=${process.env.MAGPIE_BASE_URL}`);
console.log(`[run-local] ACCESS_TOKEN=${process.env.ACCESS_TOKEN ? "已设置" : "未设置（不校验）"}`);

process.argv[2] = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "8901";
await import("./server.mjs");
