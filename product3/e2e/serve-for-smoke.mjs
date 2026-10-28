#!/usr/bin/env node
/**
 * 浏览器冒烟用的常驻本地栈（假上游 + Node shim），不跑断言、只提供服务。
 *
 * 为什么单独一个脚本：`scripts/local-verify.mjs` 是「跑完就退出」的验证器，
 * 而 ego-browser 冒烟需要栈在**断言执行期间**一直活着。这里只负责起服务和收尾，
 * 端口与 smoke-ui.mjs 里写死的 BASE 对齐（8913 / 3513）。
 *
 * 用法：
 *   node e2e/serve-for-smoke.mjs            # 起栈，Ctrl+C 或 kill 结束
 *   node e2e/serve-for-smoke.mjs --port 8913 --llm-port 3513
 */

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const SHIM_PORT = value("--port", "8913");
const LLM_PORT = value("--llm-port", "3513");

const children = [];
function start(name, args, env) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stdout.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on("data", (d) => process.stdout.write(`[${name}!] ${d}`));
  return child;
}

function cleanup() {
  for (const child of children) {
    try {
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else child.kill("SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
  children.length = 0;
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

start("fake-llm", ["e2e/fake-llm.mjs", LLM_PORT], { LLM_CHUNK_DELAY_MS: "20" });
start("shim", ["--import", "./e2e/bootstrap.mjs", "e2e/server.mjs", SHIM_PORT], {
  MAGPIE_BASE_URL: `http://127.0.0.1:${LLM_PORT}/v1`,
  MAGPIE_API_KEY: "local-fake",
  MAGPIE_MODEL: "fake",
  // 本地词袋嵌入尺度 ≈ 0.05–0.2，阈值必须显式降下来（线上真模型用 0.45）
  RETRIEVE_MIN_SCORE: "0.05",
});

const base = `http://127.0.0.1:${SHIM_PORT}`;
for (let i = 0; i < 100; i++) {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      console.log(`[serve-for-smoke] ready: ${base}`);
      break;
    }
  } catch {
    /* 还没起来 */
  }
  await new Promise((r) => setTimeout(r, 300));
}