/**
 * Vectorize 替身：内存 + 余弦相似度。
 *
 * 为什么不能像 D1 那样「用真的」：Vectorize 没有本地可运行版本，
 * Workers 里也只有绑定。所以本地用精确余弦复刻「近邻检索」语义，
 * 让检索阈值、拒答、引用映射这些业务逻辑在本地就能被真实测到。
 *
 * 与 test/fakes.ts 的分工：
 *   test/fakes.ts      单测用（TS，可注入错误）
 *   e2e/ai-shim.mjs    本地 E2E 用（JS，进程内常驻）
 * 两者的嵌入算法必须一致 —— 改动时同步两处。
 */

export function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function createVectorizeShim() {
  /** @type {Map<string, number[]>} */
  const vectors = new Map();

  return {
    async upsert(items) {
      if (!globalThis.__vecDbg) { globalThis.__vecDbg = true; const it = items[0]; console.log("[vec-dbg] upsert n=", items.length, "valuesType=", typeof it?.values, "isArr=", Array.isArray(it?.values), "len=", it?.values?.length, "nonzero=", Array.isArray(it?.values) ? it.values.filter(x=>x!==0).length : "n/a"); }
      for (const it of items) vectors.set(it.id, it.values);
      return { mutationId: "local" };
    },
    async query(vector, options = {}) {
      if (!globalThis.__qDbg) { globalThis.__qDbg = true; console.log("[vec-dbg] query len=", vector?.length, "nonzero=", Array.isArray(vector)?vector.filter(x=>x!==0).length:"n/a", "stored=", vectors.size); }
      const topK = options.topK ?? 10;
      const scored = [...vectors.entries()].map(([id, v]) => ({ id, score: cosine(vector, v) }));
      scored.sort((a, b) => b.score - a.score);
      return { matches: scored.slice(0, topK) };
    },
    async deleteByIds(ids) {
      for (const id of ids) vectors.delete(id);
      return { mutationId: "local" };
    },
    async getByIds(ids) {
      return ids.filter((id) => vectors.has(id)).map((id) => ({ id }));
    },
    /** 调试/校验用 */
    __size() {
      return vectors.size;
    },
  };
}
