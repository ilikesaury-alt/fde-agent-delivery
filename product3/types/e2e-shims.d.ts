/** 本地 E2E 替身（.mjs）的类型声明：只给单测 import 用，不参与构建产物 */

declare module "*/d1-shim.mjs" {
  import type { D1Like } from "../lib/repo.ts";
  export function createD1Shim(path?: string): D1Like & { __database: unknown };
}

declare module "*/ai-shim.mjs" {
  export const EMBED_DIM: number;
  export const EMBED_MODEL: string;
  export const OCR_MODEL: string;
  export function tokenize(text: string): string[];
  export function fakeEmbed(text: string): number[];
  export function createAIshim(): {
    calls: Array<{ model: string; count: number }>;
    run(model: string, input: Record<string, unknown>): Promise<unknown>;
  };
}