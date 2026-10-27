/**
 * 内容哈希 —— 幂等导入的判据（D14：同 source + 同内容 → 不重复入库）。
 *
 * 规范化先行：统一换行、去首尾空白、折叠行尾空格。
 * 目的：用户把同一份文档从不同渠道导入（复制粘贴 / 文件 / 网页）时，
 * 只要语义内容一致就不该产生第二份向量。
 */

/** 规范化正文（哈希与切分都用它，避免两处口径漂移） */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** sha256 十六进制（Web Crypto，Workers 与 Node 22 都可用） */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
