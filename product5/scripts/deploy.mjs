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
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const WORKER_NAME = "ai-hot-radar";
const DB_NAME = "ai-hot-radar-db";
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
      `  --skip-migrate     跳过 D1 迁移\n` +
      `  --skip-smoke       跳过线上探针\n` +
      `  --skip-feed        跳过 /api/feed 抓取探针\n` +
      `  --probe-only       只跑线上探针（隐含 --skip-build --skip-migrate --skip-deploy）\n` +
      `  -h, --help         显示本帮助`,
  );
  process.exit(0);
}

const probeOnly = flag("--probe-only");
const skipBuild = probeOnly || flag("--skip-build");
const skipMigrate = probeOnly || flag("--skip-migrate");
// --probe-only 时不要重新部署：我几次「只想验一下」却每次都推了新版本（版本号空转），这里显式禁止
const skipDeploy = probeOnly || flag("--skip-deploy");
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

/**
 * 探针出口：本机若需代理，Node 的 fetch **不认系统代理**（实测 curl 通、fetch failed），
 * 部署会因此以 exit 1 结束 —— 看起来像部署失败，其实只是探针发不出去。
 * 所以：设了 DEPLOY_PROXY / HTTPS_PROXY 时走 curl -x；否则用 fetch。
 */
// ⚠️ .trim() 必须加：Windows cmd 的 `set X=Y && ...` 会把尾空格带进值，
// curl 会报 `Unsupported proxy syntax ... ` （实测踩过，探针全灭）
const PROXY = (process.env.DEPLOY_PROXY ?? process.env.HTTPS_PROXY ?? process.env.https_proxy ?? "").trim();

/** 统一的一次请求（返回可判定的 status + 文本 + content-type），代理模式下走 curl */
function requestOnce(url, timeoutMs) {
  if (PROXY) {
    // ⚠️ 必须把 content-type 一起吐出来：首页探针要判 `text/html`，
    // 第一版漏了它，导致「200 但探针失败」的假失败（实测踩过）。
    const args = [
      "-sS",
      "-x",
      PROXY,
      "--max-time",
      String(Math.max(5, Math.ceil(timeoutMs / 1000))),
      "-H",
      "cache-control: no-store",
      ...(token ? ["-H", `authorization: Bearer ${token}`] : []),
      "-w",
      "\n%{http_code}\n%{content_type}",
      url,
    ];
    const res = spawnSync("curl", args, { encoding: "utf8" });
    if (res.error || res.status !== 0) {
      throw new Error((res.stderr ?? res.error?.message ?? "curl 失败").trim().slice(0, 200));
    }
    const out = res.stdout ?? "";
    const parts = out.split("\n");
    const contentType = parts.pop() ?? "";
    const status = Number.parseInt(parts.pop() ?? "", 10);
    return Promise.resolve({ status, text: parts.join("\n"), contentType });
  }
  return fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "cache-control": "no-store", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  }).then(async (r) => ({
    status: r.status,
    text: await r.text(),
    contentType: r.headers.get("content-type") ?? "",
  }));
}

/** 把 {status,text} 适配成 probe 校验函数习惯的 Response 形状 */
function asResponseLike(r) {
  return {
    status: r.status,
    ok: r.status >= 200 && r.status < 300,
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? (r.contentType ?? "") : null) },
    text: async () => r.text,
    json: async () => JSON.parse(r.text),
  };
}

/** 是否真正收到过 HTTP 响应（区分「站点坏了」与「本机发不出去」） */
let sawHttpStatus = false;

async function probe(path, validate, timeoutMs = 20_000) {
  const url = `${LIVE_URL}${path}`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const raw = await requestOnce(url, timeoutMs);
      if (Number.isFinite(raw.status) && raw.status > 0) sawHttpStatus = true;
      const res = asResponseLike(raw);
      if (res.ok && (await validate(res))) {
        console.log(`  ✔ ${url} → ${res.status}`);
        return true;
      }
      console.log(`  · ${url} → ${res.status} ${String(raw.text ?? "").slice(0, 120)}（第 ${attempt} 次，重试）`);
    } catch (e) {
      console.log(`  · ${url} → ${e instanceof Error ? e.message : String(e)}（第 ${attempt} 次，重试）`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.error(`  ✖ ${url} 探针失败`);
  return false;
}

console.log(`部署目标：${WORKER_NAME}（${LIVE_URL}）`);
if (PROXY) console.log(`探针出口：代理 ${PROXY}（curl -x）`);
else console.log(`探针出口：直连（若本机需代理，用 DEPLOY_PROXY=http://127.0.0.1:7890 重跑仅探针）`);

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

if (skipMigrate) {
  console.log("\n· 跳过 D1 迁移（--skip-migrate）");
} else {
  // 迁移必须在 dist/ssr 下执行：wrangler 从这里读生成的 wrangler.json（含 database_id 与 migrations_dir）。
  // 但 wrangler 把 migrations_dir 按 **cwd** 解析 → 必须把 db/migrations 拷进 dist/ssr，否则报
  // 「No migrations folder found / No migrations present at dist/ssr/db/migrations」（实测）。
  // 只用 `d1 migrations apply`，不用 `d1 execute --file`：后者不写迁移台账，下次 apply 会重跑（产品③踩过）。
  const migrationsSrc = resolve(PROJECT_ROOT, "db/migrations");
  const migrationsDst = resolve(DIST_SSR, "db/migrations");
  if (existsSync(migrationsSrc)) {
    mkdirSync(resolve(DIST_SSR, "db"), { recursive: true });
    cpSync(migrationsSrc, migrationsDst, { recursive: true });
  }
  run(npx, ["wrangler", "d1", "migrations", "apply", DB_NAME, "--remote"], DIST_SSR);
}

if (skipDeploy) {
  console.log("\n· 跳过部署（--skip-deploy / --probe-only）");
} else {
  run(npx, ["wrangler", "deploy", "--name", WORKER_NAME, "--secrets-file", secretsFile], DIST_SSR);
}

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
  if (!sawHttpStatus) {
    console.warn(
      "\n⚠ 部署已成功，但探针一个 HTTP 响应都没收到（本机网络/代理问题）→ 记为「未验证」，不计部署失败。\n" +
        "   带代理重跑探针：DEPLOY_PROXY=http://127.0.0.1:7890 node scripts/deploy.mjs --skip-build --skip-migrate",
    );
    process.exit(0);
  }
  console.error(
    "\n✖ 部署已推送但线上探针未通过。排查顺序：\n" +
      "  1) npx wrangler versions view <最新版本ID> → 必须含 env.ASSETS 绑定\n" +
      "  2) 首页 500 = 静态资产未上传（1101：部署时跳过了 monotonic asset upload）\n" +
      "  3) /api/health 失败 = secrets 丢失或运行时异常\n" +
      "  4) /api/feed 失败 = 源站不可达 / 出网限制，看 failures[].error 分类\n" +
      "  5) 探针全部 fetch 失败但现在能上网？本机需代理，重跑探针：\n" +
      "     DEPLOY_PROXY=http://127.0.0.1:7890 node scripts/deploy.mjs --skip-build --skip-migrate",
  );
  process.exit(1);
}

console.log(skipDeploy ? "\n✔ 线上探针全过（本次未部署）" : "\n✔ 部署完成，探针全过");
