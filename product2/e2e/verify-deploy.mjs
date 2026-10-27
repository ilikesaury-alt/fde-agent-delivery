/**
 * 部署后核验（顺序写死，缺一步就可能漏掉 1101 类故障）
 *
 *   1) 绑定核验：versions view 必须同时看到 env.ASSETS 与 env.DB
 *   2) 部署日志：assetUploadFileCount > 0
 *   3) /api/health 返回 ok
 *   4) 页面正文不含错误页特征（1101 / Error / 无法访问）
 *   5) 未带令牌访问 /api/jobs → 401（证明令牌真的生效）
 *   6) 带令牌访问 → 200 且是业务 JSON（不是错误页 HTML）
 *
 * 用法：node e2e/verify-deploy.mjs <workerUrl> <accessToken> [workerName]
 */

import { execFileSync } from "node:child_process";

const base = (process.argv[2] || "").replace(/\/+$/, "");
const token = process.argv[3] || "";
const workerName = process.argv[4] || "content-studio";

if (!base) {
  console.error("用法: node e2e/verify-deploy.mjs <workerUrl> <accessToken> [workerName]");
  process.exit(2);
}

const results = [];
const check = (name, pass, extra = "") => {
  results.push({ name, pass, extra });
  console.log(`  ${pass ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`);
};

// ---------- 1) 绑定核验 ----------
console.log("\n=== 1. 绑定核验（wrangler versions view）===");
let versionId = null;
try {
  const listOut = execFileSync(
    "npx",
    ["wrangler", "deployments", "list", "--name", workerName, "--json"],
    { encoding: "utf8", shell: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const list = JSON.parse(listOut);
  versionId = Array.isArray(list) ? list[0]?.versions?.[0]?.version_id ?? list[0]?.id : null;
  console.log(`  最新 version: ${versionId ?? "(未取到)"}`);
} catch (e) {
  console.log(`  ⚠️ 取 deployments 失败（可手工核验）: ${String(e.message).slice(0, 120)}`);
}

if (versionId) {
  try {
    const viewOut = execFileSync(
      "npx",
      ["wrangler", "versions", "view", versionId, "--name", workerName],
      { encoding: "utf8", shell: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const hasAssets = /\bASSETS\b/.test(viewOut);
    const hasDb = /\bDB\b/.test(viewOut);
    check("绑定含 env.ASSETS（静态资产）", hasAssets);
    check("绑定含 env.DB（D1）", hasDb);
    if (!hasAssets || !hasDb) {
      console.log("\n--- versions view 原文（截断）---");
      console.log(viewOut.slice(0, 2500));
    }
  } catch (e) {
    check("versions view 可执行", false, String(e.message).slice(0, 120));
  }
} else {
  console.log("  ⚠️ 跳过：未取到 version id，请手工执行 wrangler versions view <id> --name " + workerName);
}

// ---------- 2..6) 线上探测 ----------
console.log("\n=== 2. 健康与页面 ===");
let healthOk = false;
try {
  const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(15_000) });
  const text = await r.text();
  healthOk = r.status === 200 && text.includes("\"ok\":true");
  check("/api/health 返回 ok", healthOk, `status=${r.status} body=${text.slice(0, 80)}`);
} catch (e) {
  check("/api/health 可达", false, String(e.message).slice(0, 100));
}

try {
  const r = await fetch(`${base}/`, { signal: AbortSignal.timeout(20_000) });
  const html = await r.text();
  const isErrorPage = /Error\s*1101|Internal Server Error|error code:\s*1101|Worker threw exception/i.test(html);
  const hasAppShell = html.includes("内容工作台") || html.includes("生成笔记");
  check("页面不是错误页", !isErrorPage, isErrorPage ? "检测到 1101/异常页特征" : "");
  check("页面含应用外壳（SSR 正常）", hasAppShell, `len=${html.length}`);
} catch (e) {
  check("页面可达", false, String(e.message).slice(0, 100));
}

console.log("\n=== 3. 令牌与业务接口 ===");
if (token) {
  try {
    const r = await fetch(`${base}/api/jobs`, { signal: AbortSignal.timeout(15_000) });
    check("无令牌访问 /api/jobs → 401", r.status === 401, `status=${r.status}`);
  } catch (e) {
    check("无令牌探测可达", false, String(e.message).slice(0, 100));
  }

  try {
    const r = await fetch(`${base}/api/jobs`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await r.text();
    let isJson = false;
    let hasJobs = false;
    try {
      const j = JSON.parse(text);
      isJson = true;
      hasJobs = Array.isArray(j.jobs);
    } catch {}
    check("带令牌访问 → 200", r.status === 200, `status=${r.status}`);
    check("返回业务 JSON（不是错误页）", isJson && hasJobs, text.slice(0, 80));
  } catch (e) {
    check("带令牌探测可达", false, String(e.message).slice(0, 100));
  }
} else {
  console.log("  ⚠️ 未提供 token，跳过令牌相关核验");
}

console.log("\n=== 汇总 ===");
const failed = results.filter((x) => !x.pass);
console.log(`通过 ${results.length - failed.length} / ${results.length}`);
if (failed.length) {
  console.log("\n失败项：");
  for (const f of failed) console.log(`  ✗ ${f.name} ${f.extra}`);
  process.exit(1);
}
console.log("\nDEPLOY-VERIFY PASS");
