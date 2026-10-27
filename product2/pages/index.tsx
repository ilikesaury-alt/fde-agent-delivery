"use client";

/**
 * 生成工作台。
 * 布局：左侧素材输入（未加工，等宽体）/ 右侧成品笔记（衬线体）。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { NoteCard } from "../components/NoteCard.tsx";
import { StepTimeline, type StepState } from "../components/StepTimeline.tsx";
import { HistoryPanel } from "../components/HistoryPanel.tsx";
import { consumeGenerateStream } from "../lib/client-stream.ts";
import { previewBody } from "../lib/note.ts";
import type { GenerationJob, PipelineStep, XhsNote } from "../lib/types.ts";

type Mode = "url" | "text";

const STEP_ORDER: PipelineStep[] = ["fetch", "prepare", "generate"];

function initialSteps(): Record<PipelineStep, StepState> {
  return {
    fetch: { step: "fetch", status: "skipped" },
    prepare: { step: "prepare", status: "skipped" },
    generate: { step: "generate", status: "skipped" },
  };
}

export default function WorkspacePage() {
  const [token, setToken] = useState("");
  // token 从 localStorage 恢复是 useEffect 里做的，首帧恒为 ""；
  // 若历史面板在此时发请求，会先吃一个 401 并在界面上闪一下错误。
  const [tokenReady, setTokenReady] = useState(false);
  const [mode, setMode] = useState<Mode>("url");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState(initialSteps);
  const [rawBuffer, setRawBuffer] = useState("");
  const [note, setNote] = useState<XhsNote | null>(null);
  const [titleIndex, setTitleIndex] = useState(0);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [lastSource, setLastSource] = useState<{ sourceType: Mode; url?: string; text?: string } | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const abortRef = useRef<{ cancelled: boolean; controller: AbortController } | null>(null);

  useEffect(() => {
    setToken(window.localStorage.getItem("cs_token") || "");
    setTokenReady(true);
  }, []);

  const canSubmit = !running && (mode === "url" ? url.trim().length > 4 : text.trim().length > 0);

  const run = useCallback(
    async (input: { sourceType: Mode; url?: string; text?: string; variation?: boolean }) => {
      // 并发守卫：生成中再点「重新生成 / 确认提交」会让两个流的 token 交错拼在一起
      if (abortRef.current) return;

      setRunning(true);
      setError(null);
      setWarning(null);
      setRawBuffer("");
      setNote(null);
      setTitleIndex(0);
      setSteps(initialSteps());
      setLastSource({ sourceType: input.sourceType, url: input.url, text: input.text });

      const local = { cancelled: false, controller: new AbortController() };
      abortRef.current = local;

      try {
        await consumeGenerateStream(
          {
            sourceType: input.sourceType,
            url: input.url,
            text: input.text,
            variation: input.variation,
          },
          token,
          {
            onStep: (s) => {
              if (local.cancelled) return;
              setSteps((prev) => ({ ...prev, [s.step]: s }));
            },
            onToken: (t) => {
              if (local.cancelled) return;
              setRawBuffer((prev) => prev + t);
            },
            onDone: (payload) => {
              if (local.cancelled) return;
              const job = payload.job as GenerationJob;
              setNote(job.note);
              setTitleIndex(0);
              const msgs = [payload.warning, ...(payload.warnings ?? [])].filter(Boolean) as string[];
              if (msgs.length) setWarning(msgs.join(" "));
              setHistoryVersion((v) => v + 1);
            },
            onError: (payload) => {
              if (local.cancelled) return;
              setError({ message: payload.message, hint: payload.hint });
            },
          },
          { signal: local.controller.signal },
        );
      } catch {
        if (!local.cancelled) setError({ message: "网络异常，请检查连接后重试。" });
      } finally {
        // 终态保证：无论成功/失败/取消/异常，必须退出「生成中」，
        // 否则按钮永久禁用直到刷新（早期版本只在 onDone/onError 里置 false）。
        if (abortRef.current === local) {
          abortRef.current = null;
          setRunning(false);
        }
      }
    },
    [token],
  );

  const onCancel = () => {
    const cur = abortRef.current;
    if (!cur) return;
    cur.cancelled = true;
    cur.controller.abort();
    abortRef.current = null;
    setRunning(false);
    setError({ message: "已取消本次生成。" });
  };

  const onSubmit = () => {
    if (!canSubmit) return;
    void run(
      mode === "url"
        ? { sourceType: "url", url: url.trim() }
        : { sourceType: "text", text },
    );
  };

  const onRegenerate = () => {
    if (!lastSource || running) return;
    void run({ ...lastSource, variation: true });
  };

  const liveNote: XhsNote = { titles: [], body: previewBody(rawBuffer), tags: [] };
  const showLive = running && !note && liveNote.body.length > 0;
  const activeStep = STEP_ORDER.find((s) => steps[s].status === "started") ?? null;

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-4 px-4 py-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-[var(--color-ink)]">内容工作台</h1>
          <p className="mt-0.5 text-xs text-[var(--color-ink-2)]">
            一条链接或一段素材 → 小红书图文笔记（标题 · 正文 · 话题标签）
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="password"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              window.localStorage.setItem("cs_token", e.target.value);
            }}
            placeholder="访问令牌（如已配置）"
            className="w-44 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs text-[var(--color-ink)] placeholder:text-[var(--color-ink-3)]"
          />
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        {/* ---------- 左：输入 ---------- */}
        <section className="flex flex-col rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] shadow-[var(--shadow-sm)]">
          <div className="flex items-center gap-1 border-b border-[var(--color-line)] px-3 py-2">
            {(["url", "text"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  mode === m
                    ? "bg-[var(--color-brand-soft)] text-[var(--color-brand)]"
                    : "text-[var(--color-ink-2)] hover:bg-[var(--color-hover)]"
                }`}
              >
                {m === "url" ? "贴链接" : "粘贴文本"}
              </button>
            ))}
            <span className="ml-auto text-[11px] text-[var(--color-ink-3)]">
              {mode === "url" ? "自动抓取正文" : "推荐：抓取失败时用这个"}
            </span>
          </div>

          <div className="flex flex-1 flex-col gap-3 p-3">
            {mode === "url" ? (
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSubmit();
                }}
                placeholder="https://…"
                className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-canvas-subtle)] px-3 py-2 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-3)]"
              />
            ) : (
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="把文章正文、笔记草稿或会议要点粘贴到这里…"
                rows={14}
                className="scroll-thin w-full flex-1 resize-y rounded-md border border-[var(--color-line-strong)] bg-[var(--color-canvas-subtle)] px-3 py-2 font-mono text-[13px] leading-relaxed text-[var(--color-ink)] placeholder:text-[var(--color-ink-3)]"
              />
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onSubmit}
                disabled={!canSubmit}
                className="rounded-md bg-[var(--color-brand)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--color-brand-hover)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {running ? "生成中…" : "生成笔记"}
              </button>
              {running && (
                <button
                  type="button"
                  onClick={onCancel}
                  className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-sm text-[var(--color-ink-2)] hover:bg-[var(--color-hover)]"
                >
                  取消
                </button>
              )}
              {note && !running && (
                <button
                  type="button"
                  onClick={onRegenerate}
                  className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-sm text-[var(--color-ink-2)] hover:bg-[var(--color-hover)]"
                >
                  换一版
                </button>
              )}
            </div>

            <StepTimeline steps={steps} activeStep={activeStep} running={running} />

            {error && (
              <div className="rounded-md border border-[var(--color-err)] bg-[var(--color-err-soft)] px-3 py-2 text-xs text-[var(--color-err)]">
                <p className="font-medium">{error.message}</p>
                {error.hint && <p className="mt-1 opacity-90">{error.hint}</p>}
              </div>
            )}
            {warning && (
              <div className="rounded-md border border-[var(--color-warn)] bg-[var(--color-warn-soft)] px-3 py-2 text-xs text-[var(--color-warn)]">
                {warning}
              </div>
            )}
          </div>
        </section>

        {/* ---------- 右：输出 ---------- */}
        <section className="flex min-h-[420px] flex-col gap-3">
          {note ? (
            <NoteCard note={note} titleIndex={titleIndex} onSelectTitle={setTitleIndex} />
          ) : showLive ? (
            <NoteCard note={liveNote} titleIndex={0} live />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--color-line-strong)] bg-[var(--color-canvas-subtle)] px-6 text-center">
              <p className="text-sm text-[var(--color-ink-2)]">
                {running ? "正在生成…" : "成品会出现在这里"}
              </p>
              <p className="max-w-xs text-xs text-[var(--color-ink-3)]">
                {running
                  ? "标题、正文、标签会在生成完成后分块呈现"
                  : "贴一条文章链接，或直接粘贴素材文本，点「生成笔记」"}
              </p>
            </div>
          )}
        </section>
      </div>

      {/* ---------- 历史 ---------- */}
      <HistoryPanel
        token={token}
        tokenReady={tokenReady}
        version={historyVersion}
        onReuse={(job) => {
          // 生成中不接新的重生成，否则两条流的 token 会交错
          if (running) return;
          const src = job.sourceType === "url" ? job.sourceUrl ?? "" : job.sourceText;
          setMode(job.sourceType);
          if (job.sourceType === "url") setUrl(src);
          else setText(src);
          void run({
            sourceType: job.sourceType,
            url: job.sourceType === "url" ? src : undefined,
            text: job.sourceType === "text" ? src : undefined,
            variation: true,
          });
        }}
        onOpen={(job) => {
          setNote(job.note);
          setTitleIndex(0);
          setError(null);
          // 同步素材来源：否则「换一版」会拿上一次的素材重跑，与眼前看到的这条不一致
          if (job.note) {
            setLastSource({
              sourceType: job.sourceType,
              url: job.sourceType === "url" ? job.sourceUrl ?? "" : undefined,
              text: job.sourceType === "text" ? job.sourceText : undefined,
            });
          }
          window.scrollTo({ top: 0, behavior: "smooth" });
        }}
      />
    </div>
  );
}
