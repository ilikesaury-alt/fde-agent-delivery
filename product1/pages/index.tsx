/**
 * 首页 page component（React，客户端 + SSR 共用）
 * 交互：粘贴/上传 → 调 /api/digest → 展示 Markdown → 一键复制
 */

import { useCallback, useEffect, useRef, useState } from "react";

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

export default function MeetingDigest() {
  const [text, setText] = useState("");
  const [digest, setDigest] = useState("");
  const [hint, setHint] = useState<{ msg: string; kind: "info" | "error" | "success" }>({
    msg: "",
    kind: "info",
  });
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [maxChars, setMaxChars] = useState(30000);
  const fileRef = useRef<HTMLInputElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 从后端同步阈值，避免两处硬编码漂移
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
      setHint({ msg: `已载入「${file.name}」。`, kind: "success" });
    } catch {
      setHint({ msg: "文件读取失败，请重试。", kind: "error" });
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }, []);

  const onGenerate = useCallback(async () => {
    if (text.trim().length === 0) {
      setHint({ msg: "内容不能为空，请先粘贴会议文本或上传文件。", kind: "error" });
      return;
    }
    if (over) {
      setHint({
        msg: `内容过长（上限 ${maxChars} 字符，当前 ${text.length}），请分段提交或精简后重试。`,
        kind: "error",
      });
      return;
    }

    setBusy(true);
    setHint({ msg: "正在整理日报，请稍候…", kind: "info" });

    // 前端侧超时：连接挂起时也要恢复按钮
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 40_000);

    try {
      const resp = await fetch("/api/digest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: timeout.signal,
      });

      const data = (await resp.json().catch(() => null)) as DigestResponse | null;

      if (!resp.ok) {
        const serverError =
          data && typeof data.error === "string" && data.error.trim()
            ? data.error
            : `生成失败（HTTP ${resp.status}），请稍后重试。`;
        setHint({ msg: serverError, kind: "error" });
        return;
      }

      if (typeof data?.digest !== "string" || !data.digest.trim()) {
        setHint({ msg: "AI 返回结果异常，请重试。", kind: "error" });
        return;
      }

      setDigest(data.digest);
      setHint({ msg: "日报已生成。", kind: "success" });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      setHint({
        msg: name === "AbortError" ? "生成超时，请重试或缩短输入内容。" : "无法连接 AI 服务，请检查网络或稍后重试。",
        kind: "error",
      });
    } finally {
      clearTimeout(timer);
      setBusy(false);
    }
  }, [text, over, maxChars]);

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
      copyTimer.current = setTimeout(() => setCopied(false), 1600);
    } else {
      setHint({ msg: "复制失败，请手动选中结果复制。", kind: "error" });
    }
  }, [digest]);

  return (
    <main className="wrap">
      <header className="head">
        <h1>会议日报生成器</h1>
        <p className="sub">
          粘贴会议文本，或上传 <code>.txt</code> / <code>.md</code> 文件，一键生成结构化日报。
        </p>
      </header>

      <section className="panel">
        <div className="panel-head">
          <label htmlFor="textInput" className="label">
            会议原始文本
          </label>
          <span className="char-count" data-over={over ? "true" : undefined}>
            {text.length} 字符
          </span>
        </div>

        <textarea
          id="textInput"
          className="textarea"
          placeholder="把会议录音转写稿或笔记粘贴到这里……"
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />

        <div className="toolbar">
          <label className="file-btn" htmlFor="fileInput">
            上传 .txt / .md
          </label>
          <input
            id="fileInput"
            ref={fileRef}
            type="file"
            accept=".txt,.md"
            hidden
            onChange={onFile}
          />

          <button className="btn-primary" disabled={!canSubmit} onClick={onGenerate} type="button">
            {busy ? "生成中…" : "生成日报"}
          </button>
          <button
            className="btn-ghost"
            type="button"
            onClick={() => {
              setText("");
              setDigest("");
              setHint({ msg: "", kind: "info" });
            }}
          >
            清空
          </button>
        </div>

        <p className="hint" role="status" aria-live="polite" data-kind={hint.kind}>
          {hint.msg}
        </p>
      </section>

      {digest ? (
        <section className="panel result">
          <div className="panel-head">
            <span className="label">会议日报</span>
            <button className="btn-ghost" type="button" onClick={onCopy}>
              {copied ? "已复制 ✓" : "一键复制"}
            </button>
          </div>
          <article className="result-body markdown">{digest}</article>
        </section>
      ) : null}
    </main>
  );
}
