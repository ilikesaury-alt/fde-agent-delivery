/**
 * 访问令牌校验。
 * 配置了 ACCESS_TOKEN 时，请求必须带 `Authorization: Bearer <token>`。
 * 用等长比较降低时序侧信道（本场景风险低，但成本也低）。
 *
 * 与产品① 同口径实现（独立副本，不跨产品 import）。
 */
export function checkAccessToken(
  configured: string | undefined,
  header: string | undefined,
): boolean {
  if (!configured) return true; // 未配置 = 不校验
  if (!header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  const provided = m[1];
  if (provided.length !== configured.length) return false;
  let diff = 0;
  for (let i = 0; i < configured.length; i++) {
    diff |= configured.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}
