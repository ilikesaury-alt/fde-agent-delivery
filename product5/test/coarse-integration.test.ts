/**
 * 方案 D 集成测试：批量粗筛 + 逐条精排（省 LLM 调用）
 *
 * 核心承诺：**N 条待评的调用次数，从 N 次降到 ceil(N/10) + K 次**（K = 精排上限）。
 * 这个测试直接数 LLM 调用次数 —— 数字对不上就是回归。
 */
import { assert, assertEqual, describe, it } from "./harness.ts";
import { claimAndScore } from "../lib/queue.ts";
import { createMemoryStore } from "../lib/store.ts";
import type { RawItem } from "../lib/types.ts";

const item = (over: Partial<RawItem> = {}): RawItem => ({
  id: over.id ?? "i1",
  sourceId: over.sourceId ?? "hn",
  title: over.title ?? "OpenAI 发布新一代推理模型，支持更长上下文与工具调用",
  link: over.link ?? "https://a.com/1",
  publishedAt: over.publishedAt ?? "2026-11-03T00:00:00.000Z",
  summary: over.summary ?? "官方博客介绍了新模型的推理能力与基准表现，附有对比数据与评测结果。",
});

const llmEnv = { MAGPIE_BASE_URL: "https://mock/v1", MAGPIE_API_KEY: "k", MAGPIE_MODEL: "m" };

/**
 * 假网关：按请求体区分「粗筛调用」与「精排调用」，分别计数。
 * 粗筛请求的 user 消息里有 `[1]` `[2]` 编号列表；精排是单条。
 */
function countingGateway() {
  const stats = { coarse: 0, final: 0, coarseItems: 0 };
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const user = String(body.messages?.[1]?.content ?? "");
    const numbered = (user.match(/^\[\d+\]/gm) ?? []).length;
    if (numbered > 0) {
      stats.coarse++;
      stats.coarseItems += numbered;
      const arr = Array.from({ length: numbered }, (_, i) => ({ id: i + 1, score: 9 - (i % 3) }));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(arr) } }] }),
        { headers: { "content-type": "application/json" } },
      );
    }
    stats.final++;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: '{"relevance":8,"novelty":7,"usefulness":8,"authority":9,"reason":"重要发布"}',
            },
          },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, stats };
}

describe("方案 D · 批量粗筛 + 逐条精排", () => {
  it("30 条待评 → 粗筛 3 次 + 精排 20 次 = 23 次调用（而非 30 次）", async () => {
    const store = createMemoryStore();
    await store.saveItems(
      Array.from({ length: 30 }, (_, i) =>
        item({ link: `https://a.com/${i}`, title: `OpenAI 发布新模型 ${i} 支持更长上下文与工具调用` }),
      ),
    );
    const { fetchImpl, stats } = countingGateway();

    const result = await claimAndScore({
      store,
      env: llmEnv,
      fetchImpl,
      limit: 200,
      model: "m",
      promptVersion: "test",
      llmCallBudget: 33,
      maxFinal: 20,
    });

    assertEqual(stats.coarse, 3, "30 条应分 3 批粗筛（10/批）");
    assertEqual(stats.coarseItems, 30, "粗筛应覆盖全部 30 条");
    assertEqual(stats.final, 20, "逐条精排应只做 20 条（maxFinal）");
    assertEqual(result.coarseCalls, 3);
    assertEqual(result.coarseScored, 30);
    assertEqual(result.scored, 20, "只有精排的 20 条产出最终分数");
  });

  it("精排的分数来自逐条 prompt（阈值语义不变）—— 粗分不写进 scores", async () => {
    const store = createMemoryStore();
    await store.saveItems(
      Array.from({ length: 12 }, (_, i) => item({ link: `https://a.com/x${i}` })),
    );
    const { fetchImpl, stats } = countingGateway();

    await claimAndScore({
      store,
      env: llmEnv,
      fetchImpl,
      limit: 200,
      model: "m",
      promptVersion: "test",
      llmCallBudget: 33,
      maxFinal: 5,
    });

    // 精排调用返回的是四维 JSON（score-v1 形状），不是粗筛的 {id,score}
    assert(stats.final > 0, "应有逐条精排调用");
  });

  it("粗分落库 → 第二次调用跳过粗筛（一次算、多次用）", async () => {
    const store = createMemoryStore();
    await store.saveItems(
      Array.from({ length: 30 }, (_, i) =>
        item({ link: `https://a.com/y${i}`, title: `OpenAI 发布新模型 ${i} 支持更长上下文与工具调用` }),
      ),
    );
    const first = countingGateway();
    const r1 = await claimAndScore({
      store,
      env: llmEnv,
      fetchImpl: first.fetchImpl,
      limit: 200,
      model: "m",
      promptVersion: "test",
      llmCallBudget: 33,
      maxFinal: 20,
    });
    assertEqual(first.stats.coarse, 3);
    assertEqual(r1.scored, 20);

    // 第二次：队列里剩下 10 条（已粗分）→ 不应再有粗筛调用
    const second = countingGateway();
    const r2 = await claimAndScore({
      store,
      env: llmEnv,
      fetchImpl: second.fetchImpl,
      limit: 200,
      model: "m",
      promptVersion: "test",
      llmCallBudget: 33,
      maxFinal: 20,
    });
    assertEqual(second.stats.coarse, 0, "已有粗分的条目不应再粗筛");
    assertEqual(second.stats.final, 10, "剩下的 10 条应直接精排");
    assertEqual(r2.scored, 10);
    assertEqual(r2.coarseCalls, 0);
  });

  it("预算不够时粗筛只做预算内的部分（不硬打）", async () => {
    const store = createMemoryStore();
    await store.saveItems(
      Array.from({ length: 100 }, (_, i) =>
        item({ link: `https://a.com/z${i}`, title: `OpenAI 发布新模型 ${i} 支持更长上下文与工具调用` }),
      ),
    );
    const { fetchImpl, stats } = countingGateway();

    const result = await claimAndScore({
      store,
      env: llmEnv,
      fetchImpl,
      limit: 200,
      model: "m",
      promptVersion: "test",
      // 预算 13 次：粗筛最多 13-13... maxFinal 默认 20 → 粗筛预算 = max(0, 13-20) = 0
      llmCallBudget: 13,
      maxFinal: 20,
    });

    assert(stats.coarse <= 1, `粗筛次数应受预算约束，实际 ${stats.coarse}`);
    assertEqual(result.scored, 20, "精排条数不受粗筛预算影响");
  });

  it("条目数不超过精排上限时：**跳过粗筛**（稳态下这才是对的）", async () => {
    const store = createMemoryStore();
    await store.saveItems(
      Array.from({ length: 3 }, (_, i) =>
        item({ link: `https://a.com/s${i}`, title: `OpenAI 发布新模型 ${i} 支持更长上下文与工具调用` }),
      ),
    );
    const { fetchImpl, stats } = countingGateway();

    await claimAndScore({
      store,
      env: llmEnv,
      fetchImpl,
      limit: 200,
      model: "m",
      promptVersion: "test",
      llmCallBudget: 33,
      maxFinal: 20,
    });

    // 3 ≤ maxFinal(20) → 直接逐条精排，不粗筛
    // （粗筛要先花 1 次再精排 3 次 = 4 次，反而多）
    assertEqual(stats.coarse, 0, "条目数少时不该粗筛（纯浪费一次调用）");
    assertEqual(stats.final, 3, "3 条全部逐条精排");
  });

  it("条目数超过精排上限时才粗筛（堆积场景）", async () => {
    const store = createMemoryStore();
    await store.saveItems(
      Array.from({ length: 25 }, (_, i) =>
        item({ link: `https://a.com/t${i}`, title: `OpenAI 发布新模型 ${i} 支持更长上下文与工具调用` }),
      ),
    );
    const { fetchImpl, stats } = countingGateway();

    await claimAndScore({
      store,
      env: llmEnv,
      fetchImpl,
      limit: 200,
      model: "m",
      promptVersion: "test",
      llmCallBudget: 33,
      maxFinal: 20,
    });

    assertEqual(stats.coarse, 3, "25 条应分 3 批粗筛");
    assertEqual(stats.final, 20, "只精排 top 20");
    assertEqual(stats.coarse + stats.final, 23, "总调用 23 次 < 逐条评 25 次");
  });

  it("重复条目连粗筛都不做（去重在粗筛之前）", async () => {
    const store = createMemoryStore();
    // 25 条（超过 maxFinal=20 → 会触发粗筛），其中 2 条标题完全相同 → 去重合并成 1 条
    const items = Array.from({ length: 23 }, (_, i) =>
      item({ link: `https://a.com/d${i}`, title: `OpenAI 发布新模型 ${i} 支持更长上下文与工具调用` }),
    );
    items.push(item({ link: "https://a.com/dup1", title: "Scaling Git at OpenAI" }));
    items.push(item({ link: "https://a.com/dup2", title: "Scaling Git at OpenAI" }));
    await store.saveItems(items);

    const { fetchImpl, stats } = countingGateway();

    const result = await claimAndScore({
      store,
      env: llmEnv,
      fetchImpl,
      limit: 200,
      model: "m",
      promptVersion: "test",
      llmCallBudget: 33,
      maxFinal: 20,
    });

    assertEqual(result.duplicated, 1, "重复条目应被识别");
    // 25 条 → 去重后 24 条 → 粗筛 24 条（不是 25 条）
    assertEqual(stats.coarseItems, 24, "重复条目不应占用粗筛名额");
  });
});
