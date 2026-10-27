import { assert, assertEqual, describe, it } from "./harness.ts";
import { normalizeText, sha256Hex } from "../lib/hash.ts";

describe("hash.normalizeText — 规范化", () => {
  it("CRLF 统一为 LF", () => {
    assertEqual(normalizeText("a\r\nb"), "a\nb");
  });

  it("去行尾空白与首尾空白", () => {
    assertEqual(normalizeText("  a  \n b\t\n"), "a\n b");
  });

  it("折叠三个以上连续空行", () => {
    assertEqual(normalizeText("a\n\n\n\nb"), "a\n\nb");
  });

  it("不同渠道导入的同一内容规范化后相同（幂等前提）", () => {
    const fromFile = "标题\r\n\r\n正文第一段。\r\n正文第二段。\r\n";
    const fromPaste = "标题\n\n正文第一段。\n正文第二段。";
    assertEqual(normalizeText(fromFile), normalizeText(fromPaste), "换行差异不应产生两份文档");
  });
});

describe("hash.sha256Hex — 内容哈希", () => {
  it("确定性：同输入同输出", async () => {
    const a = await sha256Hex("同一段内容");
    const b = await sha256Hex("同一段内容");
    assertEqual(a, b);
  });

  it("输出为 64 位十六进制", async () => {
    const h = await sha256Hex("x");
    assert(/^[0-9a-f]{64}$/.test(h), `哈希格式不对: ${h}`);
  });

  it("不同内容不同哈希", async () => {
    const a = await sha256Hex("内容A");
    const b = await sha256Hex("内容B");
    assert(a !== b, "不同内容不应碰撞");
  });
});
