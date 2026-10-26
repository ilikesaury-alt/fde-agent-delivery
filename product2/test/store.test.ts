import { assert, assertEqual, describe, it } from "./harness.ts";
import { createMemoryStore, createD1Store, type D1Like } from "../lib/store.ts";
import { checkAccessToken } from "../lib/auth.ts";
import type { GenerationJob } from "../lib/types.ts";

function job(over: Partial<GenerationJob> = {}): GenerationJob {
  return {
    id: "j1",
    createdAt: 1000,
    sourceType: "text",
    sourceUrl: null,
    sourceExcerpt: "摘要",
    sourceText: "素材全文",
    materialBrief: null,
    note: { titles: ["t"], body: "b".repeat(30), tags: ["a"] },
    status: "succeeded",
    error: null,
    ...over,
  };
}

describe("store — 内存实现（单测/shim 用）", () => {
  it("插入后可按 id 取回", async () => {
    const s = createMemoryStore();
    await s.insert(job());
    const got = await s.get("j1");
    assertEqual(got?.id, "j1");
    assertEqual(got?.note?.titles, ["t"]);
  });

  it("列表按时间倒序", async () => {
    const s = createMemoryStore();
    await s.insert(job({ id: "a", createdAt: 100 }));
    await s.insert(job({ id: "b", createdAt: 300 }));
    await s.insert(job({ id: "c", createdAt: 200 }));
    const list = await s.list();
    assertEqual(list.map((j) => j.id), ["b", "c", "a"]);
  });

  it("list 返回副本且不含原文（省流量口径）", async () => {
    const s = createMemoryStore();
    await s.insert(job());
    const list = await s.list();
    assert(!("sourceText" in list[0]), "列表项不应含原文");
    assert(!("materialBrief" in list[0]), "列表项不应含压缩要点");
    list[0].sourceExcerpt = "被改了";
    const again = await s.get("j1");
    assertEqual(again?.sourceExcerpt, "摘要", "外部修改不应污染存储");
  });

  it("删除存在项返回 true，重复删除返回 false", async () => {
    const s = createMemoryStore();
    await s.insert(job());
    assertEqual(await s.remove("j1"), true);
    assertEqual(await s.remove("j1"), false);
    assertEqual(await s.get("j1"), null);
  });
});

describe("store — D1 实现（SQL 契约）", () => {
  /** 记录所有 SQL，用于核对语法与参数绑定是否合理 */
  function fakeD1(rows: Record<string, unknown>[] = []) {
    const log: Array<{ sql: string; args: unknown[] }> = [];
    const db: D1Like = {
      prepare(sql: string) {
        let args: unknown[] = [];
        const stmt = {
          bind(...a: unknown[]) {
            args = a;
            return stmt;
          },
          async all<T>() {
            log.push({ sql, args });
            return { results: rows as T[] };
          },
          async first<T>() {
            log.push({ sql, args });
            return (rows[0] as T) ?? null;
          },
          async run() {
            log.push({ sql, args });
            return { success: true };
          },
        };
        return stmt;
      },
    };
    return { db, log };
  }

  it("insert 绑定 10 个参数且 SQL 指向 jobs 表", async () => {
    const { db, log } = fakeD1();
    const s = createD1Store(db);
    await s.insert(job());
    assertEqual(log.length, 1);
    assert(log[0].sql.includes("INSERT INTO jobs"), "SQL 应插入 jobs");
    assertEqual(log[0].args.length, 10, "参数个数应为 10");
    assertEqual(log[0].args[0], "j1");
    assertEqual(log[0].args[8], "succeeded");
    assert(typeof log[0].args[7] === "string", "note 应序列化为 JSON 字符串");
  });

  it("list 使用倒序 + LIMIT", async () => {
    const { db, log } = fakeD1([
      {
        id: "a",
        created_at: 1,
        source_type: "url",
        source_url: "https://x",
        source_excerpt: "e",
        source_text: "t",
        material_brief: null,
        note_json: '{"titles":["x"],"body":"y","tags":[]}',
        status: "succeeded",
        error: null,
      },
    ]);
    const s = createD1Store(db);
    const list = await s.list(10);
    assert(log[0].sql.includes("ORDER BY created_at DESC"), "应倒序");
    assertEqual(log[0].args, [10]);
    assertEqual(list[0].sourceType, "url");
    assertEqual(list[0].note?.titles, ["x"], "note_json 应被解析");
  });

  it("note_json 损坏时不崩溃、返回 null", async () => {
    const { db } = fakeD1([
      {
        id: "a",
        created_at: 1,
        source_type: "text",
        source_url: null,
        source_excerpt: "e",
        source_text: "t",
        material_brief: null,
        note_json: "{坏 JSON",
        status: "failed",
        error: "boom",
      },
    ]);
    const s = createD1Store(db);
    const list = await s.list();
    assertEqual(list[0].note, null);
    assertEqual(list[0].status, "failed");
  });

  it("remove 用单条 DELETE ... RETURNING，不存在时返回 false", async () => {
    const { db, log } = fakeD1([]);
    const s = createD1Store(db);
    assertEqual(await s.remove("nope"), false);
    assertEqual(log.length, 1, "应只有一次 round-trip（不再先查后删）");
    assert(log[0].sql.includes("RETURNING id"), "应用 RETURNING 判定是否真的删到");
  });

  it("remove 删到行时返回 true", async () => {
    const { db } = fakeD1([{ id: "j1" }]);
    const s = createD1Store(db);
    assertEqual(await s.remove("j1"), true);
  });
});

describe("auth.checkAccessToken", () => {
  it("未配置令牌时放行", () => {
    assert(checkAccessToken(undefined, undefined));
  });
  it("配置后缺失头拒绝", () => {
    assert(!checkAccessToken("secret", undefined));
  });
  it("错误令牌拒绝", () => {
    assert(!checkAccessToken("secret", "Bearer wrong"));
  });
  it("正确令牌放行", () => {
    assert(checkAccessToken("secret", "Bearer secret"));
  });
  it("大小写不敏感的前缀", () => {
    assert(checkAccessToken("secret", "bearer secret"));
  });
  it("非 Bearer 方案拒绝", () => {
    assert(!checkAccessToken("secret", "Basic secret"));
  });
  it("长度不同立即拒绝（不做部分匹配）", () => {
    assert(!checkAccessToken("secret", "Bearer secre"));
  });
});
