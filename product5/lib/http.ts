/**
 * 路由共用小工具：env 解析、JSON 响应、令牌鉴权。
 * 与产品②③④ 同口径（独立副本）。
 */
import { checkAccessToken } from "./auth.ts";

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

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** 令牌校验；返回非 null 表示应直接返回该响应 */
export function authorize(c: unknown, header: string | undefined): Response | null {
  const { ACCESS_TOKEN } = resolveEnv(c);
  if (!checkAccessToken(ACCESS_TOKEN, header)) {
    return jsonResponse(401, { error: "访问令牌缺失或错误。" });
  }
  return null;
}

/** 解析正整数环境变量（非法则回退默认值，不抛） */
export function intEnv(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}