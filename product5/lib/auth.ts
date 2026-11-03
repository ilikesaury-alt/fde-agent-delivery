/**
 * 访问令牌校验（与产品①~④ 同口径，但**修正了审查 B-1 发现的漏洞**）。
 *
 * 审查 B-1 发现：原实现 `if (!configured) return true` 对 **undefined 与空串一视同仁** ——
 * `wrangler secret put ACCESS_TOKEN` 时回车传空值（或运维忘记配）→ 一切写操作公开，
 * 且没有任何日志/健康检查提示「当前无鉴权」。
 *
 * 修正后的三态语义（**显式且可观测**）：
 *   - `undefined`（未配置）→ **演示模式**：读接口放行，**写接口必须由调用方额外拦截**
 *     （见 routes/api/{score,digest}.ts 的 `if (!env.ACCESS_TOKEN) return 503`）
 *   - `""`（配置了但为空）→ **配置错误**：一律拒绝（这是运维失误，不能当"未配置"放过）
 *   - 有值 → 正常校验 Bearer
 */
export type AuthMode = "open" | "broken" | "enforced";

export function authModeOf(configured: string | undefined): AuthMode {
  if (configured === undefined) return "open";
  if (configured === "") return "broken";
  return "enforced";
}

export function checkAccessToken(
  configured: string | undefined,
  header: string | undefined,
): boolean {
  const mode = authModeOf(configured);

  // 配置了但为空串 = 运维失误 → 拒绝一切（绝不静默放行）
  if (mode === "broken") return false;
  if (mode === "open") return true;

  if (!header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  const provided = m[1]!;
  const expected = configured!;
  if (provided.length !== expected.length) return false;
  // 等长比较降低时序侧信道
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}