/** 评分纯函数契约测试：预筛 / 解析校验 / 加权总分 / 精选 */
import { assert, assertEqual, describe, it } from "./harness.ts";
import {
  DEFAULT_WEIGHTS,
  parseScore,
  prefilter,
  prefilterAll,
  selectTop,
  totalOf,
} from "../lib/score.ts";

const input = (over: Partial<{ title: string; summary: string; sourceId: string; lang: string }> = {}) => ({
  title: over.title ?? "OpenAI 发布新一代推理模型，支持更长上下文",
  summary: over.summary ?? "官方博客介绍了新模型的推理能力与基准表现，附有对比数据。",
  sourceId: over.sourceId ?? "hn",
  lang: over.lang ?? "en",
});

describe("prefilter · 本地预筛（不花 LLM 调用）", () => {
  it("正常条目放行", () => {
    const v = prefilter(input());
    assert(v.keep === true);
  });

  it("标题过短 / 摘要过短 → 丢弃并给原因", () => {
    const shortTitle = prefilter(input({ title: "快讯" }));
    assert(shortTitle.keep === false);
    assertEqual(shortTitle.reason, "标题过短");

    const shortSummary = prefilter(input({ summary: "见链接" }));
    assert(shortSummary.keep === false);
    assert(shortSummary.reason.includes("摘要"));
  });

  it("模板化噪音被识别（广告 / 招聘 / 促销 / 纯转发）", () => {
    for (const title of [
      "广告：某云厂商限时活动，注册即送算力",
      "招聘：AI 算法工程师，base 上海，待遇从优",
      "RT @someone: 一条被转发的旧消息内容",
    ]) {
      const v = prefilter(input({ title }));
      assert(v.keep === false, `应判为噪音：${title}`);
    }
  });

  it("批量预筛保持顺序（能按索引对齐入库条目）", () => {
    const items = [input({ title: "快讯" }), input(), input({ summary: "短" })];
    const out = prefilterAll(items);
    assertEqual(out.length, 3);
    assertEqual(out.map((o) => o.verdict.keep), [false, true, false]);
    assertEqual(out[1]?.input.title, items[1]!.title);
  });
});

describe("totalOf · 加权总分", () => {
  it("全 10 分 → 100；全 0 分 → 0", () => {
    assertEqual(totalOf({ relevance: 10, novelty: 10, usefulness: 10, authority: 10 }), 100);
    assertEqual(totalOf({ relevance: 0, novelty: 0, usefulness: 0, authority: 0 }), 0);
  });

  it("权重和为 1，且相关性权重最高", () => {
    const sum =
      DEFAULT_WEIGHTS.relevance + DEFAULT_WEIGHTS.novelty + DEFAULT_WEIGHTS.usefulness + DEFAULT_WEIGHTS.authority;
    assert(Math.abs(sum - 1) < 1e-9, `权重和应为 1，实际 ${sum}`);
    assert(DEFAULT_WEIGHTS.relevance >= DEFAULT_WEIGHTS.novelty);
    assert(DEFAULT_WEIGHTS.relevance >= DEFAULT_WEIGHTS.authority);
  });

  it("总分落在 0..100 且为最简小数（避免浮点毛刺影响阈值比较）", () => {
    // 维度是整数 + 权重是 0.2 的倍数 → 总分理论上是整数，但保留 /10 以便权重调整后仍有 .5
    const t = totalOf({ relevance: 7, novelty: 6, usefulness: 5, authority: 8 });
    assertEqual(t, 66, "7*0.4 + 6*0.2 + 5*0.2 + 8*0.2 = 6.6 → 66");
    assert(t >= 0 && t <= 100);
    assertEqual(t, Math.round(t * 10) / 10);
  });
});

describe("parseScore · 严格校验（失败不塞默认分）", () => {
  it("正常 JSON 解析成功并算出总分", () => {
    const r = parseScore('{"relevance":8,"novelty":7,"usefulness":6,"authority":9,"reason":"官方发布"}');
    assert(r.ok);
    assertEqual(r.score.relevance, 8);
    assertEqual(r.score.reason, "官方发布");
    assertEqual(r.score.total, totalOf({ relevance: 8, novelty: 7, usefulness: 6, authority: 9 }));
  });

  it("兼容 ```json 围栏与前后多余文字", () => {
    const r = parseScore('```json\n{"relevance":5,"novelty":5,"usefulness":5,"authority":5}\n```');
    assert(r.ok);
    const r2 = parseScore('好的，结果如下：{"relevance":5,"novelty":5,"usefulness":5,"authority":5} 完毕');
    assert(r2.ok);
  });

  it("缺字段 / 越界 / 非数字 → 失败（不裁剪、不补默认）", () => {
    const missing = parseScore('{"relevance":8,"novelty":7,"usefulness":6}');
    assert(!missing.ok);
    assert(missing.reason.includes("authority"));

    const outOfRange = parseScore('{"relevance":11,"novelty":7,"usefulness":6,"authority":9}');
    assert(!outOfRange.ok);
    assert(outOfRange.reason.includes("越界"));

    const notNumber = parseScore('{"relevance":"高","novelty":7,"usefulness":6,"authority":9}');
    assert(!notNumber.ok);
  });

  it("空返回 / 非 JSON → 失败并给出可读原因", () => {
    const empty = parseScore("");
    assert(!empty.ok);
    assertEqual(empty.reason, "模型返回为空");
    const noJson = parseScore("我认为这条不错");
    assert(!noJson.ok);
    assert(noJson.reason.includes("JSON"));
  });
});

describe("selectTop · 阈值 + topN", () => {
  const scored = [
    { id: "a", total: 82 },
    { id: "b", total: 58 },
    { id: "c", total: 71 },
    { id: "d", total: 90 },
  ];

  it("按阈值过滤，并按总分取前 N（保持原顺序返回）", () => {
    const { kept, belowThreshold, overLimit } = selectTop(scored, { threshold: 60, topN: 2 });
    // 通过阈值的是 a(82) / c(71) / d(90)；topN=2 → 取分最高的 d 与 a，但**按原始顺序**返回
    assertEqual(kept.map((k) => k.id), ["a", "d"], "保持原始顺序（便于与入库顺序对齐）");
    assertEqual(belowThreshold, 1, "b(58) 低于阈值");
    assertEqual(overLimit, 1, "c(71) 被 topN 截掉");
  });

  it("阈值边界：等于阈值算入选（>= 而非 >）", () => {
    const { kept } = selectTop([{ id: "x", total: 60 }], { threshold: 60, topN: 5 });
    assertEqual(kept.length, 1);
  });

  it("阈值为 0 时全入选，但受 topN 限制", () => {
    const { kept, overLimit } = selectTop(scored, { threshold: 0, topN: 3 });
    assertEqual(kept.length, 3);
    assertEqual(overLimit, 1);
  });
});