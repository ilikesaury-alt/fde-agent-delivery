/**
 * 脚本：L1/L2 去重阈值标定（一次性工具，不参与线上运行）
 *
 * 用法：node --experimental-strip-types scripts/calibrate-dedup.ts
 *
 * 目的：把 14 个源的真实标题拉下来，人工核对「哪些是真重复」，
 * 再据此定 Jaccard / SimHash 阈值 —— 阈值拍脑袋会误合并（丢资讯），
 * 定太松则合并不掉（白花 LLM 调用）。
 *
 * ⚠️ 本脚本**复用 lib/dedup.ts 的实现**（不再自带一份拷贝）——
 * 两份实现漂移过一次，导致标定结论与线上行为对不上（2026-11-03 踩过）。
 */

import {
  clusterBySimilarity,
  fingerprintOf,
  hamming64,
  jaccard,
  normalizeTitle,
} from "../lib/dedup.ts";
import { fetchAllFeeds } from "../lib/rss.ts";
import { DEFAULT_SOURCES } from "../lib/sources.ts";
import type { RawItem } from "../lib/types.ts";

const results = await fetchAllFeeds(DEFAULT_SOURCES, {
  maxItems: 40,
  timeoutMs: 15000,
  concurrency: 3,
});
const items: RawItem[] = results.flatMap((r) => (r.ok ? r.items : []));

console.log(`拉取到 ${items.length} 条，来自 ${results.filter((r) => r.ok).length} 个源\n`);

const prep = items.map((it) => {
  const fp = fingerprintOf(it.title);
  return { it, fp, set: new Set(fp.tokens) };
});

// 全量两两比较，输出相似度最高的 30 对，供人工核对
const pairs: Array<{ j: number; h: number; a: RawItem; b: RawItem; sameNums: boolean }> = [];
for (let i = 0; i < prep.length; i++) {
  for (let k = i + 1; k < prep.length; k++) {
    const A = prep[i]!;
    const B = prep[k]!;
    const j = jaccard(A.set, B.set);
    const h = hamming64(A.fp.sh, B.fp.sh);
    if (j >= 0.25 || h <= 20) {
      pairs.push({ j, h, a: A.it, b: B.it, sameNums: A.fp.numbers === B.fp.numbers });
    }
  }
}
pairs.sort((x, y) => y.j - x.j || x.h - y.h);

console.log(`候选对（jaccard≥0.25 或 汉明≤20）：${pairs.length}\n`);
console.log("jaccard | hamming | 数字同 | 源A | 源B | 标题A | 标题B");
console.log("-".repeat(160));
for (const p of pairs.slice(0, 30)) {
  console.log(
    `${p.j.toFixed(3).padStart(7)} | ${String(p.h).padStart(7)} | ${p.sameNums ? " 是 " : " 否 "} | ` +
      `${p.a.sourceId.padEnd(13)} | ${p.b.sourceId.padEnd(13)} | ${p.a.title} | ${p.b.title}`,
  );
}

// 用模块自身的聚类跑一遍，看最终会合并哪些（这就是线上的真实行为）
const res = clusterBySimilarity(items.map((it) => ({ contentKey: it.link, title: it.title })));
console.log(`\n=== 模块聚类结果 ===`);
console.log(`簇数 ${res.clusters.length} · 合并掉 ${res.savedCount} 条`);
for (const c of res.clusters) {
  if (c.members.length > 1) {
    const rep = items[c.representative]!;
    console.log(`  [${c.reason}] 代表 = ${rep.sourceId} | ${rep.title}`);
    for (const m of c.members) {
      if (m !== c.representative) console.log(`      合并 ← ${items[m]!.sourceId} | ${items[m]!.title}`);
    }
  }
}

// 阈值扫描（数字签名相同的前提下）
console.log("\n阈值扫描（数字签名相同的前提下）：");
for (const th of [0.5, 0.55, 0.6, 0.65, 0.667, 0.7, 0.75, 0.8, 0.9, 1.0]) {
  const merged = pairs.filter((p) => p.sameNums && p.j >= th);
  console.log(`  jaccard ≥ ${th.toFixed(3)} → 合并 ${merged.length} 对`);
}

console.log("\n归一化示例：", JSON.stringify(normalizeTitle("Introducing Gemini 3.8 Live with Live Avatar")));
