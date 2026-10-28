#!/usr/bin/env node
/**
 * 本地一键验证：起假上游 + shim → 健康检查 → 接口 E2E → 评测 → 收尾清理。
 *
 * 为什么需要它：本产品有 3 个 Cloudflare 绑定没有本地可运行版本
 * （Vectorize / Workers AI / D1），每次手工验证都要起两个进程、挑端口、
 * 等就绪、跑两个脚本、再手动杀进程 —— 本项目实现期重复了 5 次以上。
 * 这个脚本把那段流程固定下来，避免端口冲突与「忘了杀进程」。
 *
 * 用法：
 *   node scripts/local-verify.mjs                 # 全量（E2E + 评测）
 *   node scripts/local-verify.mjs --e2e-only      # 只跑接口 E2E
 *   node scripts/local-verify.mjs --skip-eval     # 同上
 *   node scripts/local-verify.mjs --eval-only      # 只跑评测（消融对比用，会跳过接口 E2E）
 *   node scripts/local-verify.mjs --min-score 0.05
 *   --eval-port 8921   评测用独立 shim 端口（默认 SHIM_PORT+1，见下方说明）
 *
 * 消融对比：HYBRID_ENABLED=0 / CONTEXT_REWRITE=0 由外部环境透传给 shim（见 CONTEXT §11.1）。
 *
 * 退出码：0 全通过；非 0 有失败（可直接用于 CI 或 commit 前自检）。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const value = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

const LLM_PORT = Number(value("--llm-port", 3510));
const SHIM_PORT = Number(value("--shim-port", 8920));
/**
 * 评测必须跑在**干净的库**上：flow-check 会往同一个 shim 里导入它自己的文档，
 * 那些文档会改变检索排序，让评测指标从 100% 掉到 92.9%（不是代码回归，是数据污染 —— 实测踩过）。
 * 所以评测单独起一个 shim 实例（同一个假上游），跑完随 cleanup 一起收掉。
 */
const EVAL_PORT = Number(value("--eval-port", SHIM_PORT + 1));
const MIN_SCORE = value("--min-score", "0.05");
/** 让流式有可观察窗口（浏览器冒烟的「取消」用例需要） */
const CHUNK_DELAY = value("--chunk-delay", "20");
const evalOnly = flag("--eval-only");
const skipEval = evalOnly ? false : flag("--skip-eval");
const e2eOnly = flag("--e2e-only");

const children = [];

function start(name, cmd, args, env) {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push({ name, child });
  child.stdout.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on("data", (d) => process.stdout.write(`[${name}!] ${d}`));
  child.on("exit", (code) => {
    if (code && code !== 0) console.log(`[${name}] 进程退出 code=${code}`);
  });
  return child;
}

async function waitHealthy(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function run(name, args, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(name, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.on("exit", (code) => resolvePromise(code ?? 1));
  });
}

function cleanup() {
  for (const { name, child } of children) {
    try {
      if (process.platform === "win32") {
        // Windows 上 shell 包装会留下子进程，用 taskkill 端点整棵进程树
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill("SIGKILL");
      }
    } catch {
      /* 已退出 */
    }
    void name;
  }
  children.length = 0;
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

async function main() {
  if (!existsSync(resolve(ROOT, "dist/ssr/index.js"))) {
    console.error("✖ 缺少 dist/ssr/index.js —— 先跑 `npm run build`（本次不自动构建，避免掩盖构建失败）");
    process.exit(1);
  }

  console.log(`\n[1/4] 启动假上游模型 :${LLM_PORT}`);
  start("fake-llm", process.execPath, ["e2e/fake-llm.mjs", String(LLM_PORT)], {
    LLM_CHUNK_DELAY_MS: CHUNK_DELAY,
  });

  console.log(`[2/4] 启动本地 shim :${SHIM_PORT}（DB=node:sqlite / VEC=内存余弦 / AI=词袋嵌入）`);
  start("shim", process.execPath, ["--import", "./e2e/bootstrap.mjs", "e2e/server.mjs", String(SHIM_PORT)], {
    MAGPIE_BASE_URL: `http://127.0.0.1:${LLM_PORT}/v1`,
    MAGPIE_API_KEY: "local-fake",
    MAGPIE_MODEL: "fake",
    RETRIEVE_MIN_SCORE: MIN_SCORE,
    // 消融对比开关：从外部环境透传（未设置则用代码默认）
    HYBRID_ENABLED: process.env.HYBRID_ENABLED,
    CONTEXT_REWRITE: process.env.CONTEXT_REWRITE,
    OCR_MODEL: process.env.OCR_MODEL,
  });

  const base = `http://127.0.0.1:${SHIM_PORT}`;
  const healthy = await waitHealthy(`${base}/api/health`);
  if (!healthy) {
    console.error("✖ shim 30s 内未就绪，检查上面的 [shim!] 日志");
    cleanup();
    process.exit(1);
  }
  console.log(`  ✔ 健康检查通过：${base}/api/health\n`);

  let flowCode = 0;
  if (evalOnly) {
    console.log("[3/4] 跳过接口 E2E（--eval-only：消融对比时只跑评测）");
  } else {
    console.log("[3/4] 接口级 E2E");
    flowCode = await run(process.execPath, ["e2e/flow-check.mjs", base]);
    if (flowCode !== 0) {
      console.error("\n✖ 接口 E2E 失败，跳过评测（先修链路）");
      cleanup();
      process.exit(flowCode);
    }
  }

  let evalCode = 0;
  if (!skipEval && !e2eOnly) {
    // 评测跑在**干净的库**上：flow-check 已往主 shim 里导入它自己的文档，
    // 那些文档会改变检索排序、让指标从 100% 掉到 92.9%（数据污染，不是代码回归）。
    const evalBase = `http://127.0.0.1:${EVAL_PORT}`;
    console.log(`\n[4/4] 评测（干净库；独立 shim :${EVAL_PORT}）`);
    start("eval-shim", process.execPath, ["--import", "./e2e/bootstrap.mjs", "e2e/server.mjs", String(EVAL_PORT)], {
      MAGPIE_BASE_URL: `http://127.0.0.1:${LLM_PORT}/v1`,
      MAGPIE_API_KEY: "local-fake",
      MAGPIE_MODEL: "fake",
      RETRIEVE_MIN_SCORE: MIN_SCORE,
      HYBRID_ENABLED: process.env.HYBRID_ENABLED,
      CONTEXT_REWRITE: process.env.CONTEXT_REWRITE,
      OCR_MODEL: process.env.OCR_MODEL,
    });
    if (!(await waitHealthy(`${evalBase}/api/health`))) {
      console.error("✖ 评测用 shim 未就绪");
      cleanup();
      process.exit(1);
    }
    evalCode = await run(process.execPath, ["--experimental-strip-types", "eval/run.ts"], { BASE_URL: evalBase });
  } else {
    console.log("\n[4/4] 跳过评测");
  }

  cleanup();

  if (evalCode !== 0) {
    console.error("\n✖ 评测未达底线");
    process.exit(evalCode);
  }
  console.log("\n✅ 本地验证全部通过（提示：阈值与质量的最终标定必须用线上真模型，见 CONTEXT D16）");
}

await main();
