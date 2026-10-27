#!/usr/bin/env node
/**
 * 文档链接校验：检查仓库内所有 markdown 的相对链接是否真实存在。
 *
 * 只校验「相对文件链接」（跳过 http(s)://、mailto:、纯锚点 #xxx）。
 * 反引号里的路径是本仓库的「仓库根相对路径」约定，一并抽检存在性。
 *
 * 用法：node .github/scripts/check-doc-links.mjs
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "legacy", "research", ".pi", ".npm-cache", ".pnpm-store"]);

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

/** 逐行扫描，保持行号可用于报错 */
for (const file of files) {
  const rel = file.slice(ROOT.length + 1);
  const lines = readFileSync(file, "utf8").split(/\r?\n/);

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;

    // 1) markdown 链接：[text](target)
    for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const clean = decodeURIComponent(target.split("#")[0]);
      if (!clean) continue;
      if (!statSync(resolve(dirname(file), clean), { throwIfNoEntry: false })) {
        problems.push(`${rel}:${lineNo} 断链 → ${target}`);
      }
    }

    // 2) 反引号中的仓库根相对路径（只查带 / 且以常见扩展名结尾的）
    for (const m of line.matchAll(/`((?:product1|product2|docs|\.github|tools)\/[^`\s]+)`/g)) {
      const p = m[1].replace(/[.,;:)]+$/, "");
      if (/[*<>{}]/.test(p) || p.includes(" → ")) continue; // 过滤通配/占位写法
      if (isPiDoc(p)) continue; // pi 自身文档，不在本仓库
      if (!statSync(resolve(ROOT, p), { throwIfNoEntry: false })) {
        problems.push(`${rel}:${lineNo} 路径不存在 → ${p}`);
      }
    }
  });
}

if (problems.length) {
  console.error(`✖ 文档引用校验失败（${problems.length} 处）：`);
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}

console.log(`✔ 文档引用校验通过（${files.length} 个 markdown 文件，0 断链）`);
