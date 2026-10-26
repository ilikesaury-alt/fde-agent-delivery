/**
 * 诊断：某些模型 stream:true 时 delta 里没有 content —— 帧里到底有什么字段？
 * 用法：node e2e/diag-frames.mjs [model]
 */
import { readFileSync } from "node:fs";

const envPath = new URL("../../product1/.env", import.meta.url);
const raw = readFileSync(envPath, "utf8").replace(/^\uFEFF/, "");
const env = {};
for (const line of raw.split(/\r?\n/)) {
  const m = /^([A-Z_0-9]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}

const model = process.argv[2] || "auto/glm-5.3-flash";
const resp = await fetch("http://127.0.0.1:3425/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${env.MAGPIE_API_KEY}` },
  body: JSON.stringify({
    model,
    stream: true,
    max_tokens: 40,
    messages: [{ role: "user", content: "说一句你好" }],
  }),
  signal: AbortSignal.timeout(90_000),
});
console.log("status", resp.status, resp.headers.get("content-type"));
const reader = resp.body.getReader();
const dec = new TextDecoder();
let buf = "";
let n = 0;
const keys = new Set();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).replace(/\r$/, "");
    buf = buf.slice(i + 1);
    if (!line.startsWith("data:")) continue;
    const p = line.slice(5).trim();
    if (!p || p === "[DONE]") continue;
    n++;
    try {
      const j = JSON.parse(p);
      const delta = j.choices?.[0]?.delta;
      if (delta) Object.keys(delta).forEach((k) => keys.add(k));
      if (n <= 3 || (delta && Object.keys(delta).length > 0 && n <= 6)) {
        console.log(`FRAME ${n}:`, JSON.stringify(j).slice(0, 500));
      }
    } catch {
      console.log(`FRAME ${n} (unparsed):`, p.slice(0, 200));
    }
  }
}
console.log(`\n总帧=${n}，出现过的 delta 字段: ${[...keys].join(", ") || "（无 delta）"}`);
