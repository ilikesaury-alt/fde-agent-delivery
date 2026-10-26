/**
 * D1 替身：用 Node 内置 node:sqlite 实现 D1Database 的最小 API 子集。
 *
 * 为什么这么做：D1 在本地沙箱起不来（workerd 不可 spawn），
 * 但只在 shim 里用内存 Map 造假，就测不到 createD1Store 的真实 SQL
 * （ORDER BY / LIMIT / 参数绑定 / JSON 列都会漏测）。
 * 用真 SQLite 跑同一份 migration + 同一份 SQL，本地就能验证到 SQL 语义层面。
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));

export function createD1Shim(dbPath = ":memory:") {
  const database = new DatabaseSync(dbPath);

  // 启动即应用 migration（等价于 wrangler d1 migrations apply）
  const migrationDir = join(root, "db", "migrations");
  for (const file of readdirSync(migrationDir).filter((f) => f.endsWith(".sql")).sort()) {
    database.exec(readFileSync(join(migrationDir, file), "utf8"));
  }

  function makeStmt(sql, args = []) {
    return {
      bind(...values) {
        return makeStmt(sql, values);
      },
      async all() {
        const stmt = database.prepare(sql);
        const rows = stmt.all(...args.map(norm));
        return { results: rows, success: true };
      },
      async first() {
        const stmt = database.prepare(sql);
        const row = stmt.get(...args.map(norm));
        return row ?? null;
      },
      async run() {
        const stmt = database.prepare(sql);
        const info = stmt.run(...args.map(norm));
        return { success: true, meta: { changes: info.changes } };
      },
    };
  }

  return {
    prepare(sql) {
      return makeStmt(sql, []);
    },
    /** 供 shim 调试/校验用 */
    __database: database,
  };
}

/** node:sqlite 不接受 undefined，统一转 null */
function norm(v) {
  return v === undefined ? null : v;
}
