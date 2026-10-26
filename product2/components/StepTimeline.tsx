"use client";

/** 流水线步骤时间线：抓取 → 准备 → 生成。首 token 可能等 20s+，这层反馈是必需的。 */

import type { PipelineStep } from "../lib/types.ts";

export type StepState = {
  step: PipelineStep;
  status: "started" | "done" | "failed" | "skipped";
  detail?: string;
};

const LABELS: Record<PipelineStep, string> = {
  fetch: "抓取正文",
  prepare: "素材准备",
  generate: "生成笔记",
};

const DOT: Record<StepState["status"], string> = {
  started: "bg-[var(--color-brand)]",
  done: "bg-[var(--color-ok)]",
  failed: "bg-[var(--color-err)]",
  skipped: "bg-[var(--color-line-strong)]",
};

export function StepTimeline({
  steps,
  activeStep,
  running,
}: {
  steps: Record<PipelineStep, StepState>;
  activeStep: PipelineStep | null;
  running: boolean;
}) {
  const order: PipelineStep[] = ["fetch", "prepare", "generate"];
  if (!running && order.every((s) => steps[s].status === "skipped")) return null;

  return (
    <ol className="space-y-1.5 rounded-md border border-[var(--color-line)] bg-[var(--color-inset)] px-3 py-2.5">
      {order.map((s) => {
        const st = steps[s];
        const isActive = activeStep === s;
        return (
          <li key={s} className="flex items-start gap-2 text-xs">
            <span
              className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${DOT[st.status]}`}
              style={isActive ? { animation: "pulse-dot 1s ease-in-out infinite" } : undefined}
            />
            <span className="flex-1">
              <span
                className={
                  st.status === "failed"
                    ? "font-medium text-[var(--color-err)]"
                    : st.status === "skipped"
                      ? "text-[var(--color-ink-3)]"
                      : "text-[var(--color-ink)]"
                }
              >
                {LABELS[s]}
              </span>
              {st.detail && (
                <span className="ml-1.5 text-[var(--color-ink-3)]">{st.detail}</span>
              )}
              {isActive && !st.detail && (
                <span className="ml-1.5 text-[var(--color-ink-3)]">进行中…</span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
