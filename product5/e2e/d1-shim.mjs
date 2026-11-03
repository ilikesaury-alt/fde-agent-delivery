/**
 * D1 替身：用 `node:sqlite` 在纯 Node 里跑与线上同构的 SQL。
 *
 * 为什么需要它：本地 E2E 要验证「持久化去重 / 源健康历史」这些**跨请求语义**，
 * 内存 Store 测不到 SQL 本身（唯一约束、ON CONFLICT、MAX() 基线）。产品③④ 同做法。
 *
 * 只实现 store.ts 用到的 D1 子集：prepare().bind().all()/first()/run() + batch()。
 * 注意：node:sqlite 的 changes 可能是 BigInt，这里统一转 Number（D1 返回 number）。
 *
 * 为什么要有 batch()：Cloudflare 官方 limits —— D1 的**内部** subrequest 上限 1,000/次，
 * 而 `db.batch()` **整批只计 1 个 query**。扩源后一轮要写 200+ 条条目，
 * 逐条发会打满内部预算。替身必须实现同样的语义，否则本地 E2E 测不到线上走的路径。
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
            all() {
              return { results: stmt.all(...args) };
            },
            first() {
              const row = stmt.get(...args);
              return row ?? null;
            },
            run() {
              const info = stmt.run(...args);
              return { meta: { changes: Number(info.changes ?? 0) } };
            },
            /** batch 入口用：把 sql 与绑定值挂在语句对象上（对齐真实 D1 的 .bind() 语义） */
            sql,
            values: args,
          };
        },
      };
    },
    /**
     * 批量执行（Cloudflare 语义：整批计 1 个内部 subrequest；按语句顺序返回结果）。
     *
     * ⚠️ 参数形状：store.ts 传进来的是**已 bind 好的语句对象**（真实 D1 的
     *    `batch(D1PreparedStatement[])` 形状），不是 `{sql, values}`。
     *    替身靠 prepare() 挂在语句上的 `values` 取回绑定参数。
     */
    async batch(stmts) {
      const out = [];
      for (const s of stmts) {
        const args = normalize(s.values ?? []);
        const info = db.prepare(s.sql).run(...args);
        out.push({ meta: { changes: Number(info.changes ?? 0) } });
      }
      return out;
    },
    close() {
      db.close();
    },
  };
}