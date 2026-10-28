/**
 * 路由共用的 HTTP 辅助：env 解析、存储/向量/AI 解析、令牌鉴权、JSON 响应。
 *
 * 为什么都从 ctx 解析而不是模块级单例：测试要能注入替身（`_repo` / `_index` / `_ai`），
 * 否则本地永远只能测纯函数（产品② 的 shim 模式证明这条路可行且必要）。
 */

import { checkAccessToken } from "./auth.ts";
import { DEFAULT_OCR_MODEL } from "./ocr.ts";
import { DEFAULT_HYBRID, DEFAULT_MIN_SCORE, DEFAULT_TOP_K, type RetrieveOptions } from "./retrieve.ts";
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
  /** 测试注入口：Vectorize 最终一致性的重试参数 */
  _verify?: { attempts?: number; baseDelayMs?: number };
};

export type ResolvedEnv = LLMEnv & {
  ACCESS_TOKEN?: string;
  RETRIEVE_TOP_K?: string;
  RETRIEVE_MIN_SCORE?: string;
  /** "0" 关闭关键词通道（消融开关，见 CONTEXT A3） */
  HYBRID_ENABLED?: string;
  /** "0" 关闭多轮规则改写（消融开关，见 CONTEXT D18） */
  CONTEXT_REWRITE?: string;
  /** 覆盖 OCR 视觉模型（默认 @cf/moondream/moondream3.1-9B-A2B） */
  OCR_MODEL?: string;
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
    HYBRID_ENABLED: asString(e.HYBRID_ENABLED),
    CONTEXT_REWRITE: asString(e.CONTEXT_REWRITE),
    OCR_MODEL: asString(e.OCR_MODEL),
  };
}

/** 环境变量开关：只认 "0"/"false"/"off" 为关闭，其余（含未配置）一律开启 */
function flag(v: string | undefined, fallback: boolean): boolean {
  if (v == null || v === "") return fallback;
  return !/^(0|false|off|no)$/i.test(v.trim());
}

export type FeatureFlags = {
  /** 关键词通道（A3 消融开关） */
  hybrid: boolean;
  /** 多轮规则改写（D18 消融开关） */
  contextRewrite: boolean;
  /** OCR 视觉模型（D21） */
  ocrModel: string;
};

export function resolveFlags(c: unknown): FeatureFlags {
  const e = resolveEnv(c);
  return {
    hybrid: flag(e.HYBRID_ENABLED, DEFAULT_HYBRID),
    contextRewrite: flag(e.CONTEXT_REWRITE, true),
    ocrModel: e.OCR_MODEL?.trim() || DEFAULT_OCR_MODEL,
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
export function resolveRetrieveOptions(c: unknown): RetrieveOptions {
  const e = resolveEnv(c);
  const topK = Number(e.RETRIEVE_TOP_K);
  const minScore = Number(e.RETRIEVE_MIN_SCORE);
  return {
    topK: Number.isFinite(topK) && topK > 0 ? Math.min(Math.trunc(topK), 20) : DEFAULT_TOP_K,
    minScore: Number.isFinite(minScore) && minScore >= 0 && minScore <= 1 ? minScore : DEFAULT_MIN_SCORE,
    hybrid: flag(e.HYBRID_ENABLED, DEFAULT_HYBRID),
  };
}
