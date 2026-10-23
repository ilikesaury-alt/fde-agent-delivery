/**
 * 首页 — 工作台式布局
 * 左侧输入（未加工原料，等宽体）/ 右侧输出（成品文档，衬线体）
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { Markdown } from "../components/Markdown.tsx";

const SUPPORTED_EXTENSIONS = [".txt", ".md"];

function isSupportedFile(filename: string): boolean {
  if (!filename) return false;
  const lastDot = filename.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === filename.length - 1) return false;
  return SUPPORTED_EXTENSIONS.includes(filename.slice(lastDot).toLowerCase());
}

/** 轻量二进制检测：UTF-8 解码后含 NUL 基本可判定为二进制 */
function looksBinary(text: string): boolean {
  return text.includes("\u0000");
}

type HealthResponse = { ok?: boolean; maxInputChars?: number };
type DigestResponse = { digest?: unknown; error?: unknown };

type Hint = { msg: string; kind: "info" | "error" | "success" };

/** 示例文本 —— 空状态时一键填充，而不是让用户面对空白框 */
const SAMPLE = `2026年10月22日 14:00-15:30 产品周会（腾讯会议）
参会：陈明（PM）、刘芳（设计）、周杰（开发）、赵敏（测试）

本周进展
陈明同步了客户对 v2.0 的验收反馈，主要关注支付流程稳定性。
刘芳完成新版首页视觉稿，等待评审。
周杰修复了 5 个历史遗留 bug，剩余 2 个需要产品确认优先级。
赵敏补充了 18 条回归用例，覆盖率从 62% 提升到 78%。

结论
1. v2.0 延期到 11 月中旬发布，给支付流程留足测试时间。
2. 优先修复支付流程的 3 个 P0 bug，其余 bug 顺延。
3. 设计稿本周五前定稿，下周一进入开发。

待办
周杰修复支付 bug，截止 10月25日。
刘芳输出设计定稿，截止 10月24日。
陈明向客户同步延期信息，截止 10月23日。

遗留问题
测试资源不足，可能影响回归覆盖质量，需评估是否临时增补人力。`;

export default function MeetingDigest() {
  const [text, setText] = useState("");
  const [digest, setDigest] = useState("");
  const [hint, setHint] = useState<Hint>({ msg: "", kind: "info" });
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [maxChars, setMaxChars] = useState(30000);
  const [token, setToken] = useState("");
  const [tokenSaved, setTokenSaved] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const saved =
      window.localStorage.getItem("md_token") ||
      (window as { __MD_TOKEN__?: string }).__MD_TOKEN__ ||
      "";
    setToken(saved);
    setTokenSaved(Boolean(saved));
  }, []);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json() as Promise<HealthResponse>)
      .then((d) => {
        if (typeof d?.maxInputChars === "number" && d.maxInputChars > 0) {
          setMaxChars(d.maxInputChars);
        }
      })
      .catch(() => {});
  }, []);

  const over = text.length > maxChars;
  const canSubmit = text.trim().length > 0 && !over && !busy;

  const onFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!isSupportedFile(file.name)) {
      setHint({
        msg: `不支持的文件格式「${file.name}」，请上传 .txt 或 .md 文件。`,
        kind: "error",
      });
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    try {
      const content = await file.text();
      if (looksBinary(content)) {
        setHint({
          msg: `「${file.name}」看起来是二进制文件，请另存为纯文本（UTF-8）后再上传。`,
          kind: "error",
        });
        return;
      }
      setText(content);
      setHint({ msg: `已载入「${file.name}」`, kind: "success" });
    } catch {
      setHint({ msg: "文件读取失败，请重试", kind: "error" });
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }, []);

  const onGenerate = useCallback(async () => {
    if (text.trim().length === 0) {
      setHint({ msg: "内容不能为空，请先粘贴会议文本或上传文件", kind: "error" });
      return;
    }
    if (over) {
      setHint({
        msg: `内容过长（上限 ${maxChars} 字符，当前 ${text.length}），请分段提交或精简后重试`,
        kind: "error",
      });
      return;
    }

    setBusy(true);
    setDigest("");
    setHint({ msg: "", kind: "info" });

    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 90_000);

    try {
      const resp = await fetch("/api/digest", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ text }),
        signal: timeout.signal,
      });

      const data = (await resp.json().catch(() => null)) as DigestResponse | null;

      if (!resp.ok) {
        const serverError =
          data && typeof data.error === "string" && data.error.trim()
            ? data.error
            : `生成失败（HTTP ${resp.status}），请稍后重试`;
        setHint({ msg: serverError, kind: "error" });
        return;
      }

      if (typeof data?.digest !== "string" || !data.digest.trim()) {
        setHint({ msg: "AI 返回结果异常，请重试", kind: "error" });
        return;
      }

      setDigest(data.digest);
      setHint({ msg: "", kind: "info" });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      setHint({
        msg:
          name === "AbortError"
            ? "生成超时，请重试或缩短输入内容"
            : "无法连接 AI 服务，请检查网络或稍后重试",
        kind: "error",
      });
    } finally {
      clearTimeout(timer);
      setBusy(false);
    }
  }, [text, over, maxChars, token]);

  const onCopy = useCallback(async () => {
    if (!digest) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(digest);
      ok = true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = digest;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    if (ok) {
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1800);
    } else {
      setHint({ msg: "复制失败，请手动选中结果复制", kind: "error" });
    }
  }, [digest]);

  // ⌘/Ctrl + Enter 生成
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canSubmit) {
        e.preventDefault();
        void onGenerate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canSubmit, onGenerate]);

  // 令牌门禁
  if (!tokenSaved) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas p-4">
        <div className="w-full max-w-[380px] rounded-lg border border-line bg-surface p-6 shadow-md">
          <div className="mb-1 flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-sm bg-brand font-doc text-sm font-bold text-white">
              会
            </span>
            <h1 className="m-0 text-[15px] font-semibold tracking-tight text-ink">
              需要访问令牌
            </h1>
          </div>
          <p className="mb-5 mt-2 text-[12.5px] leading-relaxed text-ink-2">
            本工具已开启访问保护。令牌只保存在当前浏览器，不会上传到任何地方。
          </p>

          <label
            htmlFor="tokenInput"
            className="mb-1.5 block text-xs font-semibold text-ink-2"
          >
            访问令牌
          </label>
          <input
            id="tokenInput"
            type="password"
            className="mb-4 w-full rounded-sm border border-line-strong bg-surface px-3 py-2.5 font-mono text-[12.5px] text-ink transition focus:border-brand focus:outline-none focus:ring-[3px] focus:ring-brand-soft"
            placeholder="粘贴访问令牌…"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && token.trim()) {
                window.localStorage.setItem("md_token", token.trim());
                setTokenSaved(true);
              }
            }}
          />
          <button
            type="button"
            disabled={!token.trim()}
            onClick={() => {
              window.localStorage.setItem("md_token", token.trim());
              setTokenSaved(true);
            }}
            className="w-full rounded-sm bg-brand px-3.5 py-2.5 text-[13px] font-semibold text-white transition hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-45"
          >
            进入
          </button>
        </div>
      </div>
    );
  }

  const statusState = busy ? "busy" : hint.kind === "error" ? "error" : "ready";
  const statusText = busy ? "生成中" : hint.kind === "error" ? "出错了" : "就绪";

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      {/* 顶栏 */}
      <header className="sticky top-0 z-20 flex shrink-0 items-center gap-4 border-b border-line bg-canvas/85 px-6 py-3 backdrop-blur-md">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-7 shrink-0 place-items-center rounded-sm bg-brand font-doc text-[15px] font-bold text-white">
            会
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold leading-tight tracking-tight text-ink">
              会议日报
            </div>
            <div className="text-[11.5px] leading-tight text-ink-3">
              原始记录 → 结构化纪要
            </div>
          </div>
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-2">
          <span
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-ink-2"
            data-state={statusState}
          >
            <span
              className={
                "size-1.5 shrink-0 rounded-full " +
                (statusState === "ready"
                  ? "bg-ok shadow-[0_0_0_3px_rgba(21,128,61,0.18)]"
                  : statusState === "busy"
                    ? "bg-brand motion-safe:animate-[pulse-dot_1.2s_cubic-bezier(0.2,0,0,1)_infinite]"
                    : "bg-err")
              }
            />
            {statusText}
          </span>
        </div>
      </header>

      {/* 工作台 */}
      <main className="mx-auto grid w-full max-w-[1440px] flex-1 items-start gap-4 p-4 lg:h-[calc(100vh-57px)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:overflow-hidden lg:px-6 lg:pb-6">
        {/* ── 左：输入 ── */}
        <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-sm lg:h-full">
          <div className="flex shrink-0 items-center gap-3 border-b border-line bg-canvas-subtle px-4 py-3">
            <span className="text-[12.5px] font-semibold tracking-wide text-ink">
              原始文本
            </span>
            <span
              className={
                "ml-auto text-[11.5px] tabular-nums " +
                (over ? "font-semibold text-err" : "text-ink-3")
              }
            >
              {text.length.toLocaleString()} / {maxChars.toLocaleString()}
            </span>
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <textarea
              id="textInput"
              aria-label="会议原始文本"
              className="min-h-[180px] w-full flex-1 resize-none border-0 bg-transparent p-4 font-mono text-[13px] leading-[1.7] text-ink outline-none placeholder:font-ui placeholder:text-ink-3"
              placeholder="把会议录音转写稿或笔记粘贴到这里…&#10;&#10;也可以上传 .txt / .md 文件。"
              spellCheck={false}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />

            {/* 空状态：给示例而不是空白 */}
            {text.length === 0 ? (
              <div className="border-t border-line px-4 py-3">
                <button
                  type="button"
                  onClick={() => {
                    setText(SAMPLE);
                    setHint({ msg: "已填入示例文本", kind: "success" });
                  }}
                  className="text-[12.5px] text-ink-2 underline decoration-line-strong underline-offset-2 transition hover:text-brand hover:decoration-brand"
                >
                  用示例文本试试
                </button>
              </div>
            ) : null}
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line bg-canvas-subtle px-4 py-3">
            <label
              htmlFor="fileInput"
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-sm border border-dashed border-line-strong bg-surface px-3.5 py-1.5 text-[13px] font-medium text-ink-2 transition hover:border-brand-line hover:bg-brand-soft hover:text-brand"
            >
              上传文件
            </label>
            <input
              id="fileInput"
              ref={fileRef}
              type="file"
              accept=".txt,.md"
              hidden
              onChange={onFile}
            />

            <button
              type="button"
              onClick={() => {
                setText("");
                setDigest("");
                setHint({ msg: "", kind: "info" });
              }}
              className="rounded-sm border border-transparent px-3 py-1.5 text-[13px] font-medium text-ink-2 transition hover:border-line hover:bg-hover hover:text-ink"
            >
              清空
            </button>

            <div className="flex-1" />

            <button
              type="button"
              disabled={!canSubmit}
              onClick={onGenerate}
              className="inline-flex items-center gap-1.5 rounded-sm bg-brand px-4 py-1.5 text-[13px] font-semibold text-white shadow-sm transition hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-45"
            >
              {busy ? (
                <>
                  <span className="size-1.5 rounded-full bg-white/90 motion-safe:animate-[pulse-dot_1.2s_ease-in-out_infinite]" />
                  生成中
                </>
              ) : (
                <>
                  生成日报
                  <kbd className="hidden rounded border border-white/25 px-1 py-px font-mono text-[10px] font-normal text-white/80 sm:inline">
                    {typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
                      ? "⌘↵"
                      : "Ctrl↵"}
                  </kbd>
                </>
              )}
            </button>
          </div>

          {hint.msg ? (
            <div
              role="status"
              aria-live="polite"
              className={
                "mx-4 mb-3 mt-0 flex items-start gap-2 rounded-md border px-4 py-3 text-[12.5px] leading-relaxed " +
                (hint.kind === "error"
                  ? "border-err/30 bg-err-soft text-err"
                  : hint.kind === "success"
                    ? "border-ok/30 bg-ok-soft text-ok"
                    : "border-line bg-inset text-ink-2")
              }
            >
              {hint.msg}
            </div>
          ) : null}
        </section>

        {/* ── 右：输出 ── */}
        <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-sm lg:h-full">
          <div className="flex shrink-0 items-center gap-3 border-b border-line bg-canvas-subtle px-4 py-3">
            <span className="text-[12.5px] font-semibold tracking-wide text-ink">
              会议日报
            </span>
            {digest ? (
              <span className="ml-auto text-[11.5px] tabular-nums text-ink-3">
                {digest.length.toLocaleString()} 字符
              </span>
            ) : null}
            {digest ? (
              <button
                type="button"
                onClick={onCopy}
                className="rounded-sm border border-line-strong bg-surface px-3 py-1 text-[12.5px] font-medium text-ink-2 transition hover:bg-hover hover:text-ink"
              >
                {copied ? "已复制" : "复制"}
              </button>
            ) : null}
          </div>

          <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto">
            {busy ? (
              <div className="flex flex-col gap-5 p-6 lg:p-8">
                {[0, 1, 2].map((g) => (
                  <div key={g} className="flex flex-col gap-2">
                    <div className="sk-line h-[15px] w-[38%]" />
                    <div className="sk-line w-[90%]" />
                    <div className="sk-line w-[75%]" />
                    <div className="sk-line w-[60%]" />
                  </div>
                ))}
              </div>
            ) : digest ? (
              <article className="doc px-6 py-6 lg:px-8 lg:py-8">
                <Markdown source={digest} />
              </article>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-10 text-center">
                <div className="grid size-12 place-items-center rounded-md border border-line bg-inset text-ink-3">
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <path d="M14 2v6h6M8 13h8M8 17h5" />
                  </svg>
                </div>
                <p className="m-0 text-sm font-semibold text-ink-2">还没有日报</p>
                <p className="m-0 max-w-[34ch] text-[12.5px] leading-relaxed text-ink-3">
                  在左侧粘贴会议记录或上传文件，点「生成日报」。
                  输出会包含主题、参会人、核心结论、待办、风险与摘要。
                </p>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
