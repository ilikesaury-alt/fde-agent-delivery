/**
 * 轻量测试执行器（进程内运行）
 * 运行：node --experimental-strip-types test/run.ts
 */

import { cases as digestCases } from "./digest.test.ts";
import { cases as markdownCases } from "./markdown.test.ts";

const allCases = [...digestCases, ...markdownCases];

let pass = 0;
let fail = 0;
const failures: string[] = [];

for (const c of allCases) {
  try {
    await c.fn();
    pass++;
    console.log(`  ✔ ${c.name}`);
  } catch (e) {
    fail++;
    const msg = e instanceof Error ? `${e.message}` : String(e);
    failures.push(`${c.name}\n      ${msg.split("\n").join("\n      ")}`);
    console.log(`  ✖ ${c.name}`);
  }
}

console.log(`\n结果: pass=${pass} fail=${fail}`);
if (failures.length) {
  console.log("\n失败详情:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
