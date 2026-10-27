/**
 * 路由共用的 HTTP 辅助：env 解析、存储/向量/AI 解析、令牌鉴权、JSON 响应。
 *
 * 为什么都从 ctx 解析而不是模块级单例：测试要能注入替身（`_repo` / `_index` / `_ai`），
 * 否则本地永远只能测纯函数（产品② 的 shim 模式证明这条路可行且必要）。
 */

import { checkAccessToken } from "./auth.ts";
import type { AILike } from "./embed.ts";
import type { LLMEnv } from "./llm.ts";
import { createD1Repo, createVectorizeIndex, type D1Like, type Repo, type VectorIndex, type VectorizeLike } from "./repo.ts";

export type RouteCtx = {
  env?: Record<string, unknown>;
  /** 测试注入口：替换 fetch（LLM/抓取） */
  _fetchImpl?: typeof fetch;
  /** 测试注入口：替换存储 */
  _repo?: Repo;
  /** 测试注入口：替换向量索引 */
  _index?: VectorIndex;
  /** 测试注入口：替换嵌入模型 */
  _ai?: AILike;
};

export type ResolvedEnv = LLMEnv & {
  ACCESS_TOKEN?: string;
  RETRIEVE_TOP_K?: string;
  RETRIEVE_MIN_SCORE?: string;
};

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
    RETRIEVE_TOP_K: asString(e.RETRIEVE_TOP_K),
    RETRIEVE_MIN_SCORE: asString(e.RETRIEVE_MIN_SCORE),
  };
}

export function resolveRepo(c: unknown): Repo {
  const ctx = c as RouteCtx;
  if (ctx._repo) return ctx._repo;
  return createD1Repo(ctx.env?.DB as D1Like);
}

export function resolveIndex(c: unknown): VectorIndex {
  const ctx = c as RouteCtx;
  if (ctx._index) return ctx._index;
  return createVectorizeIndex(ctx.env?.VEC as VectorizeLike);
}

export function resolveAi(c: unknown): AILike {
  const ctx = c as RouteCtx;
  if (ctx._ai) return ctx._ai;
  // 绑定缺失时给出明确错误，而不是 undefined is not a function
  const ai = ctx.env?.AI as AILike | undefined;
  if (!ai) throw new Error("Workers AI 绑定缺失（env.AI），请检查部署绑定。");
  return ai;
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

/** 解析检索参数（env 可覆盖，便于评测扫阈值） */
export function resolveRetrieveOptions(c: unknown): { topK: number; minScore: number } {
  const e = resolveEnv(c);
  const topK = Number(e.RETRIEVE_TOP_K);
  const minScore = Number(e.RETRIEVE_MIN_SCORE);
  return {
    topK: Number.isFinite(topK) && topK > 0 ? Math.min(Math.trunc(topK), 20) : 6,
    minScore: Number.isFinite(minScore) && minScore >= 0 && minScore <= 1 ? minScore : 0.35,
  };
}
