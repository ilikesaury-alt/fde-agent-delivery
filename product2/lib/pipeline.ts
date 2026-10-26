/**
 * 流水线编排：抓取 → 素材准备 → 生成笔记。
 *
 * 三个特性决定了这个模块的形状：
 *  1. **依赖注入**（fetch/LLM 都从参数进）→ 单测与 Node shim 不需要网络；
 *  2. **阶段间用数据结构衔接**（不共享可变状态）→ 任一阶段可单独测；
 *  3. **每个阶段边界都 emit 事件** → 用户在首个 token 到达前的等待期（实测可达 20s+）有可见反馈。
 *
 * 不落库：落库在路由层完成（流式失败时不产生半截记录，见 CONTEXT 高风险点 5）。
 */

import { buildCompressMessages, buildNoteMessages } from "./prompt.ts";
import { isUsableNote, parseNote } from "./note.ts";
import type { ChatMessage } from "./llm.ts";
import type { GenerationJob, PipelineEvent, SourceType, XhsNote } from "./types.ts";

/** 超过此长度先压缩成要点（约 6000 字 ≈ 8000 token，已超出"一次调用写好笔记"的舒适区） */
export const COMPRESS_THRESHOLD = 6000;
/** 硬上限：再大就没法可靠压缩，直接拒绝并要求用户精简 */
export const HARD_CAP = 30_000;

export type PipelineDeps = {
  /** URL → 正文；测试可注入假实现 */
  fetchArticle: (url: string) => Promise<{ text: string; title: string }>;
  /** 非流式（压缩要点） */
  callLLM: (messages: ChatMessage[]) => Promise<string>;
  /** 流式（生成笔记正文） */
  streamLLM: (messages: ChatMessage[]) => AsyncGenerator<string, void, unknown>;
};

export type PipelineInput = {
  sourceType: SourceType;
  url?: string;
  text?: string;
  /** 重新生成：换开头钩子，避免两次一模一样 */
  variation?: boolean;
};

export type PipelineOutcome = {
  job: GenerationJob;
  /** 非致命提示（正文长度/标签数越界、解析修正），走 done.warning 告知用户 */
  warnings: string[];
};

/** 流水线用户可见错误：message 直接上屏 */
export class PipelineError extends Error {
  phase: "fetch" | "prepare" | "generate";
  constructor(phase: "fetch" | "prepare" | "generate", message: string) {
    super(message);
    this.name = "PipelineError";
    this.phase = phase;
  }
}

export function newJobId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // 兜底（极老运行时）：时间戳 + 随机
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function excerptOf(text: string, n = 100): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

/**
 * 执行流水线。
 * @param emit 事件回调（路由层转成 SSE；测试层收集成数组）
 */
export async function runPipeline(
  input: PipelineInput,
  deps: PipelineDeps,
  emit: (e: PipelineEvent) => void | Promise<void>,
): Promise<PipelineOutcome> {
  // ---------- 1. 抓取 ----------
  let material: string;
  let sourceUrl: string | null = null;

  if (input.sourceType === "url") {
    const url = (input.url ?? "").trim();
    await emit({ type: "step", step: "fetch", status: "started" });
    try {
      const article = await deps.fetchArticle(url);
      material = article.text;
      sourceUrl = url;
      await emit({
        type: "step",
        step: "fetch",
        status: "done",
        detail: `已抓取 ${material.length.toLocaleString("zh-CN")} 字${article.title ? ` · ${article.title.slice(0, 30)}` : ""}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "抓取失败，请改用「粘贴文本」。";
      await emit({ type: "step", step: "fetch", status: "failed", detail: msg });
      throw new PipelineError("fetch", msg);
    }
  } else {
    material = (input.text ?? "").trim();
    await emit({ type: "step", step: "fetch", status: "skipped", detail: "使用粘贴文本" });
  }

  if (!material) {
    throw new PipelineError("fetch", "素材为空，请粘贴文本或提供链接。");
  }
  if (material.length > HARD_CAP) {
    const msg = `素材过长（${material.length.toLocaleString("zh-CN")} 字，上限 ${HARD_CAP.toLocaleString("zh-CN")} 字），请截取重点后重试。`;
    await emit({ type: "step", step: "prepare", status: "failed", detail: msg });
    throw new PipelineError("prepare", msg);
  }

  // ---------- 2. 素材准备（超长才压缩） ----------
  let brief: string | null = null;
  let promptMaterial = material;
  const warnings: string[] = [];

  if (material.length > COMPRESS_THRESHOLD) {
    await emit({
      type: "step",
      step: "prepare",
      status: "started",
      detail: `素材 ${material.length.toLocaleString("zh-CN")} 字，正在压缩要点…`,
    });
    try {
      brief = await deps.callLLM(buildCompressMessages(material));
      // 压缩后再校硬上限：模型可能返回超长「要点」，不拦就会把超长 prompt 送进生成，
      // 上游 400/413 会被归成「AI 服务暂不可用」，与验收要求的友好文案不符。
      if (brief.length > HARD_CAP) {
        const msg = `压缩结果仍过长（${brief.length.toLocaleString("zh-CN")} 字，上限 ${HARD_CAP.toLocaleString("zh-CN")} 字），请截取重点后重试。`;
        await emit({ type: "step", step: "prepare", status: "failed", detail: msg });
        throw new PipelineError("prepare", msg);
      }
      promptMaterial = brief;
      await emit({
        type: "step",
        step: "prepare",
        status: "done",
        detail: `已压缩为 ${brief.length.toLocaleString("zh-CN")} 字要点`,
      });
    } catch (err) {
      if (err instanceof PipelineError) throw err;
      const msg = "素材压缩失败，请稍后重试。";
      await emit({ type: "step", step: "prepare", status: "failed", detail: msg });
      throw new PipelineError("prepare", msg);
    }
  } else {
    await emit({ type: "step", step: "prepare", status: "skipped", detail: "素材长度无需压缩" });
  }

  // ---------- 3. 生成笔记 ----------
  await emit({ type: "step", step: "generate", status: "started" });
  let raw = "";
  try {
    for await (const delta of deps.streamLLM(
      buildNoteMessages({ material: promptMaterial, variation: input.variation }),
    )) {
      raw += delta;
      await emit({ type: "token", text: delta });
    }
  } catch (err) {
    // 只把自定义错误的文案上屏；其它原始异常（DOMException / TypeError）统一兜底，
    // 否则英文内部文案会透到前端
    const msg = err instanceof PipelineError ? err.message : "生成失败，请稍后重试。";
    await emit({ type: "step", step: "generate", status: "failed", detail: msg });
    throw new PipelineError("generate", msg);
  }

  const { note, issues } = parseNote(raw);
  if (!isUsableNote(note)) {
    const msg = "未能生成结构完整的笔记，请重试一次。";
    await emit({ type: "step", step: "generate", status: "failed", detail: msg });
    throw new PipelineError("generate", msg);
  }

  // 验收 2 的量化区间在这里做非致命校验：越界不报错（模型波动），但通过 warning 告知
  if (note.body.length < 255 || note.body.length > 690) {
    warnings.push(`正文长度 ${note.body.length} 字，超出建议区间 300–600 字。`);
  }
  if (note.tags.length < 3) warnings.push(`话题标签只有 ${note.tags.length} 个，建议 3–6 个。`);
  if (!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(note.body)) {
    warnings.push("正文未使用 emoji，可读性可能偏弱。");
  }

  await emit({
    type: "step",
    step: "generate",
    status: "done",
    detail: `已生成 ${note.titles.length} 个标题 · ${note.body.length} 字正文 · ${note.tags.length} 个标签`,
  });

  const job: GenerationJob = {
    id: newJobId(),
    createdAt: Date.now(),
    sourceType: input.sourceType,
    sourceUrl,
    sourceExcerpt: excerptOf(material),
    sourceText: material,
    materialBrief: brief,
    note: note satisfies XhsNote,
    status: "succeeded",
    error: null,
  };
  // issues 仅内部排查用（不进入存储口径）：非致命解析修正记入 warning
  for (const issue of issues) warnings.push(issue);

  return { job, warnings };
}
