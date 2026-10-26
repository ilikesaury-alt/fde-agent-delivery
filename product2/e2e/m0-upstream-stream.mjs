/**
 * M0-real：验证 magpie 上游是否真支持 stream:true（方案里唯一未实测的关键假设）。
 * 优先用本地网关（127.0.0.1:3425），回退 .env 里的隧道地址。
 * 不打印任何密钥。
 *
 * 用法：node e2e/m0-upstream-stream.mjs [baseUrl] [model]
 */

import { readFileSync } from "node:fs";

const envPath = new URL("../../product1/.env", import.meta.url);
const raw = readFileSync(envPath, "utf8").replace(/^\uFEFF/, "");
const env = {};
for (const line of raw.split(/\r?\n/)) {
  const m = /^([A-Z_0-9]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}
if (!env.MAGPIE_API_KEY) {
  console.error("缺少 MAGPIE_API_KEY");
  process.exit(2);
}

const candidates = [
  process.argv[2],
  "http://127.0.0.1:3425/v1",
  env.MAGPIE_BASE_URL,
].filter(Boolean);

const model = process.argv[3] || "auto/deepseek-v4.1-flash";

async function tryOne(baseUrl) {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const t0 = Date.now();
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.MAGPIE_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.7,
        max_tokens: 80,
        stream: true,
        messages: [
          { role: "system", content: "只回复一句话，不要解释。" },
          { role: "user", content: "用一句话说明什么是流式输出。" },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    return { baseUrl, error: e.message };
  }

  const ct = resp.headers.get("content-type") ?? "";
  if (!resp.ok) {
    let body = "";
    try {
      body = (await resp.text()).slice(0, 200);
    } catch {}
    return { baseUrl, error: `status ${resp.status} ${body}` };
  }
  if (!resp.body) return { baseUrl, error: "无响应体" };

  const arrivals = [];
  let firstTokenMs = null;
  let total = "";
  let frameCount = 0;
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      frameCount++;
      try {
        const j = JSON.parse(payload);
        const c = j.choices?.[0]?.delta?.content;
        if (typeof c === "string" && c.length) {
          if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
          arrivals.push(Date.now() - t0);
          total += c;
        }
      } catch {
        /* 忽略 */
      }
    }
  }
  const totalMs = Date.now() - t0;
  return { baseUrl, ct, frameCount, deltas: arrivals.length, firstTokenMs, totalMs, total };
}

for (const base of candidates) {
  console.log(`\n--- 尝试 ${base} (model=${model}) ---`);
  const r = await tryOne(base);
  if (r.error) {
    console.log(`❌ ${r.error}`);
    continue;
  }
  console.log(`content-type=${r.ct}`);
  console.log(`sse 帧=${r.frameCount} 增量帧=${r.deltas} 首token=${r.firstTokenMs}ms 总=${r.totalMs}ms`);
  console.log(`内容=${JSON.stringify(r.total)}`);

  const isSse = r.ct.includes("text/event-stream");
  const incremental = r.deltas >= 2 && r.firstTokenMs !== null && r.totalMs - r.firstTokenMs >= 30;
  console.log(`${isSse ? "✅" : "❌"} content-type 是 event-stream`);
  console.log(`${r.deltas >= 2 ? "✅" : "❌"} 多个增量帧（${r.deltas}）`);
  console.log(`${incremental ? "✅" : "❌"} 增量到达（首帧 ${r.firstTokenMs}ms vs 总 ${r.totalMs}ms）`);
  if (isSse && incremental) {
    console.log("\nM0-real PASS：上游支持 stream:true 且为真增量");
    process.exit(0);
  }
  console.log("\n该地址不满足流式要求，继续尝试下一个");
}

console.log("\nM0-real FAIL：所有候选地址都不满足（需走降级方案或开隧道）");
process.exit(1);
