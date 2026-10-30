/**
 * 我们自己的 Web Worker：在**Worker 线程**里跑 PaddleOCR 的非 worker 管线。
 *
 * 为什么不直接用 SDK 的 `worker: true`（实测踩到硬墙）：
 *   SDK 的 worker 入口是**预打包**的（`dist/assets/worker-entry-*.js`），ONNX Runtime 已经内联进去，
 *   用的是 jsep 版运行时 **28.2MB**。Cloudflare Workers 静态资源单文件上限 25MiB →
 *   部署直接报 `Asset too large`（真报错，不是猜的）。
 *   而 SDK 的非 worker 管线走的是包引用，能被 Vite 解析到 `onnxruntime-web/wasm` 的
 *   **plain 运行时 14.2MB**（合法）。所以：自己开 Worker + 让 SDK 在 Worker 里 inline 跑。
 *
 * 另一个必须这么做的理由：WASM 推理在主线程会把渲染线程占满（实测页面 evaluate 全超时），
 * 所以既不能放主线程，也不能用 SDK 自带的 worker（体积超限）。
 */

/**
 * ⚠️ 这里**不能**在顶层 import SDK：opencv-js / SDK 的浏览器适配层在模块初始化时就会摸
 * `document`（实测 Worker 里报 `document is not defined`）。所以先打 shim，再动态 import。
 *
 * shim 只覆盖它们真正用到的几处：
 *   - `document.createElement("canvas")` → OffscreenCanvas（Worker 里唯一可用的画布）
 *   - 其余 DOM 元素 → 无害空对象（appendChild/setAttribute/remove 都是 no-op）
 * 不模拟完整 DOM（那会让「在 Worker 里跑」变成假装）：如果 SDK 真的需要真实 DOM 布局，
 * 这个 shim 会立刻暴露出来而不是静默算错。
 */
type AnyObj = Record<string, unknown>;

function needsDomStub(): boolean {
  return typeof (globalThis as AnyObj).document === "undefined";
}

function installDomStub(): void {
  const g = globalThis as AnyObj;
  if (!needsDomStub()) return;
  const fakeElement = (tag: string): AnyObj => {
    if (tag === "canvas" && typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(1, 1) as unknown as AnyObj;
    return {
      tagName: tag.toUpperCase(),
      style: {},
      width: 0,
      height: 0,
      appendChild: () => undefined,
      removeChild: () => undefined,
      setAttribute: () => undefined,
      remove: () => undefined,
      getContext: () => null,
      toDataURL: () => "",
    };
  };
  g.document = {
    createElement: fakeElement,
    createElementNS: (_ns: string, tag: string) => fakeElement(tag),
    documentElement: { style: {} },
    head: fakeElement("head"),
    body: fakeElement("body"),
    querySelector: () => null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  g.window = g.window ?? g;

  /**
   * DOM 构造器**占位**（不是实现）：
   * opencv-js 的 `cv.imread` 里直接写了 `source instanceof HTMLImageElement ||
   * source instanceof HTMLCanvasElement ...`，Worker 里这些名字不存在 → ReferenceError
   * （栈顶就是 `n.imread`）。给个空类让 `instanceof` 有东西可比，且**恒为 false** ——
   * 真正的图像来源由调用方决定（我们传 Blob / ImageBitmap）。
   */
  for (const name of ["HTMLImageElement", "HTMLCanvasElement", "HTMLVideoElement", "SVGImageElement"]) {
    if (typeof g[name] === "undefined") g[name] = class {};
  }
}

installDomStub();

/** 动态 import：必须在 shim 之后执行 */
async function loadSdk(): Promise<{ PaddleOCR: { create: (o: unknown) => Promise<unknown> } }> {
  const mod = (await import("@paddleocr/paddleocr-js")) as unknown as {
    PaddleOCR: { create: (o: unknown) => Promise<unknown> };
  };
  return mod;
}

type InitMsg = { type: "init"; payload: { wasmPaths: string; numThreads: number; version: string } };
type RecognizeMsg = { type: "recognize"; id: number; payload: { bytes: ArrayBuffer; mime: string } };
type InMsg = InitMsg | RecognizeMsg;

type PaddleEngine = {
  predict(image: Blob, params?: Record<string, unknown>): Promise<
    Array<{ image?: { width?: number; height?: number }; items?: unknown[] }>
  >;
};

let enginePromise: Promise<PaddleEngine> | null = null;

async function createEngine(payload: InitMsg["payload"]): Promise<PaddleEngine> {
  const { PaddleOCR } = await loadSdk();
  return (await PaddleOCR.create({
    lang: "ch",
    ocrVersion: payload.version,
    // 在这里**已经**是 Worker 线程，再让 SDK 开 worker 只会撞上内联 jsep 体积问题
    worker: false,
    textDetectionBatchSize: 1,
    textRecognitionBatchSize: 8,
    ortOptions: {
      backend: "wasm",
      wasmPaths: payload.wasmPaths,
      numThreads: payload.numThreads,
      simd: true,
    },
  })) as unknown as PaddleEngine;
}

self.onmessage = async (event: MessageEvent<InMsg>) => {
  const msg = event.data;
  if (msg.type === "init") {
    try {
      enginePromise = createEngine(msg.payload);
      await enginePromise;
      enginePromise = enginePromise.catch(() => {
        throw new Error("init failed");
      });
      self.postMessage({ type: "init-ok" });
    } catch (e) {
      enginePromise = null;
      self.postMessage({ type: "init-error", error: e instanceof Error ? e.message : String(e) });
    }
    return;
  }

  if (msg.type === "recognize") {
    try {
      if (!enginePromise) throw new Error("engine 未初始化");
      const engine = await enginePromise;
      const blob = new Blob([msg.payload.bytes], { type: msg.payload.mime });
      const t0 = Date.now();
      const results = await engine.predict(blob);
      const first = results?.[0];
      self.postMessage({
        type: "result",
        id: msg.id,
        ms: Date.now() - t0,
        image: first?.image ?? null,
        items: first?.items ?? [],
      });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      // 带上栈：Worker 里的失败经常是「某个浏览器全局不存在」，只有栈能定位
      self.postMessage({
        type: "error",
        id: msg.id,
        error: [err.message, ...(err.stack ?? "").split("\n").slice(0, 4)].join(" ⏎ "),
      });
    }
  }
};