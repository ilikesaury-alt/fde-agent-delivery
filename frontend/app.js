/**
 * 前端逻辑（原生 ES Module，零构建、零依赖）
 * 覆盖验收标准：1 生成日报 / 3 文件格式校验 / 4 空输入禁用 / 6 一键复制
 */

const SUPPORTED_EXTENSIONS = [".txt", ".md"];

/**
 * 长文本阈值。默认与后端一致；启动时从 /health 拉取真实值，
 * 避免前后端两处硬编码漂移（后端 wrangler.toml 的 MAX_INPUT_CHARS 可改）。
 */
let MAX_INPUT_CHARS = 30000;

/**
 * Worker 地址解析顺序：
 * 1. window.__MEETING_DIGEST_API__（部署时由脚本注入，或手动在控制台设定）
 * 2. 同源相对路径（Pages 与 Worker 同域 / 已配反向代理时最稳，也避免 https 页面的 mixed content）
 * 3. 本地开发兜底 http://127.0.0.1:8787
 */
function resolveApiBase() {
  if (window.__MEETING_DIGEST_API__) return window.__MEETING_DIGEST_API__;
  const { protocol, hostname } = window.location;
  // file:// 或本地静态打开时没有可用同源 API，走本地 dev 兜底
  if (protocol === "http:" || protocol === "https:") return "";
  return "http://127.0.0.1:8787";
}

const API_BASE = resolveApiBase();

/** 启动时同步阈值；失败则保留默认值（后端仍会兜底校验） */
async function syncLimits() {
  try {
    const resp = await fetch(`${API_BASE}/health`);
    const data = await resp.json();
    if (typeof data?.maxInputChars === "number" && data.maxInputChars > 0) {
      MAX_INPUT_CHARS = data.maxInputChars;
    }
  } catch {
    // 保留默认值，不阻塞使用
  }
  updateGenerateState();
}

/** 与 worker/src/validate.ts 同源的格式校验 */
function isSupportedFile(filename) {
  if (!filename) return false;
  const lastDot = filename.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === filename.length - 1) return false;
  return SUPPORTED_EXTENSIONS.includes(filename.slice(lastDot).toLowerCase());
}

/**
 * 轻量二进制检测：扩展名可伪造，但二进制内容按 UTF-8 解码后几乎必含 NUL。
 * 命中则拒绝，避免把乱码送给模型污染输出（fail-closed）。
 */
function looksBinary(text) {
  return text.includes("\u0000");
}

const els = {
  text: document.getElementById("textInput"),
  charCount: document.getElementById("charCount"),
  file: document.getElementById("fileInput"),
  generate: document.getElementById("generateBtn"),
  clear: document.getElementById("clearBtn"),
  hint: document.getElementById("hint"),
  resultPanel: document.getElementById("resultPanel"),
  resultBody: document.getElementById("resultBody"),
  copy: document.getElementById("copyBtn"),
};

let lastDigest = "";

function setHint(message, kind = "info") {
  els.hint.textContent = message;
  els.hint.dataset.kind = kind;
}

function updateGenerateState() {
  const len = els.text.value.trim().length;
  els.generate.disabled = len === 0;
  els.charCount.textContent = `${els.text.value.length} 字符`;
  if (els.text.value.length > MAX_INPUT_CHARS) {
    els.charCount.dataset.over = "true";
  } else {
    delete els.charCount.dataset.over;
  }
}

els.text.addEventListener("input", () => {
  updateGenerateState();
  setHint("");
});

// --- 上传 .txt / .md：浏览器本地读取，零后端依赖（标准 3） ---
els.file.addEventListener("change", async () => {
  const file = els.file.files?.[0];
  if (!file) return;

  if (!isSupportedFile(file.name)) {
    setHint(`不支持的文件格式「${file.name}」，请上传 .txt 或 .md 文件。`, "error");
    els.file.value = "";
    return;
  }

  try {
    const text = await file.text();
    if (looksBinary(text)) {
      setHint(`「${file.name}」看起来是二进制文件，请另存为纯文本（UTF-8）后再上传。`, "error");
      return;
    }
    els.text.value = text;
    updateGenerateState();
    setHint(`已载入「${file.name}」。`, "success");
  } catch {
    setHint("文件读取失败，请重试。", "error");
  } finally {
    els.file.value = "";
  }
});

els.clear.addEventListener("click", () => {
  els.text.value = "";
  lastDigest = "";
  els.resultPanel.hidden = true;
  updateGenerateState();
  setHint("");
});

// --- 生成日报（标准 1） ---
els.generate.addEventListener("click", async () => {
  const text = els.text.value;

  if (text.trim().length === 0) {
    setHint("内容不能为空，请先粘贴会议文本或上传文件。", "error");
    return;
  }
  if (text.length > MAX_INPUT_CHARS) {
    setHint(
      `内容过长（上限 ${MAX_INPUT_CHARS} 字符，当前 ${text.length}），请分段提交或精简后重试。`,
      "error",
    );
    return;
  }

  els.generate.disabled = true;
  els.generate.textContent = "生成中…";
  setHint("正在整理日报，请稍候…");

  // 前端侧超时：连接挂起时也要恢复按钮，避免永久停在「生成中…」
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 40_000);

  try {
    const resp = await fetch(`${API_BASE}/api/digest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: timeout.signal,
    });

    const data = await resp.json().catch(() => null);

    if (!resp.ok) {
      // 只接受字符串错误文案，避免把对象/数组渲染成 [object Object]
      const serverError =
        data && typeof data.error === "string" && data.error.trim()
          ? data.error
          : `生成失败（HTTP ${resp.status}），请稍后重试。`;
      setHint(serverError, "error");
      return;
    }

    // 只接受字符串 digest，避免把异常响应渲染成 [object Object]
    if (typeof data?.digest !== "string" || !data.digest.trim()) {
      setHint("AI 返回结果异常，请重试。", "error");
      return;
    }

    lastDigest = data.digest;
    els.resultBody.textContent = lastDigest;
    els.resultPanel.hidden = false;
    setHint("日报已生成。", "success");
  } catch (e) {
    if (e?.name === "AbortError") {
      setHint("生成超时，请重试或缩短输入内容。", "error");
    } else {
      setHint("无法连接 AI 服务，请检查网络或稍后重试。", "error");
    }
  } finally {
    clearTimeout(timer);
    els.generate.textContent = "生成日报";
    updateGenerateState();
  }
});

// --- 一键复制（标准 6） ---
let copyResetTimer = null;

els.copy.addEventListener("click", async () => {
  if (!lastDigest) return;

  let ok = false;
  try {
    await navigator.clipboard.writeText(lastDigest);
    ok = true;
  } catch {
    // 老浏览器 / 非安全上下文：clipboard API 可能不存在或被拒
    try {
      const ta = document.createElement("textarea");
      ta.value = lastDigest;
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
    els.copy.textContent = "已复制 ✓";
    // 连续点击时清掉旧定时器，避免状态被提前还原
    if (copyResetTimer) clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => {
      els.copy.textContent = "一键复制";
      copyResetTimer = null;
    }, 1600);
  } else {
    setHint("复制失败，请手动选中结果复制。", "error");
  }
});

updateGenerateState();
// 从后端拉取真实阈值（失败则用默认值），保证前后端口径一致
syncLimits();
