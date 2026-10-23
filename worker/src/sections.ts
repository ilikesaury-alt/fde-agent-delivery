/**
 * 日报结构校验 — 验收标准 1 的兜底
 * 模型偶发漏板块时靠这个发现，避免用户静默拿到残缺日报。
 */

import { REQUIRED_SECTIONS } from "./prompt.ts";

/** 是否包含全部必需板块 */
export function hasAllSections(digest: string): boolean {
  if (typeof digest !== "string" || digest.length === 0) return false;
  return REQUIRED_SECTIONS.every((s) => digest.includes(s));
}

/** 缺失的板块列表（便于日志/排障） */
export function missingSections(digest: string): string[] {
  if (typeof digest !== "string") return [...REQUIRED_SECTIONS];
  return REQUIRED_SECTIONS.filter((s) => !digest.includes(s));
}
