/**
 * 访问令牌校验（与产品①~④ 同口径，独立副本，不跨产品 import）。
 * 配置了 ACCESS_TOKEN 时，请求必须带 `Authorization: Bearer <token>`；
 * 未配置 = 不校验（演示站可用，公开分享前务必配置）。
 * 等长比较降低时序侧信道。
 */
export function checkAccessToken(
  configured: string | undefined,
  header: string | undefined,
): boolean {
  if (!configured) return true;
  if (!header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  const provided = m[1]!;
  if (provided.length !== configured.length) return false;
  let diff = 0;
  for (let i = 0; i < configured.length; i++) {
    diff |= configured.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}