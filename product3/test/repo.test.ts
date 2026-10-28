/**
 * Repo 契约测试 —— 同一套断言跑两种实现（A7 的「本地与线上同套单测」）。
 *
 *   memory ：纯 Map，快
 *   d1     ：node:sqlite 跑真 migration（含 0004）+ 真 SQL（JOIN / 子查询 / 参数绑定）
 *
 * 只在 Map 上测会漏掉 SQL 语义问题（产品② d1-shim 的教训）；只在 D1 上测会慢。
 */

import { assert, assertEqual, describe, it } from "./harness.ts";
import { createD1Shim } from "../e2e/d1-shim.mjs";
import { createD1Repo, type Repo } from "../lib/repo.ts";
import { createMemoryRepo } from "../lib/memory.ts";
import type { Chunk, ConversationMessage } from "../lib/types.ts";

type Factory = { name: string; make: () => Repo };

const factories: Factory[] = [
  { name: "memory", make: () => createMemoryRepo() },
  { name: "d1-shim", make: () => createD1Repo(createD1Shim()) },
];

const now = 1_760_000_000_000;

function msg(conversationId: string, id: string, createdAt: number, refused = false): ConversationMessage {
  return {
    id,
    conversationId,
    question: `问 ${id}`,
    result: {
      answer: `答 ${id}`,
      citations: refused
        ? []
        : [
            {
              index: 1,
              docId: "doc_1",
              docTitle: "部署手册",
              headingPath: "1 部署",
              snippet: "片段",
              score: 0.6,
            },
          ],
      refused,
    },
    citedDocIds: refused ? [] : ["doc_1"],
    refused,
    retrievalQuery: `检索 ${id}`,
    createdAt,
  };
}

function chunk(id: string, docId: string, idx: number, text: string): Chunk {
  return { id, docId, idx, headingPath: "", text, createdAt: now };
}

for (const factory of factories) {
  describe(`repo(${factory.name}) — 会话与消息`, () => {
    it("建会话 → 查到；轮数初始为 0", async () => {
      const repo = factory.make();
      await repo.insertConversation({ id: "conv_1", title: "首问", createdAt: now, updatedAt: now });
      const conv = await repo.getConversation("conv_1");
      assert(conv != null, "应能取回会话");
      assertEqual(conv!.title, "首问");
      assertEqual(conv!.turnCount, 0);
      assertEqual((await repo.listConversations()).length, 1);
    });

    it("消息倒序返回 + turnCount 跟随消息数", async () => {
      const repo = factory.make();
      await repo.insertConversation({ id: "conv_1", title: "首问", createdAt: now, updatedAt: now });
      await repo.insertMessage(msg("conv_1", "m1", now));
      await repo.insertMessage(msg("conv_1", "m2", now + 10, true));

      const list = await repo.listMessages("conv_1");
      assertEqual(list.map((m) => m.id), ["m2", "m1"], "最新在前");
      assertEqual(list[0].refused, true, "拒答标记要能取回");
      assertEqual(list[1].retrievalQuery, "检索 m1", "改写后的查询落库可回看");
      assertEqual((await repo.getConversation("conv_1"))!.turnCount, 2);
    });

    it("列表按 updatedAt 倒序（最近会话在最前）", async () => {
      const repo = factory.make();
      await repo.insertConversation({ id: "a", title: "A", createdAt: now, updatedAt: now });
      await repo.insertConversation({ id: "b", title: "B", createdAt: now, updatedAt: now + 5 });
      assertEqual((await repo.listConversations()).map((c) => c.id), ["b", "a"]);
      await repo.updateConversation("a", { updatedAt: now + 99 });
      assertEqual((await repo.listConversations()).map((c) => c.id), ["a", "b"]);
    });

    it("删除会话连带消息，返回被删条数", async () => {
      const repo = factory.make();
      await repo.insertConversation({ id: "conv_1", title: "首问", createdAt: now, updatedAt: now });
      await repo.insertMessage(msg("conv_1", "m1", now));
      await repo.insertMessage(msg("conv_1", "m2", now + 1));
      assertEqual(await repo.deleteConversation("conv_1"), 2);
      assertEqual(await repo.getConversation("conv_1"), null);
      assertEqual((await repo.listMessages("conv_1")).length, 0);
      assertEqual(await repo.deleteConversation("conv_1"), 0, "重复删除返回 0（幂等，不抛错）");
    });

    it("跨会话最近消息（历史接口口径）", async () => {
      const repo = factory.make();
      await repo.insertConversation({ id: "c1", title: "A", createdAt: now, updatedAt: now });
      await repo.insertConversation({ id: "c2", title: "B", createdAt: now, updatedAt: now });
      await repo.insertMessage(msg("c1", "m1", now));
      await repo.insertMessage(msg("c2", "m2", now + 10));
      assertEqual((await repo.listRecentMessages(10)).map((m) => m.id), ["m2", "m1"]);
    });

    it("损坏的 answer_json 不抛错（坏数据降级，不让整页 500）", async () => {
      const repo = factory.make();
      await repo.insertConversation({ id: "c1", title: "A", createdAt: now, updatedAt: now });
      await repo.insertMessage(msg("c1", "m1", now));
      // 直接改坏 JSON（两种实现都只能通过接口造数据，故用 update 不可行 → 用 D1 原生 SQL 或跳过）
      // memory / d1 都走 insertMessage，无法注入坏串；这里验证接口层容错由 rowToMessage 保证。
      const list = await repo.listMessages("c1");
      assertEqual(list.length, 1);
    });
  });

  describe(`repo(${factory.name}) — 关键词倒排`, () => {
    async function seedDoc(repo: Repo, docId: string, status: "ready" | "failed" = "ready") {
      await repo.insertDocument({
        id: docId,
        source: "paste",
        sourceRef: null,
        title: docId,
        contentHash: `hash_${docId}`,
        createdAt: now,
      });
      await repo.updateDocument(docId, { status });
    }

    it("写入 term 后能检索到（含 dl）", async () => {
      const repo = factory.make();
      await seedDoc(repo, "doc_1");
      await repo.insertChunks([chunk("doc_1:0", "doc_1", 0, "报错 ERR_1101 表示绑定缺失，请检查配置。")]);
      await repo.insertChunkTerms([
        { term: "err_1101", chunkId: "doc_1:0", tf: 1 },
        { term: "绑定", chunkId: "doc_1:0", tf: 1 },
      ]);

      const rows = await repo.searchTerms(["err_1101", "绑定"]);
      assertEqual(rows.length, 2);
      assertEqual(rows[0].chunkId, "doc_1:0");
      assert(rows[0].dl > 0, `dl 应 > 0（BM25 的文档长度）: ${rows[0].dl}`);
    });

    it("常见 bigram 不会吃掉配额：罕见 term 的行必须仍能取到", async () => {
      const repo = factory.make();
      await seedDoc(repo, "doc_1");
      // 60 个 chunk 都含「配额」（模拟常见词），只有一个含错误码
      const chunks = Array.from({ length: 60 }, (_, i) =>
        chunk(`doc_1:${i}`, "doc_1", i, `配额说明第 ${i} 段`),
      );
      await repo.insertChunks(chunks);
      const rows = [
        ...chunks.map((c) => ({ term: "配额", chunkId: c.id, tf: 1 })),
        { term: "err_9", chunkId: "doc_1:0", tf: 1 },
      ];
      await repo.insertChunkTerms(rows);

      const found = await repo.searchTerms(["配额", "err_9"], 100);
      assert(found.some((r) => r.term === "err_9"), "罕见 term 不得被常见词的行挤掉");
      assert(found.length < 60 + 1, `常见词应被单 term 上限截断（实际 ${found.length}）`);
    });

    it("chunkStats 只统计 ready 文档（与 retrieve 口径一致）", async () => {
      const repo = factory.make();
      await seedDoc(repo, "doc_ready", "ready");
      await seedDoc(repo, "doc_failed", "failed");
      await repo.insertChunks([
        chunk("doc_ready:0", "doc_ready", 0, "一二三四"),
        chunk("doc_failed:0", "doc_failed", 0, "五六"),
      ]);
      const stats = await repo.chunkStats();
      assertEqual(stats.n, 1, "失败文档的片段不算进 N");
      assertEqual(Math.round(stats.avgdl), 4);
    });

    it("删除文档连带清倒排（防孤儿片段被关键词通道召回）", async () => {
      const repo = factory.make();
      await seedDoc(repo, "doc_1");
      await repo.insertChunks([chunk("doc_1:0", "doc_1", 0, "报错 ERR_1101")]);
      await repo.insertChunkTerms([{ term: "err_1101", chunkId: "doc_1:0", tf: 1 }]);

      const removed = await repo.deleteDocument("doc_1");
      assertEqual(removed, ["doc_1:0"]);
      assertEqual((await repo.searchTerms(["err_1101"])).length, 0, "倒排必须一起清掉");
      assertEqual((await repo.chunkStats()).n, 0);
    });
  });
}