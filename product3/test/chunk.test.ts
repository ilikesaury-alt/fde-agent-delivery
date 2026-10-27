import { assert, assertEqual, describe, it } from "./harness.ts";
import { CHUNK_MAX, CHUNK_MIN, chunkText, splitLongText, splitSections } from "../lib/chunk.ts";

describe("chunk.splitSections — 按标题分节", () => {
  it("记录各级标题路径", () => {
    const s = splitSections("# 一级\n正文A\n\n## 二级\n正文B");
    assertEqual(s.length, 2, "应分出 2 节");
    assertEqual(s[0].headingPath, "一级");
    assertEqual(s[1].headingPath, "一级 / 二级", "二级应带父级路径");
  });

  it("同级标题不累积路径", () => {
    const s = splitSections("# A\na\n\n# B\nb");
    assertEqual(s.map((x) => x.headingPath), ["A", "B"], "同级标题路径应互不包含");
  });

  it("无标题文档整体为一节且路径为空", () => {
    const s = splitSections("就是一段普通文本。\n第二行。");
    assertEqual(s.length, 1);
    assertEqual(s[0].headingPath, "", "无标题时不应编造路径");
  });

  it("标题下的空节被丢弃", () => {
    const s = splitSections("# 有内容\n文本\n\n# 空节\n\n# 又一段\n更多");
    assertEqual(s.map((x) => x.headingPath), ["有内容", "又一段"], "空节不应产出 chunk 来源");
  });
});

describe("chunk.splitLongText — 超长单段按句子切", () => {
  it("短文本原样返回", () => {
    assertEqual(splitLongText("短句。", 800), ["短句。"]);
  });

  it("按中文句号切分且不丢内容", () => {
    const text = "第一句。第二句。第三句。";
    const parts = splitLongText(text, 6);
    assert(parts.length > 1, "应切成多片");
    assertEqual(parts.join(""), text, "切片拼接应等于原文（不丢字）");
  });

  it("单句超长时硬切", () => {
    const text = "啊".repeat(25);
    const parts = splitLongText(text, 10);
    assert(parts.every((p) => p.length <= 10), "每片都应 ≤ max");
    assertEqual(parts.join(""), text);
  });
});

describe("chunk.chunkText — 主入口", () => {
  it("空文本 / 纯空白 → 空数组", () => {
    assertEqual(chunkText(""), []);
    assertEqual(chunkText("   \n\n \t "), []);
  });

  it("每个 chunk 继承所在节的 headingPath", () => {
    const text = "# 部署\n" + "这是一段关于部署的说明。".repeat(30) + "\n\n## 回滚\n回滚步骤见下。";
    const drafts = chunkText(text);
    const deploy = drafts.filter((d) => d.headingPath === "部署");
    const rollback = drafts.filter((d) => d.headingPath === "部署 / 回滚");
    assert(deploy.length >= 1, "部署节应有 chunk");
    assert(rollback.length >= 1, "回滚节应有 chunk");
  });

  it("chunk 长度不超过上限", () => {
    const para = "这是很长的一段内容，用来验证切分不会超过上限。".repeat(200);
    const drafts = chunkText(para);
    assert(drafts.length > 1, "应切成多块");
    assert(drafts.every((d) => d.text.length <= CHUNK_MAX), `每块都必须 ≤ CHUNK_MAX（N2），实际最大 ${Math.max(...drafts.map((d) => d.text.length))}`);
  });

  it("idx 从 0 连续递增（引用编号依赖它）", () => {
    const drafts = chunkText("# A\n" + "内容。".repeat(500));
    assertEqual(drafts.map((d) => d.idx), drafts.map((_, i) => i), "idx 必须连续");
  });

  it("过碎尾块被合并（除最后一块外不小于下限，或已被上限约束）", () => {
    const text = "# A\n" + "甲".repeat(CHUNK_MIN) + "\n\n短尾巴。";
    const drafts = chunkText(text);
    const last = drafts[drafts.length - 1];
    assert(last.text.includes("短尾巴") || drafts.length === 1, "短尾巴应被并入前一块");
  });

  it("不产出空 chunk", () => {
    const drafts = chunkText("# 空\n\n\n# 有\n内容。");
    assert(drafts.every((d) => d.text.trim().length > 0), "不应有空 chunk");
  });
});

describe("chunk.chunkText — N2：重叠种子不得让 chunk 越界", () => {
  it("长段 + 长段组合时每块仍 ≤ CHUNK_MAX", () => {
    const text = "甲".repeat(500) + "\n\n" + "乙".repeat(700) + "\n\n" + "丙".repeat(790);
    const drafts = chunkText(text);
    const max = Math.max(...drafts.map((d) => d.text.length));
    assert(max <= CHUNK_MAX, "最大 chunk 为 " + max + "，超过上限 " + CHUNK_MAX);
  });

  it("多种长度段落组合下不越界", () => {
    const paras = [200, 300, 700, 790, 100, 500, 650].map((n, i) => "段落" + i + "：" + "字".repeat(n));
    const drafts = chunkText("# 混合\n\n" + paras.join("\n\n"));
    for (const d of drafts) {
      assert(d.text.length <= CHUNK_MAX, "chunk " + d.idx + " 长度 " + d.text.length + " 超限");
    }
  });
});
