/**
 * SSRF 三道闸的回归用例（cross-review B2）。
 *
 * 尾点写法（`localhost.` / `169.254.169.254.`）是合法的绝对域名形式，
 * 解析结果与无点版本一致 —— 若闸门只做字符串匹配就会被绕过。
 */

import { assert, assertEqual, describe, it } from "./harness.ts";
import { dedupeRepeatedLines, extractFromHtml, isBlockedHost, validateUrl } from "../lib/fetch-article.ts";

describe("fetch-article.isBlockedHost — 内网判定", () => {
  it("普通内网 IPv4 一律拦截", () => {
    for (const h of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "169.254.169.254", "0.0.0.0"]) {
      assert(isBlockedHost(h), `${h} 应被拦截`);
    }
  });

  it("内网 IPv4 的尾点写法同样拦截（B2 回归）", () => {
    for (const h of ["169.254.169.254.", "127.0.0.1.", "10.0.0.5.", "192.168.1.1."]) {
      assert(isBlockedHost(h), `${h}（尾点）应被拦截`);
    }
  });

  it("localhost / metadata 的各种写法拦截", () => {
    for (const h of ["localhost", "localhost.", "a.localhost", "metadata", "metadata.google.internal", "metadata.google.internal."]) {
      assert(isBlockedHost(h), `${h} 应被拦截`);
    }
  });

  it("IPv6 回环与私有段拦截", () => {
    for (const h of ["::1", "[::1]", "fc00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      assert(isBlockedHost(h), `${h} 应被拦截`);
    }
  });

  it("无点短名视为内网", () => {
    assert(isBlockedHost("intranet"));
    assert(isBlockedHost(""));
  });

  it("公网域名放行", () => {
    for (const h of ["example.com", "www.cloudflare.com", "8.8.8.8", "1.1.1.1"]) {
      assert(!isBlockedHost(h), `${h} 不应被拦截`);
    }
  });
});

describe("fetch-article.validateUrl — 协议与形态", () => {
  it("只允许 http/https", () => {
    for (const u of ["ftp://example.com/a", "file:///etc/passwd", "javascript:alert(1)"]) {
      let threw = false;
      try {
        validateUrl(u);
      } catch {
        threw = true;
      }
      assert(threw, `${u} 应被拒绝`);
    }
  });

  it("带 userinfo 的 URL 拒绝（常用于混淆主机）", () => {
    let threw = false;
    try {
      validateUrl("http://user:pass@example.com/");
    } catch {
      threw = true;
    }
    assert(threw, "带用户名密码的链接应被拒绝");
  });

  it("尾点内网地址在 URL 闸就被拦（B2 回归）", () => {
    let msg = "";
    try {
      validateUrl("http://169.254.169.254./latest/meta-data/");
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    assert(msg.length > 0, "http://169.254.169.254./ 应被拒绝");
    assertEqual(validateUrl("https://example.com/a").hostname, "example.com");
  });
});

// ── 重复正文去重（线上实测：X 页面正文重复 2–3 遍）────────────────────
describe("dedupeRepeatedLines（重复正文去重）", () => {
  it("完全相同的长行只保留第一次出现", () => {
    const line = "新功能第一时间在这发 语音通话、插件、购物支付这些更新都能看到 想跟进最新动态就关注它";
    const input = [line, "另一条不同的内容，长度也超过二十个字符用于测试", line].join("\n");
    const out = dedupeRepeatedLines(input);
    const hits = out.split("\n").filter((l) => l.trim() === line);
    assertEqual(hits.length, 1, "重复长行应只保留一次");
    assert(out.includes("另一条不同的内容"), "不重复的行必须保留");
  });

  it("忽略空白与大小写差异（视为同一行）", () => {
    const out = dedupeRepeatedLines("Hello World This Is A Long Line\nhello  world   this is a long line");
    assertEqual(out.split("\n").filter((l) => l.trim()).length, 1);
  });

  it("短行不去重（表格行/标签是正常重复结构）", () => {
    const out = dedupeRepeatedLines("| a | b |\n| --- | --- |\n| a | b |");
    assertEqual(out.split("\n").length, 3, "短行必须原样保留");
  });

  it("extractFromHtml 对大段重复正文做压缩", () => {
    const para = "这是一段很长的正文内容，用来模拟被站点重复渲染的段落文字，长度超过二十个字符。";
    const html = `<html><body><article><p>${para}</p><p>${para}</p><p>${para}</p><p>结尾另一段完全不同的内容，也需要保留下来用于验证。</p></article></body></html>`;
    const { text } = extractFromHtml(html);
    const occurrences = text.split(para).length - 1;
    assertEqual(occurrences, 1, "重复段落应被压成一处");
    assert(text.includes("结尾另一段完全不同的内容"), "非重复段落必须保留");
  });
});
