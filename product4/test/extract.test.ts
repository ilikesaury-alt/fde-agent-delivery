/**
 * 抽取（模型只转录，计算在服务端）
 * 用假 fetch 模拟网关，覆盖：脏输出解析 / 校验失败重试 / 各字段服务端计算。
 */

import { assert, assertEqual, assertThrows, describe, it } from "./harness.ts";
import {
  extractReport,
  normalizeDate,
  parseJsonLoose,
  toExtractedMetric,
  validateExtracted,
} from "../lib/extract.ts";
import { ExtractError } from "../lib/errors.ts";

const ENV = { MAGPIE_BASE_URL: "https://mock/v1", MAGPIE_API_KEY: "k", MAGPIE_MODEL: "m" };

/** 造一个网关响应 */
function gw(content: string, status = 200): typeof fetch {
  return (async () =>
    new Response(
      status === 200
        ? JSON.stringify({ choices: [{ message: { content } }] })
        : JSON.stringify({ error: "upstream boom" }),
      { status, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
}

const GOOD_JSON = JSON.stringify({
  check_date: "2025-03-14",
  hospital: "示例医院",
  metrics: [
    {
      raw_name: "甘油三酯",
      value_text: "2.31",
      unit: "mmol/L",
      ref_text: "0.45-1.7",
      source_quote: "甘油三酯 2.31 mmol/L 0.45-1.7",
    },
    {
      raw_name: "白细胞",
      value_text: "6.2",
      unit: "10^9/L",
      ref_text: "3.5-9.5",
      source_quote: "白细胞 6.2 3.5-9.5",
    },
  ],
});

describe("extract — JSON 解析容错", () => {
  it("纯 JSON", () => {
    const obj = parseJsonLoose('{"a":1}') as { a: number };
    assertEqual(obj.a, 1);
  });

  it("```json 代码块包裹", () => {
    const obj = parseJsonLoose('```json\n{"a":2}\n```') as { a: number };
    assertEqual(obj.a, 2);
  });

  it("前后有解释文字", () => {
    const obj = parseJsonLoose('好的，结果如下：\n{"a":3}\n以上。') as { a: number };
    assertEqual(obj.a, 3);
  });
});

describe("extract — 日期归一", () => {
  it("标准写法", () => assertEqual(normalizeDate("2025-03-04"), "2025-03-04"));
  it("补零", () => assertEqual(normalizeDate("2025-3-4"), "2025-03-04"));
  it("斜杠与中文年月日", () => {
    assertEqual(normalizeDate("2025/03/04"), "2025-03-04");
    assertEqual(normalizeDate("2025年3月4日"), "2025-03-04");
  });
  it("非法 → null", () => {
    assertEqual(normalizeDate("2025-13-01"), null);
    assertEqual(normalizeDate("不是日期"), null);
    assertEqual(normalizeDate(null), null);
  });
});

describe("extract — 单行转领域指标（服务端计算）", () => {
  it("数值/范围/状态全部由服务端算，不信任输入", () => {
    const m = toExtractedMetric({
      raw_name: "甘油三酯",
      value_text: "2.31",
      unit: "mmol/L",
      ref_text: "0.45-1.7",
      // 模型若瞎给 status，也必须被忽略
      status: "normal",
      value_num: 999,
    });
    assert(m);
    assertEqual(m.valueNum, 2.31, "数值以原文为准");
    assertEqual(m.refLow, 0.45);
    assertEqual(m.refHigh, 1.7);
    assertEqual(m.status, "high", "2.31 > 1.7 必须判偏高");
    assertEqual(m.standardName, "甘油三酯");
  });

  it("值带箭头标记（2.31 ↑）→ 数值可解析且判偏高（评测实测的真缺陷）", () => {
    const m = toExtractedMetric({ raw_name: "甘油三酯", value_text: "2.31 ↑", ref_text: "0.45-1.7" });
    assert(m);
    assertEqual(m.valueText, "2.31", "值里的方向标记应被剥掉");
    assertEqual(m.valueNum, 2.31);
    assertEqual(m.status, "high");
  });

  it("定性值：value_num 为 null，status=unknown（不猜）", () => {
    const m = toExtractedMetric({ raw_name: "尿蛋白", value_text: "阴性", ref_text: "阴性" });
    assert(m);
    assertEqual(m.valueNum, null);
    assertEqual(m.status, "unknown");
  });

  it("缺名字或缺值 → null（该行丢弃，不让整份报告失败）", () => {
    assertEqual(toExtractedMetric({ value_text: "1.2" }), null);
    assertEqual(toExtractedMetric({ raw_name: "甘油三酯" }), null);
    assertEqual(toExtractedMetric({ raw_name: "  ", value_text: "1.2" }), null);
  });

  it("兼容模型用别的字段名（name/value/ref）", () => {
    const m = toExtractedMetric({ name: "TSH", value: "2.5", ref: "0.27-4.2" });
    assert(m);
    assertEqual(m.standardName, "促甲状腺激素");
    assertEqual(m.status, "normal");
  });
});

describe("extract — 整体校验", () => {
  it("合法输出通过，且服务端补齐计算字段", () => {
    const r = validateExtracted(JSON.parse(GOOD_JSON));
    assertEqual(r.checkDate, "2025-03-14");
    assertEqual(r.hospital, "示例医院");
    assertEqual(r.metrics.length, 2);
    assertEqual(r.metrics[0].status, "high");
  });

  it("缺日期不再判失败（日期只是建议值，确认闸补填）", () => {
    const r = validateExtracted({ metrics: [{ raw_name: "a", value_text: "1" }] });
    assertEqual(r.checkDate, null);
    assertEqual(r.metrics.length, 1);
    // 但**确认入库**时日期仍是必填（POST /api/reports 校验，见 routes.test）
  });

  it("无指标 / 指标全被丢弃 → ExtractError(extractFailed)", async () => {
    await assertThrows(
      () => validateExtracted({ check_date: "2025-01-01", metrics: [] }),
      (e) => e instanceof ExtractError && e.code === "extractFailed",
    );
    await assertThrows(
      () => validateExtracted({ check_date: "2025-01-01", metrics: [{ foo: "bar" }] }),
      (e) => e instanceof ExtractError && e.code === "extractFailed",
    );
  });

  it("同一报告内重复行去重（模型抄两遍）", () => {
    const r = validateExtracted({
      check_date: "2025-01-01",
      metrics: [
        { raw_name: "甘油三酯", value_text: "2.31" },
        { raw_name: "甘油三酯", value_text: "2.31" },
      ],
    });
    assertEqual(r.metrics.length, 1);
  });
});

describe("extract — 主流程与重试", () => {
  it("首次返回脏输出、第二次合法 → 重试成功", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      const content = calls === 1 ? "抱歉我无法解析" : GOOD_JSON;
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const r = await extractReport(ENV, "报告正文", { fetchImpl, retry: 1 });
    assertEqual(calls, 2, "应当在解析失败后重试一次");
    assertEqual(r.metrics.length, 2);
  });

  it("重试用尽仍失败 → extractInvalid（不无限重试）", async () => {
    let calls = 0;
    const fetchImpl = gw("还是不行");
    const wrapped = (async (...args: Parameters<typeof fetch>) => {
      calls++;
      return fetchImpl(...args);
    }) as unknown as typeof fetch;

    await assertThrows(
      () => extractReport(ENV, "报告正文", { fetchImpl: wrapped, retry: 1 }),
      (e) => e instanceof ExtractError && e.code === "extractInvalid",
    );
    assertEqual(calls, 2, "1 次首调 + 1 次重试");
  });

  it("上游「200 但空内容」→ 自动重试一次（真实报告实测：空响应不是死刑）", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      // 第一次：200 + 空 content（退化响应）；第二次：正常
      const body =
        calls === 1
          ? { choices: [{ message: { content: "" } }] }
          : { choices: [{ message: { content: GOOD_JSON } }] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const r = await extractReport(ENV, "报告正文", { fetchImpl, retry: 0 });
    assertEqual(calls, 2, "空内容应额外重试一次（即使 retry=0）");
    assertEqual(r.metrics.length, 2);
  });

  it("空内容持续出现 → noMetrics（散文式报告没有检验项目表，重试无意义）", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await assertThrows(
      () => extractReport(ENV, "超声所见：肝脏大小正常，肝内探及多个囊性无回声，较大约1.1cm。", { fetchImpl, retry: 0 }),
      (e) => e instanceof ExtractError && e.code === "noMetrics",
    );
    assertEqual(calls, 2, "空内容仍重试一次，再判无指标");
  });

  it("上游 5xx 不重试（避免放大限流）", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("upstream boom", { status: 502 });
    }) as unknown as typeof fetch;

    await assertThrows(
      () => extractReport(ENV, "报告正文", { fetchImpl, retry: 1 }),
      (e) => e instanceof ExtractError && e.code === "extractFailed",
    );
    assertEqual(calls, 1, "错误码类失败不重试");
  });

  it("空文本 → extractFailed 前的 emptyText（不调模型）", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;

    await assertThrows(
      () => extractReport(ENV, "   ", { fetchImpl }),
      (e) => e instanceof ExtractError && e.code === "emptyText",
    );
    assert(!called, "空文本不应调用上游");
  });

  it("超长文本 → tooLong（不静默截断，截断会漏指标）", async () => {
    await assertThrows(
      () => extractReport(ENV, "x".repeat(50), { maxChars: 10 }),
      (e) => e instanceof ExtractError && e.code === "tooLong",
    );
  });

  it("上游 5xx → extractFailed（不重试上游错误，避免放大限流）", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("boom", { status: 503 });
    }) as unknown as typeof fetch;

    await assertThrows(
      () => extractReport(ENV, "报告正文", { fetchImpl, retry: 1 }),
      (e) => e instanceof ExtractError && e.code === "extractFailed",
    );
    assertEqual(calls, 1, "上游错误不重试");
  });
});