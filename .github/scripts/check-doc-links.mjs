#!/usr/bin/env node
/**
 * 文档链接校验：检查仓库内所有 markdown 的相对链接是否真实存在。
 *
 * 只校验「相对文件链接」（跳过 http(s)://、mailto:、纯锚点 #xxx）。
 * 反引号里的路径是本仓库的「仓库根相对路径」约定，一并抽检存在性。
 *
 * 存在性判定 = CI checkout 视角（2026-10-29 修正）：
 *   旧版按「磁盘存在」判定 —— gitignore 的本地文件（.secrets.json/.env）在磁盘上存在，
 *   本地全绿、CI 上必然失败（checkout 里没有这些文件）。现改为按「git 追踪集」判定，
 *   被gitignore 匹配的路径视为「有意引用的本地文件」跳过。
 *
 * 用法：node .github/scripts/check-doc-links.mjs
 */

import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "legacy", "research", ".pi", ".npm-cache", ".pnpm-store"]);

/** git 追踪集（CI checkout 视角的文件全集） */
const tracked = new Set(
  execSync("git ls-files -z", { cwd: ROOT, encoding: "buffer" })
    .toString()
    .split("\0")
    .filter(Boolean)
    .map((p) => p.replaceAll("\\", "/")),
);

const IGNORE_RULES = readFileSync(join(ROOT, ".gitignore"), "utf8")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

/**
 * 通配规则 → 正则：逐字符构造。
 * 不用 `new RegExp("^" + s.replace(/[...]/g, "\\$&") + "$")` 这类转义技巧——
 * 转义写法在多轮工具链传递中容易被写坏：实测 `\*` 被写成字面反斜杠加量词后，
 * 匹配反斜杠序列，星号的替换永不发生，规则静默失效。
 */
function wildToRegExp(rule) {
  let src = "";
  for (const ch of rule) {
    if (ch === "*") src += "[^/]*";
    else if (/[a-zA-Z0-9/]/.test(ch)) src += ch;
    else src += "\\" + ch;
  }
  return new RegExp("^" + src + "$");
}

/** 路径是否被 .gitignore 匹配（简化版：目录/文件/通配三类，覆盖本仓库现有规则） */
function isIgnored(p) {
  const segments = p.split("/");
  return IGNORE_RULES.some((rule) => {
    const r = rule.replace(/^\//, "").replace(/\\$/, "");
    if (r.endsWith("/")) {
      // 目录规则（如 dist/）匹配任意层级的该目录段
      const dir = r.slice(0, -1);
      return segments.includes(dir) || p === dir || p.startsWith(dir + "/");
    }
    if (r.includes("*")) return wildToRegExp(r).test(p);
    // 文件/路径规则：全路径、basename、或目录前缀
    return p === r || segments[segments.length - 1] === r || p.startsWith(r + "/");
  });
}

/** CI checkout 视角的存在性：路径在追踪集里，或其下有追踪文件（目录） */
function existsOnCi(p) {
  const prefix = p.endsWith("/") ? p : p + "/";
  for (const t of tracked) {
    if (t === p || t.startsWith(prefix)) return true;
  }
  return false;
}

/** 递归收集 markdown 文件 */
function collectMd(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectMd(join(dir, entry.name), acc);
    } else if (extname(entry.name) === ".md") {
      acc.push(join(dir, entry.name));
    }
  }
  return acc;
}

const files = collectMd(ROOT);
const problems = [];

/**
 * 允许的白名单：这些 `docs/...` 指的是 **pi 自身文档**，不是本仓库文件。
 * （探查、写文档时经常引用 pi 的 docs/，不应被当成断链）
 */
const PI_DOC_PATHS = new Set([
  "docs/security.md",
  "docs/extensions.md",
  "docs/themes.md",
  "docs/skills.md",
  "docs/prompt-templates.md",
  "docs/tui.md",
  "docs/keybindings.md",
  "docs/sdk.md",
  "docs/custom-provider.md",
  "docs/models.md",
  "docs/packages.md",
  "docs/environment-variables.md",
  "docs/mcp.md",
  "docs/codemode.md",
]);
const isPiDoc = (p) => PI_DOC_PATHS.has(p) || p.startsWith("docs/guide/");

/** 归一化路径：去掉 .. / . 段（均已是 / 分隔） */
function normalize(p) {
  return p.split("/").reduce((st, x) => {
    if (x === "..") st.pop();
    else if (x !== "." && x !== "") st.push(x);
    return st;
  }, []).join("/");
}

/** 逐行扫描，保持行号可用于报错 */
for (const file of files) {
  const rel = file.slice(ROOT.length + 1).replaceAll("\\", "/");
  if (!tracked.has(rel)) continue; // 未入库的 md（本地草稿）不在 CI 视角内
  const lines = readFileSync(file, "utf8").split(/\r?\n/);

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;

    // 1) markdown 链接：[text](target)
    for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      let clean;
      try {
        clean = decodeURIComponent(target.split("#")[0]);
      } catch {
        clean = target.split("#")[0];
      }
      if (!clean) continue;
      const relPath = normalize((dirname(rel) + "/" + clean).replaceAll("\\", "/"));
      // CI 视角：被 git 追踪 → CI 上存在；被 gitignore 匹配 → 有意引用的本地文件；其余 → 真断链
      if (existsOnCi(relPath) || isIgnored(relPath)) continue;
      problems.push(`${rel}:${lineNo} 断链 → ${target}`);
    }

    // 2) 反引号中的仓库根相对路径（只查带 / 且以常见扩展名结尾的）
    for (const m of line.matchAll(/`((?:product1|product2|product3|docs|\.github|tools)\/[^`\s]+)`/g)) {
      const p = m[1].replace(/[.,;:)]+$/, "");
      if (/[*<>{}]/.test(p) || p.includes(" → ")) continue; // 过滤通配/占位写法
      if (isPiDoc(p)) continue; // pi 自身文档，不在本仓库
      const norm = normalize(p);
      // CI 视角：被 gitignore 匹配的路径（.secrets.json / .env / dist / tunnel.log）是有意引用的本地文件
      if (existsOnCi(norm) || isIgnored(norm)) continue;
      problems.push(`${rel}:${lineNo} 路径不存在 → ${p}`);
    }
  });
}

if (problems.length) {
  console.error(`✖ 文档引用校验失败（${problems.length} 处）：`);
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}

console.log(`✔ 文档引用校验通过（CI 视角：${files.filter((f) => tracked.has(f.slice(ROOT.length + 1).replaceAll("\\", "/"))).length} 个已入库 markdown，0 断链）`);
