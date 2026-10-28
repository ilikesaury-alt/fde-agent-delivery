import { assert, assertEqual, describe, it } from "./harness.ts";
import {
  CONTEXT_TURNS,
  HISTORY_ITEM_MAX,
  PREV_QUESTION_MAX,
  buildContextBlock,
  buildRetrievalQuery,
  buildTitle,
  needsContext,
} from "../lib/conversation.ts";

describe("conversation — 指代判定", () => {
  it("含指代词 → 需要上下文", () => {
    for (const q of ["它呢", "那配额呢", "这个怎么配置", "上述步骤还有吗", "那条错误码是什么意思", "还有呢"]) {
      assert(needsContext(q), `应判为依赖上文：${q}`);
    }
  });

  it("完整问句 → 不需要上下文（不该被改写）", () => {
    for (const q of ["免费额度会累积到下个月吗", "部署用什么命令，回滚怎么做", "怎么降低模型调用成本"]) {
      assert(!needsContext(q), `不该判为依赖上文：${q}`);
    }
  });

  it("短问句但无指代词 → 不改写（避免把新话题拉回旧主题，review #8）", () => {
    assert(!needsContext("回滚步骤"), "4 字新话题短问不应改写");
    assert(!needsContext("D1 报错"), "含英文/数字的短问本身自足");
    assert(!needsContext("该如何处理"), "「该」不再算指代词");
    assert(!needsContext("然后呢".slice(0, 0) || "然后怎么做"), "「然后」不再算指代词");
  });

  it("空串不触发", () => {
    assertEqual(needsContext("   "), false);
  });
});

describe("conversation — 检索查询改写", () => {
  const history = [{ question: "免费额度会累积到下个月吗", answer: "不会，每月重置。" }];

  it("无历史 → 原样返回，且标记 not rewritten", () => {
    assertEqual(buildRetrievalQuery("它呢", []), { query: "它呢", rewritten: false });
  });

  it("有历史 + 指代 → 拼接上一轮问题", () => {
    const r = buildRetrievalQuery("它呢", history);
    assertEqual(r.rewritten, true);
    assertEqual(r.query, "免费额度会累积到下个月吗 它呢");
  });

  it("有历史但问句完整 → 不改写（避免把新话题拉回旧主题）", () => {
    const r = buildRetrievalQuery("部署用什么命令", history);
    assertEqual(r, { query: "部署用什么命令", rewritten: false });
  });

  it("开关关闭 → 即使是指代也不改写（消融对比用）", () => {
    assertEqual(buildRetrievalQuery("它呢", history, false), { query: "它呢", rewritten: false });
  });

  it("上一轮问题过长 → 截断到 PREV_QUESTION_MAX", () => {
    const long = "洛".repeat(PREV_QUESTION_MAX + 50);
    const r = buildRetrievalQuery("它呢", [{ question: long }]);
    assertEqual(r.query, `${"洛".repeat(PREV_QUESTION_MAX)} 它呢`);
  });
});

describe("conversation — 会话标题", () => {
  it("取首问并压缩空白", () => {
    assertEqual(buildTitle("  部署\n要用什么命令  "), "部署 要用什么命令");
  });

  it("超长截断并加省略号", () => {
    const t = buildTitle("部".repeat(80));
    assertEqual(t.length, 61, "60 字 + 省略号");
    assert(t.endsWith("…"), "应有省略号");
  });

  it("空问句给兜底标题", () => {
    assertEqual(buildTitle("   "), "新会话");
  });
});

describe("conversation — 生成上下文块", () => {
  const history = [
    { question: "第一问", answer: "第一答" },
    { question: "第二问", answer: "第二答" },
    { question: "第三问", answer: "第三答" },
  ];

  it("只带最近 N 轮", () => {
    const block = buildContextBlock(history);
    assert(block.includes("第三问") && block.includes("第二问"), "应含最近两轮");
    assert(!block.includes("第一问"), "更早的不该进来");
    const lines = block.split("\n");
    assertEqual(lines.length, 1 + CONTEXT_TURNS * 2, "标题 1 行 + 每轮 2 行");
  });

  it("显式声明「不构成回答依据」（防跨轮幻觉继承）", () => {
    assert(buildContextBlock(history).includes("不构成回答依据"));
  });

  it("无历史 → 空串（不往 prompt 里塞空块）", () => {
    assertEqual(buildContextBlock([]), "");
  });

  it("单条过长 → 截断到 HISTORY_ITEM_MAX", () => {
    const long = "答".repeat(HISTORY_ITEM_MAX + 20);
    const block = buildContextBlock([{ question: "问", answer: long }]);
    assert(block.includes(`${"答".repeat(HISTORY_ITEM_MAX)}…`), "应截断并加省略号");
  });

  it("上一轮没作答 → 用占位而不是空行", () => {
    assert(buildContextBlock([{ question: "问", answer: "" }]).includes("（未作答）"));
  });
});