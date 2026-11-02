/**
 * D1 替身：用 `node:sqlite` 在纯 Node 里跑与线上同构的 SQL。
 *
 * 为什么需要它：本地 E2E 要验证「持久化去重 / 源健康历史」这些**跨请求语义**，
 * 内存 Store 测不到 SQL 本身（唯一约束、ON CONFLICT、MAX() 基线）。产品③④ 同做法。
 *
 * 只实现 store.ts 用到的 D1 子集：prepare().bind().all()/first()/run()。
 * 注意：node:sqlite 的 changes 可能是 BigInt，这里统一转 Number（D1 返回 number）。
 */

import { DatabaseSync } from "node:sqlite";

function normalize(values) {
  return values.map((v) => {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (v === undefined) return null;
    return v;
  });
}

export function createD1Shim(file = ":memory:") {
  const db = new DatabaseSync(file);

  return {
    /** 执行多语句 SQL（迁移文件用） */
    exec(sql) {
      db.exec(sql);
    },
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        bind(...values) {
          const args = normalize(values);
          // node:sqlite 对可变参数的稳定性差：包一层统一入口，避免 in-flight 语句互相覆盖
          return {
            async all() {
              return { results: stmt.all(...args) };
            },
            async first() {
              const row = stmt.get(...args);
              return row ?? null;
            },
            async run() {
              const info = stmt.run(...args);
              return { meta: { changes: Number(info.changes ?? 0) } };
            },
          };
        },
      };
    },
    close() {
      db.close();
    },
  };
}