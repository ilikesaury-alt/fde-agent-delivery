#!/usr/bin/env node
/**
 * 一键部署：迁移（可选）→ 构建 → `wrangler deploy`（务必带 --secrets-file）→ 线上探针。
 *
 * 用法：
 *   node scripts/deploy.mjs                          # 默认读 <project>/.secrets.json
 *   node scripts/deploy.mjs --secrets ../.secrets.json
 *   node scripts/deploy.mjs --skip-build --skip-smoke
 *   node scripts/deploy.mjs --skip-migrate            # 已有表结构时跳过迁移
 *   LIVE_URL=https://xxx.workers.dev node scripts/deploy.mjs
 *
 * 为什么不走 `void deploy`：Void 只认 CLOUDFLARE_API_TOKEN，本机持的是 wrangler OAuth 凭据。
 *
 * 首次部署前必须先建资源（本产品 D1 已在 2026-10-29 建好）：
 *   npx wrangler d1 create health-track-db
 *
 * 迁移只走 `wrangler d1 migrations apply`：`d1 execute --file` 不写迁移台账，
 * 下次 apply 会把已执行的 migration 再跑一遍（产品③ 踩过）。
 *
 * 探针设计：
 *   /api/health → Worker 代码与 secrets 起来了
 *   /            → 静态资产绑定在（1101 事故的唯一有效探测器）
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const WORKER_NAME = "health-track";
const DB_NAME = "health-track-db";
const LIVE_URL = process.env.LIVE_URL ?? "https://health-track.ilikesaury.workers.dev";
const HEALTH_SERVICE = "health-track";

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
      `  --secrets <path>   secrets 文件路径（默认 ./.secrets.json，也可用环境变量 DEPLOY_SECRETS_FILE）\n` +
      `  --skip-build       跳过构建（仅用已有 dist/ssr）\n` +
      `  --skip-migrate     跳过 D1 迁移\n` +
      `  --skip-smoke       跳过部署后的线上探针\n` +
      `  -h, --help         显示本帮助`,
  );
  process.exit(0);
}

const skipBuild = flag("--skip-build");
const skipMigrate = flag("--skip-migrate");
const skipSmoke = flag("--skip-smoke");
const secretsFile = resolve(PROJECT_ROOT, value("--secrets", process.env.DEPLOY_SECRETS_FILE ?? ".secrets.json"));

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

async function probe(path, validate) {
  const url = `${LIVE_URL}${path}`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { "cache-control": "no-store" } });
      if (res.ok && (await validate(res))) {
        console.log(`  ✔ ${url} → ${res.status}`);
        return true;
      }
      console.log(`  · ${url} → ${res.status}（第 ${attempt} 次，重试）`);
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
      `  创建方式：写入 MAGPIE_BASE_URL / MAGPIE_API_KEY / MAGPIE_MODEL / ACCESS_TOKEN 的 JSON 或 .env 文本，\n` +
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

if (skipMigrate) {
  console.log("\n· 跳过 D1 迁移（--skip-migrate）");
} else {
  // 迁移必须在 dist/ssr 下执行：wrangler 从这里读生成的 wrangler.json（含 database_id 与 migrations_dir）
  run(npx, ["wrangler", "d1", "migrations", "apply", DB_NAME, "--remote"], DIST_SSR);
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

if (!healthOk || !pageOk) {
  console.error(
    "\n✖ 部署已推送但线上探针未通过。排查顺序：\n" +
      "  1) npx wrangler versions view <最新版本ID> → 必须同时含 env.ASSETS / env.DB 两个绑定\n" +
      "  2) 首页 500 = 静态资产未上传（1101：部署时跳过了 monotonic asset upload）\n" +
      "  3) /api/health 失败 = secrets 丢失或运行时异常 → npx wrangler tail 看实时日志\n" +
      "  4) 首次部署前必须先建资源：wrangler d1 create health-track-db",
  );
  process.exit(1);
}