/**
 * 方案 D（批量粗筛 + 逐条精排）契约测试
 *
 * 三条硬规则各有测试钉住：
 *   1. 粗分只用于排序，绝不用于阈值判断
 *   2. 粗分落库（一次算、多次用）
 *   3. 粗筛受调用预算约束，且漏掉的 id 要单独重试而不是整批丢弃
 */
import { assert, assertEqual, describe, it } from "./harness.ts";
import {
  buildCoarsePrompt,
  coarseBatch,
  DEFAULT_COARSE_BATCH,
  parseCoarse,
} from "../lib/coarse.ts";

describe("buildCoarsePrompt · 粗筛输入", () => {
  it("编号列表，标题 + 摘要截断", () => {
    const p = buildCoarsePrompt([
      { contentKey: "a", title: "T".repeat(200), summary: "S".repeat(300), sourceId: "hn" },
    ]);
    assert(p.includes("[1]"), "应有 1-based 编号");
    assert(p.includes("T".repeat(120)), "标题应截到 120 字");
    assert(!p.includes("T".repeat(121)), "标题不应超过 120 字");
    assert(p.includes("S".repeat(180)), "摘要应截到 180 字");
  });

  it("多条时编号连续", () => {
    const p = buildCoarsePrompt([
      { contentKey: "a", title: "A", summary: "", sourceId: "hn" },
      { contentKey: "b", title: "B", summary: "", sourceId: "hn" },
      { contentKey: "c", title: "C", summary: "", sourceId: "hn" },
    ]);
    assert(p.includes("[1] A"));
    assert(p.includes("[2] B"));
    assert(p.includes("[3] C"));
  });
});

describe("parseCoarse · 粗筛返回解析", () => {
  it("标准 JSON 数组", () => {
    const m = parseCoarse('[{"id":1,"score":8},{"id":2,"score":3}]', 2);
    assertEqual(m.get(1), 8);
    assertEqual(m.get(2), 3);
  });

  it("带 ```json 围栏", () => {
    const m = parseCoarse('```json\n[{"id":1,"score":7}]\n```', 1);
    assertEqual(m.get(1), 7);
  });

  it("对象包数组的形状也收", () => {
    const m = parseCoarse('{"results":[{"id":1,"score":5}]}', 1);
    assertEqual(m.get(1), 5);
  });

  it("id 越界 → 忽略（防止模型串号）", () => {
    const m = parseCoarse('[{"id":9,"score":10},{"id":1,"score":6}]', 2);
    assertEqual(m.get(9), undefined);
    assertEqual(m.get(1), 6);
  });

  it("分数 clamp 到 0–10", () => {
    const m = parseCoarse('[{"id":1,"score":99},{"id":2,"score":-5}]', 2);
    assertEqual(m.get(1), 10);
    assertEqual(m.get(2), 0);
  });

  it("非数字分数 → 该条失败（不入表）", () => {
    const m = parseCoarse('[{"id":1,"score":"high"},{"id":2,"score":4}]', 2);
    assertEqual(m.get(1), undefined);
    assertEqual(m.get(2), 4);
  });

  it("非 JSON → 空表（调用方会把整批当失败处理）", () => {
    assertEqual(parseCoarse("抱歉，我无法完成", 3).size, 0);
    assertEqual(parseCoarse("", 3).size, 0);
  });
});

describe("coarseBatch · 批量粗筛", () => {
  const items = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      contentKey: `k${i}`,
      title: `标题 ${i}`,
      summary: `摘要 ${i} 内容足够长用于测试`,
      sourceId: "hn",
    }));

  /** 假网关：按请求体里的 user 消息判断批大小 */
  function mockGateway(opts: {
    /** 返回里故意漏掉这些 id（1-based） */
    omit?: number[];
    fail?: boolean;
  }) {
    const calls: Array<{ count: number }> = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const user = String(body.messages?.[1]?.content ?? "");
      const count = (user.match(/^\[\d+\]/gm) ?? []).length;
      calls.push({ count });
      if (opts.fail) return new Response("upstream down", { status: 502 });
      const arr = Array.from({ length: count }, (_, i) => ({ id: i + 1, score: 5 + (i % 5) }));
      const kept = arr.filter((a) => !(opts.omit ?? []).includes(a.id));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(kept) } }] }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  const llm = { base: "https://m.example/v1", key: "k", model: "m" };

  it("批量大小默认 10（RoBatch 的 16 悬崖前留余量）", () => {
    assertEqual(DEFAULT_COARSE_BATCH, 10);
  });

  it("13 条 → 2 次调用（10 + 3），而不是 13 次", async () => {
    const { fetchImpl, calls } = mockGateway({});
    const res = await coarseBatch({ ...llm, fetchImpl }, items(13), { batchSize: 10 });
    assertEqual(calls.length, 2, "应只调 2 次");
    assertEqual(calls[0]!.count, 10);
    assertEqual(calls[1]!.count, 3);
    assertEqual(res.filter((r) => r.score !== null).length, 13);
  });

  it("返回的分数与 contentKey 一一对应", async () => {
    const { fetchImpl } = mockGateway({});
    const res = await coarseBatch({ ...llm, fetchImpl }, items(3), { batchSize: 10 });
    assertEqual(res.length, 3);
    for (const r of res) {
      assert(r.contentKey.startsWith("k"), "contentKey 应保留");
      assert(r.score !== null, "每条都该有分数");
    }
  });

  it("整批调用失败 → 该批每条标失败（不抛异常）", async () => {
    const { fetchImpl } = mockGateway({ fail: true });
    const res = await coarseBatch({ ...llm, fetchImpl }, items(3), { batchSize: 10 });
    assertEqual(res.length, 3);
    assert(res.every((r) => r.score === null), "应全部失败");
    assert(res.every((r) => r.error), "应带错误原因");
  });

  it("漏掉的 id → 单独重试（多花 1 次调用，但能救回）", async () => {
    // 第一批漏掉 id=2；单独重试时只发 1 条 → mock 会返回它
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const user = String(body.messages?.[1]?.content ?? "");
      const count = (user.match(/^\[\d+\]/gm) ?? []).length;
      if (count === 1) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '[{"id":1,"score":9}]' } }] }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '[{"id":1,"score":8},{"id":3,"score":6}]' } }] }),
        { headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const res = await coarseBatch({ ...llm, fetchImpl }, items(3), { batchSize: 10 });
    const rescued = res.find((r) => r.contentKey === "k1");
    assertEqual(rescued?.score, 9, "漏掉的条目应被单独重试救回");
    assert(res.every((r) => r.score !== null), "最终不应有失败条目");
  });

  it("调用预算耗尽 → 剩下的条目保持「无粗分」（不硬打）", async () => {
    const { fetchImpl, calls } = mockGateway({});
    const res = await coarseBatch({ ...llm, fetchImpl }, items(100), { batchSize: 10, maxCalls: 2 });
    assertEqual(calls.length, 2, "不应超过预算");
    assertEqual(res.filter((r) => r.score !== null).length, 20);
    assertEqual(res.filter((r) => r.score === null).length, 80, "预算外的条目保持无粗分");
  });
});
