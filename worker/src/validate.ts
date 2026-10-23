/**
 * 输入校验（纯函数，前后端共用同一套规则）
 * 覆盖验收标准 3（文件格式）、4（空输入）、5（超长阈值）。
 */

import { MAX_INPUT_CHARS } from "./prompt.ts";

export type ValidateResult =
  | { ok: true }
  | { ok: false; error: string; status: 400 | 413 };

/** 校验粘贴/上传得到的纯文本 */
export function validateInput(text: string): ValidateResult {
  if (typeof text !== "string" || text.trim().length === 0) {
    return {
      ok: false,
      error: "内容不能为空，请先粘贴会议文本或上传 .txt / .md 文件。",
      status: 400,
    };
  }
  if (text.length > MAX_INPUT_CHARS) {
    return {
      ok: false,
      error: `内容过长（上限 ${MAX_INPUT_CHARS} 字符，当前 ${text.length}），请分段提交或精简后重试。`,
      status: 413,
    };
  }
  return { ok: true };
}

const SUPPORTED_EXTENSIONS = new Set([".txt", ".md"]);

/**
 * 文件格式校验：仅支持 .txt / .md。
 * 取最后一个扩展名，防止「a.md.exe」这类伪装后缀绕过。
 */
export function isSupportedFile(filename: string): boolean {
  if (!filename) return false;
  const lastDot = filename.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === filename.length - 1) return false;
  const ext = filename.slice(lastDot).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}
