/**
 * 路由共用小工具：env 解析、JSON 响应、令牌鉴权。
 * 与产品②③④ 同口径（独立副本）。
 */
import { authModeOf, checkAccessToken } from "./auth.ts";
import { createD1Store, type D1Like, type Store } from "./store.ts";

export type RadarEnv = {
  MAGPIE_BASE_URL?: string;
  MAGPIE_API_KEY?: string;
  MAGPIE_MODEL?: string;
  ACCESS_TOKEN?: string;
  FEED_MAX_ITEMS?: string;
  FEED_TIMEOUT_MS?: string;
};

export type RouteCtx = {
  env?: Record<string, unknown>;
  /** 测试注入口：替换 fetch（抓取/LLM） */
  _fetchImpl?: typeof fetch;
  /** 测试注入口：替换存储 */
  _store?: Store;
};

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function resolveEnv(c: unknown): RadarEnv {
  const e = (c as RouteCtx).env ?? {};
  return {
    MAGPIE_BASE_URL: asString(e.MAGPIE_BASE_URL),
    MAGPIE_API_KEY: asString(e.MAGPIE_API_KEY),
    MAGPIE_MODEL: asString(e.MAGPIE_MODEL),
    ACCESS_TOKEN: asString(e.ACCESS_TOKEN),
    FEED_MAX_ITEMS: asString(e.FEED_MAX_ITEMS),
    FEED_TIMEOUT_MS: asString(e.FEED_TIMEOUT_MS),
  };
}

export function resolveFetchImpl(c: unknown): typeof fetch | undefined {
  return (c as RouteCtx)._fetchImpl;
}

/**
 * 解析存储层：优先测试注入 → 其次 D1 绑定 → 都没有则 **null（降级为不落库）**。
 * 为什么不抛错：增量 1 的部署没有 D1 也应当能跑（抓取本身有价值）；
 * 路由层会把「没落库」作为显式状态返回，而不是静默当成已保存。
 */
export function resolveStore(c: unknown): Store | null {
  const ctx = c as RouteCtx;
  if (ctx._store) return ctx._store;
  const db = ctx.env?.DB as D1Like | undefined;
  return db ? createD1Store(db) : null;
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** 令牌校验；返回非 null 表示应直接返回该响应 */
export function authorize(c: unknown, header: string | undefined): Response | null {
  const { ACCESS_TOKEN } = resolveEnv(c);
  const mode = authModeOf(ACCESS_TOKEN);
  // 审查 B-1：配置了但为空串 = 运维失误，明确报「配置错误」而不是含糊的「令牌错误」
  if (mode === "broken") {
    return jsonResponse(503, { error: "服务端 ACCESS_TOKEN 配置为空，已拒绝所有请求（请重新配置）。" });
  }
  if (!checkAccessToken(ACCESS_TOKEN, header)) {
    return jsonResponse(401, { error: "访问令牌缺失或错误。" });
  }
  return null;
}

/** 当前鉴权模式（供 /api/health 暴露，让运维一眼看出「当前无鉴权」） */
export function authMode(c: unknown): "open" | "broken" | "enforced" {
  return authModeOf(resolveEnv(c).ACCESS_TOKEN);
}

/** 解析正整数环境变量（非法则回退默认值，不抛） */
export function intEnv(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}