/**
 * 路由共用 HTTP 辅助：env 解析、存储解析、令牌鉴权、JSON 响应。
 *
 * 与②③ 同口径：全部从 ctx 解析而不是模块级单例，测试可注入替身（`_repo` / `_fetchImpl`），
 * 否则本地只能测纯函数。
 */

import { checkAccessToken } from "./auth.ts";
import { createD1Repo, type D1Like, type Repo } from "./repo.ts";
import type { LLMEnv } from "./llm.ts";

export type RouteCtx = {
  env?: Record<string, unknown>;
  /** 测试注入口：替换 fetch（LLM/OCR） */
  _fetchImpl?: typeof fetch;
  /** 测试注入口：替换存储 */
  _repo?: Repo;
};

export type ResolvedEnv = LLMEnv & {
  ACCESS_TOKEN?: string;
  OCR_MODEL?: string;
  MAX_REPORT_CHARS?: string;
  EXTRACT_RETRY?: string;
};

/** 入库时接受的原文上限（比抽取上限略宽：抽取会失败但原文仍值得留档） */
export const MAX_STORED_RAW_CHARS = 200_000;

/** 单字段长度上限（指标名/值/单位/片段）—— 防超长垃圾进库后被喂进解读 prompt */
export const MAX_FIELD_CHARS = 200;

/** 首发单人自用（CONTEXT D1）：多成员档案只预留表字段，不做 UI */
export const ACTIVE_PROFILE = "default";

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
    OCR_MODEL: asString(e.OCR_MODEL),
    MAX_REPORT_CHARS: asString(e.MAX_REPORT_CHARS),
    EXTRACT_RETRY: asString(e.EXTRACT_RETRY),
  };
}

export function resolveRepo(c: unknown): Repo {
  const ctx = c as RouteCtx;
  if (ctx._repo) return ctx._repo;
  return createD1Repo(ctx.env?.DB as D1Like);
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

/** 数字型 env 参数（非法/缺省时回落默认值） */
export function envInt(v: string | undefined, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}