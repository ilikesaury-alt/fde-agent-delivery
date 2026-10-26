/**
 * 路由共用的 HTTP 辅助：env 解析、存储解析、令牌鉴权、JSON 响应。
 * 抽出来是为了让 generate / jobs 两条路由共用同一套口径（令牌校验只有一处实现）。
 */

import { checkAccessToken } from "./auth.ts";
import { createD1Store, type D1Like, type JobStore } from "./store.ts";
import type { LLMEnv } from "./llm.ts";

export type RouteCtx = {
  env?: Record<string, unknown>;
  /** 测试注入口：替换 fetch（LLM/抓取） */
  _fetchImpl?: typeof fetch;
  /** 测试注入口：替换存储 */
  _store?: JobStore;
};

export type ResolvedEnv = LLMEnv & { ACCESS_TOKEN?: string };

export function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function resolveEnv(c: unknown): ResolvedEnv {
  const e = (c as RouteCtx).env ?? {};
  return {
    MAGPIE_BASE_URL: asString(e.MAGPIE_BASE_URL),
    MAGPIE_API_KEY: asString(e.MAGPIE_API_KEY),
    MAGPIE_MODEL: asString(e.MAGPIE_MODEL),
    ACCESS_TOKEN: asString(e.ACCESS_TOKEN),
  };
}

export function resolveStore(c: unknown): JobStore {
  const ctx = c as RouteCtx;
  if (ctx._store) return ctx._store;
  return createD1Store(ctx.env?.DB as D1Like);
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
