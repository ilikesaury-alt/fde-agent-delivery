import { assert, assertEqual, describe, it } from "./harness.ts";
import { runPipeline, PipelineError, COMPRESS_THRESHOLD, HARD_CAP } from "../lib/pipeline.ts";
import type { PipelineDeps } from "../lib/pipeline.ts";
import type { PipelineEvent } from "../lib/types.ts";

const NOTE_RAW = `[标题]
测试主标题
[备选标题]
备选一
[正文]
这是一段足够长的正文内容，用于通过可用性校验，确保笔记结构完整可用。
[标签]
#标签一 #标签二 #标签三`;

function makeDeps(over: Partial<PipelineDeps> = {}): PipelineDeps & { calls: { compress: number; stream: number } } {
  const calls = { compress: 0, stream: 0 };
  const deps: PipelineDeps = {
    fetchArticle: async () => ({ text: "抓取到的正文内容，长度足够用于测试。", title: "示例标题" }),
    callLLM: async () => {
      calls.compress++;
      return "压缩后的要点";
    },
    streamLLM: async function* () {
      calls.stream++;
      for (const part of [NOTE_RAW.slice(0, 20), NOTE_RAW.slice(20, 60), NOTE_RAW.slice(60)]) {
        yield part;
      }
    },
    ...over,
  };
  return Object.assign(deps, { calls });
}

function collector() {
  const events: PipelineEvent[] = [];
  return { events, emit: (e: PipelineEvent) => void events.push(e) };
}

describe("pipeline — 文本输入的短素材路径", () => {
  it("不压缩、直接生成，事件顺序正确", async () => {
    const deps = makeDeps();
    const { events, emit } = collector();
    const { job } = await runPipeline({ sourceType: "text", text: "一段不太长的素材" }, deps, emit);

    assertEqual(job.status, "succeeded");
    assert(job.note !== null, "应有笔记");
    assertEqual(job.note!.titles[0], "测试主标题");
    assertEqual(job.sourceType, "text");
    assertEqual(job.sourceUrl, null);
    assertEqual(job.materialBrief, null, "短素材不应产生压缩要点");
    assertEqual(deps.calls.compress, 0, "不应调用压缩");

    const steps = events.filter((e) => e.type === "step");
    assertEqual(steps[0], { type: "step", step: "fetch", status: "skipped", detail: "使用粘贴文本" } as PipelineEvent);
    assert(steps.some((s) => s.type === "step" && s.step === "prepare" && s.status === "skipped"), "准备阶段应 skipped");
    assert(steps.some((s) => s.type === "step" && s.step === "generate" && s.status === "started"), "生成应 started");
    assert(steps.some((s) => s.type === "step" && s.step === "generate" && s.status === "done"), "生成应 done");

    const tokens = events.filter((e) => e.type === "token");
    assertEqual(tokens.length, 3, "应转发 3 个增量");
  });

  it("token 事件按序拼接等于完整输出", async () => {
    const deps = makeDeps();
    const { events, emit } = collector();
    await runPipeline({ sourceType: "text", text: "素材" }, deps, emit);
    const joined = events.filter((e) => e.type === "token").map((e) => (e as { text: string }).text).join("");
    assertEqual(joined, NOTE_RAW);
  });
});

describe("pipeline — URL 输入", () => {
  it("抓取成功后 sourceUrl 落库、摘要取正文", async () => {
    const deps = makeDeps();
    const { events, emit } = collector();
    const { job } = await runPipeline({ sourceType: "url", url: "https://example.com/a" }, deps, emit);

    assertEqual(job.sourceUrl, "https://example.com/a");
    assert(job.sourceExcerpt.includes("抓取到的正文"), "摘要应取抓取正文");
    assert(events.some((e) => e.type === "step" && e.step === "fetch" && e.status === "done"), "抓取应 done");
  });

  it("抓取失败 → PipelineError(phase=fetch)，且发出 failed 事件", async () => {
    const deps = makeDeps({
      fetchArticle: async () => {
        throw new Error("无法访问该链接，请改用「粘贴文本」。");
      },
    });
    const { events, emit } = collector();
    const err = await runPipeline({ sourceType: "url", url: "https://example.com/x" }, deps, emit).then(
      () => null,
      (e) => e as PipelineError,
    );
    assert(err !== null, "应抛错");
    assertEqual(err!.phase, "fetch");
    assert(err!.message.includes("粘贴"), "应保留引导文案");
    assert(
      events.some((e) => e.type === "step" && e.step === "fetch" && e.status === "failed"),
      "应发出 failed 事件",
    );
    assert(deps.calls.stream === 0, "抓取失败不应进入生成阶段");
  });
});

describe("pipeline — 超长素材", () => {
  it(`超过 ${COMPRESS_THRESHOLD} 字触发压缩，且用压缩结果做生成输入`, async () => {
    let received = "";
    const long = "长".repeat(COMPRESS_THRESHOLD + 10);
    const deps = makeDeps({
      streamLLM: async function* (messages) {
        received = messages.map((m) => m.content).join("\n");
        yield NOTE_RAW;
      },
    });
    const { events, emit } = collector();
    const { job } = await runPipeline({ sourceType: "text", text: long }, deps, emit);

    assertEqual(deps.calls.compress, 1, "应调用一次压缩");
    assertEqual(job.materialBrief, "压缩后的要点");
    assert(received.includes("压缩后的要点"), "生成阶段应收到压缩要点");
    assert(!received.includes(long.slice(0, 100)), "生成阶段不应再收到原文长文本");
    assert(
      events.some((e) => e.type === "step" && e.step === "prepare" && e.status === "done"),
      "准备阶段应 done",
    );
  });

  it(`超过硬上限 ${HARD_CAP} 字 → 友好报错且不调用 LLM`, async () => {
    const deps = makeDeps();
    const { emit } = collector();
    const err = await runPipeline({ sourceType: "text", text: "长".repeat(HARD_CAP + 1) }, deps, emit).then(
      () => null,
      (e) => e as PipelineError,
    );
    assert(err !== null);
    assert(err!.message.includes("过长"), `应提示过长，实际：${err!.message}`);
    assertEqual(deps.calls.compress, 0, "不应调用压缩");
    assertEqual(deps.calls.stream, 0, "不应调用生成");
  });

  it("压缩失败 → PipelineError(phase=prepare)", async () => {
    const deps = makeDeps({
      callLLM: async () => {
        throw new Error("AI 服务暂不可用，请检查配置或稍后重试。");
      },
    });
    const { emit } = collector();
    const err = await runPipeline(
      { sourceType: "text", text: "长".repeat(COMPRESS_THRESHOLD + 1) },
      deps,
      emit,
    ).then(
      () => null,
      (e) => e as PipelineError,
    );
    assertEqual(err?.phase, "prepare");
  });
});

describe("pipeline — 异常与兜底", () => {
  it("空素材 → 报错", async () => {
    const deps = makeDeps();
    const { emit } = collector();
    const err = await runPipeline({ sourceType: "text", text: "   " }, deps, emit).then(
      () => null,
      (e) => e as PipelineError,
    );
    assert(err !== null);
    assert(err!.message.includes("为空"));
  });

  it("模型输出结构不可用 → 报「未能生成结构完整的笔记」", async () => {
    const deps = makeDeps({
      streamLLM: async function* () {
        yield "抱歉，我无法完成这个任务。";
      },
    });
    const { emit } = collector();
    const err = await runPipeline({ sourceType: "text", text: "素材" }, deps, emit).then(
      () => null,
      (e) => e as PipelineError,
    );
    assert(err !== null, "应抛错");
    assert(err!.message.includes("结构完整"), `实际：${err!.message}`);
  });

  it("流式生成中途失败 → PipelineError(phase=generate)", async () => {
    const deps = makeDeps({
      streamLLM: async function* () {
        yield "[标题]\n半截";
        throw new Error("AI 服务暂不可用，请稍后重试。");
      },
    });
    const { emit } = collector();
    const err = await runPipeline({ sourceType: "text", text: "素材" }, deps, emit).then(
      () => null,
      (e) => e as PipelineError,
    );
    assertEqual(err?.phase, "generate");
  });

  it("variation=true 会传到 prompt（换一版不是空操作）", async () => {
    let received = "";
    const deps = makeDeps({
      streamLLM: async function* (messages) {
        received = messages.map((m) => m.content).join("\n");
        yield NOTE_RAW;
      },
    });
    const { emit } = collector();
    await runPipeline({ sourceType: "text", text: "素材", variation: true }, deps, emit);
    assert(received.includes("换一个开头钩子"), "应带扰动提示");
  });
});

describe("pipeline — 对抗审查反例", () => {
  it("压缩结果仍超硬上限 → 友好报错（验收 5 后半段）", async () => {
    const deps = makeDeps({
      callLLM: async () => "要".repeat(HARD_CAP + 1),
    });
    const { emit } = collector();
    const err = await runPipeline(
      { sourceType: "text", text: "长".repeat(COMPRESS_THRESHOLD + 1) },
      deps,
      emit,
    ).then(
      () => null,
      (e) => e as PipelineError,
    );
    assert(err !== null, "应抛错");
    assertEqual(err!.phase, "prepare");
    assert(err!.message.includes("上限"), `实际：${err!.message}`);
    assertEqual(deps.calls.stream, 0, "不应进入生成阶段");
  });

  it("非自定义异常不上屏（不泄露英文内部文案）", async () => {
    const deps = makeDeps({
      streamLLM: async function* () {
        yield "";
        throw new Error("The operation was aborted");
      },
    });
    const { emit } = collector();
    const err = await runPipeline({ sourceType: "text", text: "素材" }, deps, emit).then(
      () => null,
      (e) => e as PipelineError,
    );
    assert(err!.message.includes("生成失败"), `应使用兜底文案，实际：${err!.message}`);
    assert(!err!.message.includes("aborted"), "不应透出原始英文错误");
  });

  it("正文长度/标签数越界时给出 warning（不阻断生成）", async () => {
    const deps = makeDeps({
      streamLLM: async function* () {
        yield `[标题]\n短标题\n[正文]\n${"太短".repeat(10)}\n[标签]\n#只有一个`;
      },
    });
    const { emit } = collector();
    const { warnings } = await runPipeline({ sourceType: "text", text: "素材" }, deps, emit);
    assert(warnings.some((w) => w.includes("正文长度")), `应有正文长度提示：${warnings.join("|")}`);
    assert(warnings.some((w) => w.includes("标签")), `应有标签提示：${warnings.join("|")}`);
  });

  it("合规输出不产生 warning", async () => {
    const good = `[标题]\n合规标题\n[备选标题]\n备选一\n[正文]\n${"这是一段合规长度的正文，包含 emoji 🌟 并且足够长。".repeat(12)}\n[标签]\n#a #b #c`;
    const deps = makeDeps({
      streamLLM: async function* () {
        yield good;
      },
    });
    const { emit } = collector();
    const { warnings } = await runPipeline({ sourceType: "text", text: "素材" }, deps, emit);
    assertEqual(warnings.filter((w) => w.includes("正文长度")), []);
    assertEqual(warnings.filter((w) => w.includes("标签只有")), []);
  });
});
