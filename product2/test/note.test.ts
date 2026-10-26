import { assert, assertEqual, describe, it } from "./harness.ts";
import { parseNote, isUsableNote, renderNoteText, previewBody } from "../lib/note.ts";

const GOOD = `[标题]
我花了三个月才搞懂这件事

[备选标题]
三个月踩坑总结，建议收藏
这件事我早该知道

[正文]
第一段：起因是这样的 🍀

第二段：踩过的坑。✨

[标签]
#效率 #复盘 #个人成长`;

describe("note.parse — 标准格式", () => {
  it("三段结构完整解析", () => {
    const { note } = parseNote(GOOD);
    assertEqual(note.titles, ["我花了三个月才搞懂这件事", "三个月踩坑总结，建议收藏", "这件事我早该知道"], "标题应为 3 个（主 + 2 备选）");
    assert(note.body.includes("第一段"), "正文应含第一段");
    assert(note.body.includes("第二段"), "正文应含第二段");
    assertEqual(note.tags, ["效率", "复盘", "个人成长"], "标签应去 # 前缀");
  });

  it("正文保留分段与 emoji", () => {
    const { note } = parseNote(GOOD);
    assert(note.body.includes("\n\n"), "段落之间应保留空行");
    assert(note.body.includes("🍀"), "emoji 应保留");
  });
});

describe("note.parse — 宽容性（LLM 输出不稳定是常态）", () => {
  it("全角括号标记", () => {
    const raw = `【标题】\n全角标题\n【正文】\n这是一段足够长的正文内容用于通过可用性校验。\n【标签】\n#a #b #c`;
    const { note } = parseNote(raw);
    assertEqual(note.titles, ["全角标题"]);
    assert(note.body.includes("足够长的正文"));
    assertEqual(note.tags, ["a", "b", "c"]);
  });

  it("Markdown 标题标记", () => {
    const raw = `## 标题\nMD 标题\n## 正文\n这是一段足够长的正文内容用于通过可用性校验。\n## 标签\n#x #y #z`;
    const { note } = parseNote(raw);
    assertEqual(note.titles, ["MD 标题"]);
    assertEqual(note.tags, ["x", "y", "z"]);
  });

  it("标题包裹引号/粗体被剥离", () => {
    const raw = `[标题]\n**"带包裹的标题"**\n[正文]\n这是一段足够长的正文内容用于通过可用性校验。\n[标签]\n#t1 #t2 #t3`;
    const { note } = parseNote(raw);
    assertEqual(note.titles, ["带包裹的标题"]);
  });

  it("标签混用逗号/中文标点也能拆开", () => {
    const raw = `[标题]\nT\n[正文]\n这是一段足够长的正文内容用于通过可用性校验。\n[标签]\n#one，two、three`;
    const { note } = parseNote(raw);
    assertEqual(note.tags, ["one", "two", "three"]);
  });

  it("缺标题段时从正文首句兜底", () => {
    const raw = `[正文]\n这是没有标题的一句话。后面还有内容足够长以通过校验。\n[标签]\n#a #b`;
    const { note, issues } = parseNote(raw);
    assert(note.titles.length > 0, "应兜底出标题");
    assert(issues.some((i) => i.includes("无标题段")), "应记录兜底 issue");
  });

  it("标签去重且最多 6 个", () => {
    const raw = `[标题]\nT\n[正文]\n这是一段足够长的正文内容用于通过可用性校验。\n[标签]\n#a #a #b #c #d #e #f #g #h`;
    const { note } = parseNote(raw);
    assertEqual(note.tags.length, 6, "最多保留 6 个标签");
    assertEqual(note.tags[0], "a");
  });
});

describe("note.isUsableNote — 兜底判据", () => {
  it("正文过短判为不可用", () => {
    assert(!isUsableNote({ titles: ["t"], body: "太短", tags: [] }), "过短正文应判不可用");
  });
  it("标准输出判为可用", () => {
    const { note } = parseNote(GOOD);
    assert(isUsableNote(note), "标准输出应可用");
  });
  it("完全没有正文判为不可用（防止把破碎内容展示给用户）", () => {
    const { note } = parseNote("[标题]\n只有标题");
    assert(!isUsableNote(note));
  });
});

describe("note.renderNoteText — 整篇复制", () => {
  it("包含标题/正文/标签且顺序正确", () => {
    const { note } = parseNote(GOOD);
    const text = renderNoteText(note);
    assert(text.startsWith("我花了三个月才搞懂这件事"), "应以主标题开头");
    assert(text.includes("第一段"), "应含正文");
    assert(text.trim().endsWith("#效率 #复盘 #个人成长"), "应以标签行结尾");
  });

  it("切换标题索引时输出对应标题", () => {
    const { note } = parseNote(GOOD);
    const text = renderNoteText(note, 2);
    assert(text.startsWith("这件事我早该知道"), "应使用第 3 个标题");
  });
});

describe("note.previewBody — 流式预览（只展示正文段）", () => {
  it("已有正文标记时，标题区不进正文", () => {
    const partial = "[标题]\n这是标题\n[备选标题]\n备选一\n[正文]\n正文第一行\n正文第二行";
    const out = previewBody(partial);
    assertEqual(out, "正文第一行\n正文第二行");
  });

  it("标记行不出现（过滤后再切片的经典错法会丢行）", () => {
    const partial = "[标题]\nA\n[备选标题]\nB1\nB2\n[正文]\n1\n2\n3";
    const out = previewBody(partial);
    assert(!out.includes("B1"), "备选标题不应进正文");
    assertEqual(out.split("\n").length, 3, "三行正文一行都不能丢");
  });

  it("还没到正文段时预览为空（不把标题临时当正文闪一下）", () => {
    assertEqual(previewBody("[标题]\n还在生成标题"), "");
    assertEqual(previewBody("还没到任何标记"), "还没到任何标记");
  });

  it("正文为空时不产生前导空行", () => {
    const out = previewBody("[正文]\n\n第一行");
    assertEqual(out, "第一行");
  });

  it("标签段之后的内容不混进正文（已过正文段）", () => {
    const full = "[标题]\nT\n[正文]\n正文内容\n[标签]\n#a #b";
    assert(!previewBody(full).includes("#a"), "标签不应进正文预览");
  });
});
