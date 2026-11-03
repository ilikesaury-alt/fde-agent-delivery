/**
 * 去重契约测试：L1（归一化 + Jaccard）+ L2（SimHash）+ 数字签名硬闸
 *
 * 用例全部来自 2026-11-03 的**真实数据标定**（scripts/calibrate-dedup.ts，
 * 280 条 / 11 源），不是构造出来的理想样本 —— 尤其是「不同版本公告」
 * 那组假阳性，它们是这套阈值存在的唯一理由。
 */
import { assert, assertEqual, describe, it } from "./harness.ts";
import {
  clusterBySimilarity,
  DEFAULT_HAMMING_THRESHOLD,
  DEFAULT_JACCARD_THRESHOLD,
  duplicateReason,
  findCrossBatchDuplicate,
  fingerprintOf,
  hamming64,
  jaccard,
  normalizeTitle,
  numberSignature,
  simhash,
  tokenize,
} from "../lib/dedup.ts";

describe("normalizeTitle · 归一化", () => {
  it("小写 + 标点转空格 + 压缩空白", () => {
    assertEqual(normalizeTitle("GPT-6.1  Terra!!!"), "gpt 6 1 terra");
    assertEqual(normalizeTitle("NVIDIA——Releases  Auto Ontology"), "nvidia releases auto ontology");
  });

  it("中文标点也转空格", () => {
    assertEqual(normalizeTitle("英伟达发布「黑卡」？"), "英伟达发布 黑卡");
  });

  it("小数点也转空格（版本号由数字签名单独承载，不混进 token）", () => {
    // 刻意如此：保留小数点会让 Gemini 3.8 Live 两条不同公告的
    // jaccard 从 0.50 升到 0.667，越过 0.55 阈值被误合并。
    assertEqual(normalizeTitle("Gemini 3.8 Flash"), "gemini 3 8 flash");
  });
});

describe("tokenize · 分词", () => {
  it("英文按词并去停用词", () => {
    const t = tokenize("the new model is here");
    assert(t.includes("model"));
    assert(t.includes("here"));
    assert(!t.includes("the"));
    assert(!t.includes("new"));
  });

  it("中文按字符 bigram（无词典依赖）", () => {
    const t = tokenize("英伟达发布");
    assert(t.includes("英伟"));
    assert(t.includes("伟达"));
  });

  it("中英混排两者都出", () => {
    const t = tokenize(normalizeTitle("OpenAI 发布新模型"));
    assert(t.includes("openai"), `英文词缺失：${JSON.stringify(t)}`);
    assert(t.includes("发布"), `中文 bigram 缺失：${JSON.stringify(t)}`);
  });
});

describe("numberSignature · 数字签名（版本号硬闸）", () => {
  it("从原始标题提取，保留小数点", () => {
    assertEqual(numberSignature("Gemini 3.6 Flash, 3.5 Flash-Lite"), "3.5,3.6");
    assertEqual(numberSignature("Introducing Gemini 3.8 Flash and 3.8 Flash Cyber"), "3.8");
    assertEqual(numberSignature("GPT-6.1 Terra"), "6.1");
  });

  it("无数字 → 空签名", () => {
    assertEqual(numberSignature("Scaling Git at OpenAI"), "");
  });
});

describe("jaccard · 相似度", () => {
  it("完全相同 = 1，完全不同 = 0", () => {
    assertEqual(jaccard(new Set(["a", "b"]), new Set(["a", "b"])), 1);
    assertEqual(jaccard(new Set(["a"]), new Set(["b"])), 0);
    assertEqual(jaccard(new Set(), new Set()), 0);
  });
});

describe("simhash · 指纹", () => {
  it("相同 token 集合 → 汉明距离 0", () => {
    const a = simhash(["alpha", "beta", "gamma"]);
    const b = simhash(["alpha", "beta", "gamma"]);
    assertEqual(hamming64(a, b), 0);
  });

  it("不相关的 token 集合 → 汉明距离明显大于 0", () => {
    const a = simhash(["alpha", "beta", "gamma"]);
    const b = simhash(["delta", "epsilon", "zeta"]);
    assert(hamming64(a, b) > 8);
  });

  it("词序变化影响很小（集合语义）", () => {
    const a = simhash(["scaling", "git", "openai"]);
    const b = simhash(["git", "openai", "scaling"]);
    assert(hamming64(a, b) <= 2);
  });
});

describe("duplicateReason · 判定（真实数据标定的用例）", () => {
  it("✅ 真重复：同一标题跨源转载", () => {
    const a = fingerprintOf("Scaling Git at OpenAI");
    const b = fingerprintOf("Scaling Git at OpenAI");
    const r = duplicateReason(a, b);
    assert(r !== null, "同标题应判为重复");
    assertEqual(r, "标题完全相同");
  });

  it("✅ 真重复：同事件跨源不同措辞（GPT-6.1 Terra）", () => {
    const a = fingerprintOf("Introducing GPT-6.1 Terra");
    const b = fingerprintOf("GPT-6.1 Terra");
    const r = duplicateReason(a, b);
    assert(r !== null, "GPT-6.1 Terra 跨源应判为重复");
  });

  it("❌ 假阳性防护：不同版本的 Gemini 公告**不**合并", () => {
    // 实测 jaccard 0.800 / 汉明 6 —— 没有数字闸就会被误合并
    const a = fingerprintOf("Introducing Gemini 3.8 Flash and 3.8 Flash Cyber");
    const b = fingerprintOf("Introducing Gemini 3.6 Flash, 3.5 Flash-Lite, and more");
    const r = duplicateReason(a, b);
    assertEqual(r, null, "版本号不同，必须判为不同事件");
  });

  it("❌ 假阳性防护：Gemini 3.8 Live 的两条不同公告**不**合并", () => {
    // 实测 jaccard 0.500 —— 阈值若取 0.50 就会误合并这里。
    // 断言自带前提：若以后改分词规则导致 jaccard 变化，测试会直接报出实际值。
    const a = fingerprintOf("Introducing Gemini 3.8 Live with Live Avatar");
    const b = fingerprintOf("Introducing Gemini 3.8 Live and 3.8 Live Extended Thinking");
    const j = jaccard(new Set(a.tokens), new Set(b.tokens));
    assert(
      j < DEFAULT_JACCARD_THRESHOLD,
      `前提失效：jaccard=${j.toFixed(3)} 已达/超阈值 ${DEFAULT_JACCARD_THRESHOLD}`,
    );
    assertEqual(duplicateReason(a, b), null, "同系列不同公告必须判为不同事件");
  });

  it("❌ 假阳性防护：同前缀不同话题（Quoting X / Quoting Y）不合并", () => {
    const a = fingerprintOf("Quoting Ted Sanders");
    const b = fingerprintOf("Quoting Jason Koebler");
    const r = duplicateReason(a, b);
    assertEqual(r, null, "不同引述对象不是重复");
  });

  it("❌ 假阳性防护：栏目名与正文同题（The Download）不合并", () => {
    // 实测 jaccard 0.267 —— 漏合并（多花一次 LLM 调用）可接受，误合并不可接受
    const a = fingerprintOf("The Download: GLP-1s and eating disorders, self-aware cities, and forever chemicals");
    const b = fingerprintOf("Eating disorders are on the rise. GLP-1s could make things worse.");
    const r = duplicateReason(a, b);
    assertEqual(r, null, "同话题不同写法不合并（宁可多评一次也不丢条目）");
  });

  it("❌ 数字签名不同 → 直接否（连 Jaccard 都不看）", () => {
    const a = fingerprintOf("Gemini 3.8 Flash");
    const b = fingerprintOf("Gemini 3.5 Flash");
    assertEqual(a.numbers, "3.8");
    assertEqual(b.numbers, "3.5");
    assertEqual(duplicateReason(a, b), null);
  });

  it("无数字但话题不同的两条不合并", () => {
    const a = fingerprintOf("How we detect frontier model misalignment");
    const b = fingerprintOf("Securing our frontier model training environment");
    assertEqual(duplicateReason(a, b), null);
  });
});

describe("clusterBySimilarity · 同批次聚类", () => {
  it("真重复聚成 1 簇（代表 = 标题最长的那条）", () => {
    const res = clusterBySimilarity([
      { contentKey: "a", title: "Scaling Git at OpenAI" },
      { contentKey: "b", title: "Scaling Git at OpenAI" },
    ]);
    assertEqual(res.clusters.length, 1);
    assertEqual(res.savedCount, 1);
    assertEqual(res.merged.length, 1);
  });

  it("不同版本各自成簇（不合并）", () => {
    const res = clusterBySimilarity([
      { contentKey: "a", title: "Introducing Gemini 3.8 Flash and 3.8 Flash Cyber" },
      { contentKey: "b", title: "Introducing Gemini 3.6 Flash, 3.5 Flash-Lite, and more" },
      { contentKey: "c", title: "Introducing Gemini 3.5 Flash Cyber" },
    ]);
    assertEqual(res.clusters.length, 3);
    assertEqual(res.savedCount, 0);
  });

  it("混合场景：2 个真重复 + 2 条独立 → 3 簇", () => {
    const res = clusterBySimilarity([
      { contentKey: "a", title: "Scaling Git at OpenAI" },
      { contentKey: "b", title: "Scaling Git at OpenAI" },
      { contentKey: "c", title: "Introducing GPT-6.1 Terra" },
      { contentKey: "d", title: "Quoting Ted Sanders" },
    ]);
    assertEqual(res.clusters.length, 3);
    assertEqual(res.savedCount, 1);
  });

  it("代表取簇内标题最长的条目", () => {
    const res = clusterBySimilarity([
      { contentKey: "a", title: "GPT-6.1 Terra" },
      { contentKey: "b", title: "Introducing GPT-6.1 Terra" },
    ]);
    assertEqual(res.representatives.length, 1);
    assertEqual(res.representatives[0], 1, "更长的标题应作为代表");
  });

  it("空输入不炸", () => {
    const res = clusterBySimilarity([]);
    assertEqual(res.clusters.length, 0);
    assertEqual(res.savedCount, 0);
  });
});

describe("findCrossBatchDuplicate · 跨轮次重复", () => {
  it("命中：同事件的历史条目", () => {
    const fp = fingerprintOf("Introducing GPT-6.1 Terra");
    const hit = findCrossBatchDuplicate(fp, [
      { contentKey: "old-1", title: "GPT-6.1 Terra" },
    ]);
    assert(hit !== null, "应命中历史重复");
    assertEqual(hit!.contentKey, "old-1");
  });

  it("不命中：版本号不同的历史条目", () => {
    const fp = fingerprintOf("Introducing Gemini 3.8 Flash");
    const hit = findCrossBatchDuplicate(fp, [
      { contentKey: "old-1", title: "Introducing Gemini 3.6 Flash" },
    ]);
    assertEqual(hit, null);
  });

  it("不命中：无关的历史条目", () => {
    const fp = fingerprintOf("Introducing GPT-6.1 Terra");
    const hit = findCrossBatchDuplicate(fp, [
      { contentKey: "old-1", title: "Quoting Ted Sanders" },
    ]);
    assertEqual(hit, null);
  });

  it("空历史 → 不命中", () => {
    const fp = fingerprintOf("Introducing GPT-6.1 Terra");
    assertEqual(findCrossBatchDuplicate(fp, []), null);
  });
});

describe("阈值常量", () => {
  it("Jaccard 阈值 = 0.55（真实数据扫描结论）", () => {
    assertEqual(DEFAULT_JACCARD_THRESHOLD, 0.55);
  });

  it("汉明阈值 = 6（12 就有假阳性）", () => {
    assertEqual(DEFAULT_HAMMING_THRESHOLD, 6);
  });
});
