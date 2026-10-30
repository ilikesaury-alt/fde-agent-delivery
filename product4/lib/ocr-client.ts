/**
 * 浏览器端 OCR —— PaddleOCR.js（PP-OCRv5，ONNX Runtime Web）。
 *
 * 为什么换掉 Workers AI 视觉模型（2026-10-29 真实报告实测，同一张扫描件）：
 *   llama-3.2-11b-vision：4 次跑 0 次可用 —— 值错行、指标名认错、整表抄两遍、
 *   提示词被回显、还有 120s 挂死。
 *   PP-OCRv5（本模块）：6/6 行名称+值+单位+参考范围全对，置信度中位 0.99。
 * 更关键的是：PP-OCR 返回**检测框坐标**，可以按坐标做确定性表格重建（见 table-reconstruct.ts）——
 * 错行问题从结构上消失，而不是靠模型「更聪明」。
 *
 * 三条工程约束（都实测过）：
 *   1. `worker: true`：WASM 推理在主线程会把渲染线程占满，页面交互/自动化全部超时
 *   2. 多线程 WASM 需要跨源隔离（COOP/COEP）—— 由 void.config 的 routing.headers 下发
 *   3. SDK + opencv.js 打包 ~10MB：**只在用户真的选扫描件时**动态 import，不拖慢首屏
 *
 * 隐私：图片不上传，识别全程在用户设备上完成（与体检数据的敏感性匹配）。
 */

import type { TableLine } from "./table-reconstruct.ts";

export type OcrEngineMeta = { backend: string; threads: number; version: string };
export type OcrPageOutcome = { lines: TableLine[]; width: number; height: number; ms: number };

/** 模型档位：PP-OCRv5 mobile（det 4.6MB + rec 15.9MB）—— 实测中文表格够用 */
export const OCR_MODEL_VERSION = "PP-OCRv5";
/** ORT 的 wasm 运行时由本仓库自托管（public/ort/，构建前从 node_modules 复制） */
export const OCR_WASM_PATH = "/ort/";

/** SDK 返回的最小形状（避免把整个包的 d.ts 拖进类型推断） */
type PaddleItem = { text?: unknown; score?: unknown; poly?: unknown };

let worker: Worker | null = null;
let initPromise: Promise<void> | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: { image?: unknown; items?: unknown[]; ms: number }) => void; reject: (e: Error) => void }>();
let lastMeta: OcrEngineMeta | null = null;

/** 当前能拿到的线程数：跨源隔离才能用 SharedArrayBuffer（否则 ORT 内部会退化为单线程） */
export function desiredThreads(): number {
  const isolated = typeof globalThis !== "undefined" && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
  if (!isolated) return 1;
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2;
  return Math.max(1, Math.min(4, cores));
}

/**
 * 起 Worker 并初始化引擎（只一次）。
 *
 * 为什么不用 SDK 自带的 `worker: true`：它的 worker 入口是预打包的，内联了 jsep 版 ORT
 * （28.2MB），超过 Cloudflare Workers 静态资源 25MiB 的单文件上限 —— 部署直接失败。
 * 我们自己开 Worker，SDK 在里面 inline 跑，用的是 plain 运行时 14.2MB。
 */
function ensureWorker(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = new Promise<void>((resolve, reject) => {
    try {
      worker = new Worker(new URL("./ocr-worker.ts", import.meta.url), { type: "module" });
    } catch (e) {
      initPromise = null;
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    const threads = desiredThreads();
    const onInit = (ev: MessageEvent) => {
      const d = ev.data as { type: string; error?: string };
      if (d.type === "init-ok") {
        lastMeta = { backend: "wasm", threads, version: OCR_MODEL_VERSION };
        worker?.removeEventListener("message", onInit);
        resolve();
      } else if (d.type === "init-error") {
        worker?.removeEventListener("message", onInit);
        initPromise = null;
        reject(new Error(d.error ?? "OCR 引擎初始化失败"));
      }
    };
    worker.addEventListener("message", onInit);
    worker.addEventListener("error", (ev) => {
      initPromise = null;
      reject(new Error(`OCR worker 启动失败：${ev.message || "unknown"}`));
    });
    worker.addEventListener("message", (ev: MessageEvent) => {
      const d = ev.data as { type?: string; id?: number; ms?: number; image?: unknown; items?: unknown[]; error?: string };
      if (d?.type === "result" || d?.type === "error") {
        const slot = pending.get(Number(d.id));
        if (!slot) return;
        pending.delete(Number(d.id));
        if (d.type === "error") slot.reject(new Error(d.error ?? "识别失败"));
        else slot.resolve({ image: d.image, items: d.items, ms: Number(d.ms) || 0 });
      }
    });
    worker.postMessage({
      type: "init",
      payload: { wasmPaths: OCR_WASM_PATH, numThreads: threads, version: OCR_MODEL_VERSION },
    });
  });
  return initPromise;
}

/** 当前引擎元信息（用于界面提示/日志；未初始化返回 null） */
export function engineMeta(): OcrEngineMeta | null {
  return lastMeta;
}

/** 用户主动取消识别（与真实失败区分：取消不该上红色错误） */
export class OcrCancelledError extends Error {
  constructor() {
    super("已取消识别");
    this.name = "OcrCancelledError";
  }
}

export function isOcrCancelled(e: unknown): boolean {
  return e instanceof OcrCancelledError || (e instanceof Error && e.name === "OcrCancelledError");
}

/**
 * 取消正在进行的识别。
 *
 * 为什么只能**终止 Worker**：WASM 推理是一段同步循环，Worker 里没有消息处理的机会，
 * 发「cancel」消息要等这次推理跑完才轮得到 —— 那就不叫取消了（实测单页 45s）。
 * 代价是引擎一起没了，下次识别要重新初始化（模型已缓存，实测约 3.5s）。
 * 这个代价只在「用户主动放弃」时付一次，比让人干等 45s 划算。
 */
export function cancelOcr(): void {
  for (const [, slot] of pending) slot.reject(new OcrCancelledError());
  pending.clear();
  try {
    worker?.terminate();
  } catch {
    // terminate 失败无所谓：下面的引用重置才是关键（否则下次会复用死掉的 Worker）
  }
  worker = null;
  initPromise = null;
  lastMeta = null;
}

/** SDK 的 items → 我们的 TableLine（纯转换，单测覆盖） */
export function toTableLines(items: PaddleItem[]): TableLine[] {
  const out: TableLine[] = [];
  for (const item of items) {
    const text = typeof item?.text === "string" ? item.text.trim() : "";
    if (text === "") continue;
    const poly = Array.isArray(item.poly) ? (item.poly as Array<[number, number]>) : [];
    const xs = poly.map((p) => Number(p?.[0])).filter((n) => Number.isFinite(n));
    const ys = poly.map((p) => Number(p?.[1])).filter((n) => Number.isFinite(n));
    if (xs.length === 0 || ys.length === 0) continue;
    const score = Number(item.score);
    out.push({
      text,
      score: Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0,
      x0: Math.min(...xs),
      x1: Math.max(...xs),
      y0: Math.min(...ys),
      y1: Math.max(...ys),
    });
  }
  return out;
}

/** 识别一页（坐标以该页图像素为准；推理跑在 Worker 里，主线程不被占） */
export async function recognizePage(image: Blob): Promise<OcrPageOutcome> {
  await ensureWorker();
  const bytes = await image.arrayBuffer();
  const id = ++seq;
  const payload = await new Promise<{ image?: unknown; items?: unknown[]; ms: number }>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker?.postMessage({ type: "recognize", id, payload: { bytes, mime: image.type || "image/jpeg" } }, [bytes]);
  });
  const img = (payload.image ?? {}) as { width?: number; height?: number };
  return {
    lines: toTableLines((payload.items ?? []) as PaddleItem[]),
    width: Number(img.width) || 0,
    height: Number(img.height) || 0,
    ms: payload.ms,
  };
}

/** dataURL → Blob（pdf.js 渲染出来的就是 dataURL） */
export function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body] = dataUrl.split(",");
  const mime = /data:([^;]+)/.exec(head)?.[1] ?? "image/jpeg";
  const binary = atob(body ?? "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
