import { assert, assertEqual, describe, it } from "./harness.ts";
import { isBlockedHost, validateUrl, extractFromHtml, fetchArticle, FetchArticleError } from "../lib/fetch-article.ts";

describe("fetchArticle.isBlockedHost — SSRF 防护", () => {
  it("拒绝本机与内网地址", () => {
    for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.1", "169.254.169.254", "::1", "fd00::1", "metadata.google.internal"]) {
      assert(isBlockedHost(h), `${h} 应被拒绝`);
    }
  });

  it("放行公网地址", () => {
    for (const h of ["example.com", "mp.weixin.qq.com", "8.8.8.8", "1.1.1.1"]) {
      assert(!isBlockedHost(h), `${h} 应被放行`);
    }
  });

  it("无点短名视为内网", () => {
    assert(isBlockedHost("intranet"), "短名应视为内网");
  });
});

describe("fetchArticle.validateUrl", () => {
  it("非 http(s) 协议被拒", async () => {
    let code = "";
    try {
      validateUrl("file:///etc/passwd");
    } catch (e) {
      code = (e as FetchArticleError).code;
    }
    assertEqual(code, "invalid_url");
  });

  it("非法字符串被拒", async () => {
    let code = "";
    try {
      validateUrl("not a url");
    } catch (e) {
      code = (e as FetchArticleError).code;
    }
    assertEqual(code, "invalid_url");
  });

  it("内网 URL 以 blocked_host 拒绝", async () => {
    let code = "";
    try {
      validateUrl("http://127.0.0.1:8080/admin");
    } catch (e) {
      code = (e as FetchArticleError).code;
    }
    assertEqual(code, "blocked_host");
  });
});

describe("fetchArticle.extractFromHtml — 正文抽取", () => {
  const HTML = `<!doctype html><html><head><title>页面标题 - 站点名</title>
    <meta property="og:title" content="OG 标题">
    <style>.x{color:red}</style><script>var a=1;</script></head>
    <body>
      <nav>首页 关于 联系我们</nav>
      <article>
        <h1>正文大标题</h1>
        <p>这是第一段正文，内容足够长，用于验证抽取逻辑能够抓到真正的文章内容，而不是导航栏的文字。</p>
        <p>这是第二段正文，同样足够长，包含一些细节信息，比如数据和结论，确保启发式选择到正确的容器。</p>
      </article>
      <footer>版权所有</footer>
      <script>console.log('x')</script>
    </body></html>`;

  it("优先取 article 正文并剔除脚本/导航", () => {
    const { text } = extractFromHtml(HTML);
    assert(text.includes("第一段正文"), "应含正文");
    assert(!text.includes("console.log"), "不应含脚本内容");
    assert(!text.includes("color:red"), "不应含样式内容");
    assert(!text.includes("联系我们"), "不应含导航文字");
    assert(!text.includes("版权所有"), "不应含页脚");
  });

  it("标题优先 og:title", () => {
    const { title } = extractFromHtml(HTML);
    assertEqual(title, "OG 标题");
  });

  it("无 og:title 时回退 <title>", () => {
    const html = `<html><head><title>只有 title</title></head><body><p>这是一段足够长的正文，用于验证回退逻辑是否生效，长度必须超过阈值。</p></body></html>`;
    const { title } = extractFromHtml(html);
    assertEqual(title, "只有 title");
  });
});

describe("fetchArticle — 网络与错误映射", () => {
  it("404 给出明确文案（引导改用粘贴）", async () => {
    const fetchImpl = (async () =>
      new Response("not found", { status: 404, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const err = await fetchArticle("https://example.com/x", { fetchImpl }).then(
      () => null,
      (e) => e as FetchArticleError,
    );
    assert(err !== null, "应抛错");
    assertEqual(err!.code, "http_status");
    assert(err!.message.includes("404"), "文案应含 404");
    assert(err!.message.includes("粘贴"), "应引导改用粘贴");
  });

  it("正文过短判为 empty 并引导", async () => {
    const fetchImpl = (async () =>
      new Response("<html><body><div>短</div></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    const err = await fetchArticle("https://example.com/x", { fetchImpl }).then(
      () => null,
      (e) => e as FetchArticleError,
    );
    assertEqual(err?.code, "empty");
    assert(err!.message.includes("粘贴"), "应引导改用粘贴");
  });

  it("网络异常映射为 network 错误", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const err = await fetchArticle("https://example.com/x", { fetchImpl }).then(
      () => null,
      (e) => e as FetchArticleError,
    );
    assertEqual(err?.code, "network");
  });

  it("非 HTML content-type 判为 empty（如 PDF 链接）", async () => {
    const fetchImpl = (async () =>
      new Response("%PDF-1.4", { status: 200, headers: { "content-type": "application/pdf" } })) as unknown as typeof fetch;
    const err = await fetchArticle("https://example.com/x.pdf", { fetchImpl }).then(
      () => null,
      (e) => e as FetchArticleError,
    );
    assertEqual(err?.code, "empty");
  });

  it("成功路径返回正文与最终 URL", async () => {
    const html = `<html><head><title>T</title></head><body><article><p>${"这是一段足够长的正文内容，".repeat(10)}</p></article></body></html>`;
    const fetchImpl = (async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })) as unknown as typeof fetch;
    const r = await fetchArticle("https://example.com/a", { fetchImpl });
    assert(r.text.length > 50, "应返回正文");
    assertEqual(r.finalUrl, "https://example.com/a");
  });
});

describe("fetchArticle — SSRF 加固（对抗审查反例）", () => {
  it("IPv4-mapped IPv6 十六进制写法被拒（::ffff:7f00:1）", () => {
    assert(isBlockedHost("::ffff:7f00:1"), "应识别为 127.0.0.1");
    assert(isBlockedHost("::7f00:1"), "IPv4-compatible 回环");
    assert(isBlockedHost("64:ff9b::7f00:1"), "NAT64 映射回环");
    assert(isBlockedHost("2002:7f00:1::"), "6to4 嵌入回环");
  });

  it("IPv6 内网段被拒", () => {
    for (const h of ["fd12:3456::1", "fe80::1", "::", "::1"]) {
      assert(isBlockedHost(h), `${h} 应被拒`);
    }
  });

  it("IPv6 公网地址放行", () => {
    assert(!isBlockedHost("2606:4700:4700::1111"), "Cloudflare DNS 应放行");
  });

  it("带 userinfo 的 URL 被拒（防凭据外泄与主机混淆）", () => {
    let code = "";
    try {
      validateUrl("https://user:pass@example.com/a");
    } catch (e) {
      code = (e as FetchArticleError).code;
    }
    assertEqual(code, "invalid_url");
  });

  it("异常端口被拒", () => {
    let code = "";
    try {
      validateUrl("http://example.com:6379/");
    } catch (e) {
      code = (e as FetchArticleError).code;
    }
    assertEqual(code, "invalid_url");
  });

  it("重定向到内网会被逐跳拦下（不是先请求再拦）", async () => {
    let requestedInternal = false;
    const fetchImpl = (async (input: string | URL) => {
      const u = String(input);
      if (u.includes("127.0.0.1") || u.includes("169.254")) requestedInternal = true;
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
    }) as unknown as typeof fetch;
    const err = await fetchArticle("https://example.com/x", { fetchImpl }).then(
      () => null,
      (e) => e as Error,
    );
    assert(err !== null, "应抛错");
    assert(!requestedInternal, "绝不能真的请求内网地址");
  });

  it("跳转次数过多给出明确文案", async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 302, headers: { location: "https://example.com/loop" } })) as unknown as typeof fetch;
    const err = await fetchArticle("https://example.com/x", { fetchImpl }).then(
      () => null,
      (e) => e as Error,
    );
    assert(err!.message.includes("跳转"), `实际：${err!.message}`);
  });
});
