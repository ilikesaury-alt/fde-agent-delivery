/** 解读红线守卫（A6 红线用例的可执行版本） */

import { assert, assertEqual, describe, it } from "./harness.ts";
import { interpretGuard, isForbiddenQuestion } from "../lib/interpret-guard.ts";

describe("interpret-guard — 红线拦截", () => {
  it("诊断类必须拦截", () => {
    for (const q of [
      "我是不是得了糖尿病",
      "这个指标说明什么问题，是什么病",
      "我的病情严重吗",
      "能帮我诊断一下吗",
    ]) {
      assert(isForbiddenQuestion(q), `应拦截：${q}`);
    }
  });

  it("用药类必须拦截", () => {
    for (const q of [
      "我该吃什么药",
      "需要停药吗",
      "推荐点保健品",
      "剂量吃多少",
      "这个药要不要减药",
    ]) {
      assert(isForbiddenQuestion(q), `应拦截：${q}`);
    }
  });

  it("危急处置类必须拦截", () => {
    for (const q of ["需要马上去急诊吗", "是不是有生命危险", "该不该住院"]) {
      assert(isForbiddenQuestion(q), `应拦截：${q}`);
    }
  });

  it("正常科普提问不误拦", () => {
    for (const q of [
      "这个指标是查什么的",
      "偏高需要注意什么饮食",
      "下次复查挂什么科",
      "这个指标为什么会波动",
      "参考范围是什么意思",
    ]) {
      assert(!isForbiddenQuestion(q), `不应拦截：${q}`);
    }
  });

  it("空提问视为允许；返回命中类别便于内部排查", () => {
    assertEqual(interpretGuard(undefined).allowed, true);
    assertEqual(interpretGuard("   ").allowed, true);
    const r = interpretGuard("我该吃什么药");
    assert(!r.allowed);
    assertEqual(!r.allowed && r.hits.length > 0, true);
  });
});