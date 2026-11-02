#!/usr/bin/env node
/**
 * 一键部署：构建 → `wrangler deploy`（务必带 --secrets-file）→ 线上探针。
 *
 * 用法：
 *   node scripts/deploy.mjs                        # 默认读 ./.secrets.json
 *   node scripts/deploy.mjs --secrets <path>
 *   node scripts/deploy.mjs --skip-build --skip-smoke
 *   LIVE_URL=https://xxx.workers.dev node scripts/deploy.mjs
 *
 * 为什么不走 `void deploy`：Void 只认 CLOUDFLARE_API_TOKEN，本机持的是 wrangler OAuth 凭据。
 *
 * 本增量（1）无 D1：迁移步骤在增量 2 加入（届时先 `npx wrangler d1 create ai-hot-radar-db`）。
 *
 * 探针设计：
 *   /api/health → Worker 代码与 secrets 起来了
 *   /            → 静态资产绑定在（1101 事故的唯一有效探测器）
 *   /api/feed?src=hn → M0 真环境抓取探针（可选，--skip-feed 关闭）
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const WORKER_NAME = "ai-hot-radar";
const HEALTH_SERVICE = "ai-hot-radar";
const LIVE_URL = process.env.LIVE_URL ?? `https://${WORKER_NAME}.ilikesaury.workers.dev`;

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_SSR = resolve(PROJECT_ROOT, "dist/ssr");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

if (flag("--help") || flag("-h")) {
  console.log(
    `用法：node scripts/deploy.mjs [选项]\n` +
      `  --secrets <path>   secrets 文件路径（默认 ./.secrets.json）\n` +
      `  --skip-build       跳过构建（仅用已有 dist/ssr）\n` +
      `  --skip-smoke       跳过线上探针\n` +
      `  --skip-feed        跳过 /api/feed 抓取探针\n` +
      `  -h, --help         显示本帮助`,
  );
  process.exit(0);
}

const skipBuild = flag("--skip-build");
const skipSmoke = flag("--skip-smoke");
const skipFeed = flag("--skip-feed");
const secretsFile = resolve(
  PROJECT_ROOT,
  value("--secrets", process.env.DEPLOY_SECRETS_FILE ?? ".secrets.json"),
);

const isWin = process.platform === "win32";

function run(cmd, args, cwd = PROJECT_ROOT) {
  const printable = [cmd, ...args].join(" ");
  console.log(`\n$ ${printable}   (cwd: ${cwd})`);
  const res = isWin
    ? spawnSync([cmd, ...args.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a))].join(" "), {
        cwd,
        stdio: "inherit",
        shell: true,
      })
    : spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (res.status !== 0) {
    console.error(`\n✖ 命令失败（exit=${res.status ?? res.signal}）：${printable}`);
    process.exit(res.status ?? 1);
  }
}

const npm = isWin ? "npm.cmd" : "npm";
const npx = isWin ? "npx.cmd" : "npx";

/** 从 secrets 文件取 ACCESS_TOKEN（仅用于探针请求头，绝不打印） */
function readAccessToken(path) {
  try {
    const text = readFileSync(path, "utf8");
    if (text.trim().startsWith("{")) {
      const parsed = JSON.parse(text);
      const token = parsed.ACCESS_TOKEN;
      return typeof token === "string" && token.length > 0 ? token : undefined;
    }
    const m = /^ACCESS_TOKEN\s*=\s*(.+)$/m.exec(text);
    return m?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

const token = readAccessToken(secretsFile);

async function probe(path, validate, timeoutMs = 20_000) {
  const url = `${LIVE_URL}${path}`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "cache-control": "no-store",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
      if (res.ok && (await validate(res))) {
        console.log(`  ✔ ${url} → ${res.status}`);
        return true;
      }
      const text = await res.text().catch(() => "");
      console.log(`  · ${url} → ${res.status} ${text.slice(0, 120)}（第 ${attempt} 次，重试）`);
    } catch (e) {
      console.log(`  · ${url} → ${e instanceof Error ? e.message : String(e)}（第 ${attempt} 次，重试）`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.error(`  ✖ ${url} 探针失败`);
  return false;
}

console.log(`部署目标：${WORKER_NAME}（${LIVE_URL}）`);

if (!existsSync(secretsFile)) {
  console.error(
    `\n✖ 找不到 secrets 文件：${secretsFile}\n` +
      `  创建方式：写入 MAGPIE_BASE_URL / MAGPIE_API_KEY / MAGPIE_MODEL（JSON 或 .env 文本），\n` +
      `  再执行：node scripts/deploy.mjs --secrets <path>\n` +
      `  （必须带 --secrets-file，否则重部署会清空线上 secrets）`,
  );
  process.exit(1);
}

if (skipBuild) {
  console.log("\n· 跳过构建（--skip-build）");
} else {
  run(npm, ["run", "build"]);
}

for (const required of ["index.js", "wrangler.json"]) {
  if (!existsSync(resolve(DIST_SSR, required))) {
    console.error(`\n✖ 构建产物缺失：dist/ssr/${required}（先跑一次完整构建，别用 --skip-build）`);
    process.exit(1);
  }
}

run(npx, ["wrangler", "deploy", "--name", WORKER_NAME, "--secrets-file", secretsFile], DIST_SSR);

if (skipSmoke) {
  console.log("\n· 跳过线上探针（--skip-smoke）");
  process.exit(0);
}

console.log("\n线上探针：");
const healthOk = await probe("/api/health", async (res) => {
  const body = await res.json().catch(() => null);
  return body?.ok === true && body?.service === HEALTH_SERVICE;
});
const pageOk = await probe("/", async (res) => {
  const html = await res.text().catch(() => "");
  return (res.headers.get("content-type") ?? "").includes("text/html") && html.length > 500;
});

let feedOk = true;
if (!skipFeed) {
  feedOk = await probe(
    "/api/feed?src=hn&limit=3",
    async (res) => {
      const body = await res.json().catch(() => null);
      const items = Array.isArray(body?.items) ? body.items.length : 0;
      console.log(
        `    feed 探针：条目 ${items} · 耗时 ${body?.elapsedMs ?? "?"}ms · ` +
          `失败 ${body?.failures?.length ?? "?"} 源`,
      );
      return body !== null && Array.isArray(body.items);
    },
    40_000,
  );
}

if (!healthOk || !pageOk || !feedOk) {
  console.error(
    "\n✖ 部署已推送但线上探针未通过。排查顺序：\n" +
      "  1) npx wrangler versions view <最新版本ID> → 必须含 env.ASSETS 绑定\n" +
      "  2) 首页 500 = 静态资产未上传（1101：部署时跳过了 monotonic asset upload）\n" +
      "  3) /api/health 失败 = secrets 丢失或运行时异常\n" +
      "  4) /api/feed 失败 = 源站不可达 / 出网限制，看 failures[].error 分类",
  );
  process.exit(1);
}

console.log("\n✔ 部署完成，探针全过");