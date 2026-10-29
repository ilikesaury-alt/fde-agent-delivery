/** 路由层（令牌契约 / 服务端重算 / 状态码映射） */

import { assert, assertEqual, describe, it } from "./harness.ts";
import { createMemoryRepo } from "../lib/repo.ts";
import * as extractRoute from "../routes/api/extract.ts";
import * as reportsRoute from "../routes/api/reports.ts";
import * as metricsRoute from "../routes/api/metrics.ts";
import * as interpretRoute from "../routes/api/interpret.ts";
import * as trendsRoute from "../routes/api/trends.ts";
import { saveReport } from "../lib/service.ts";

const TOKEN = "secret-token";

type Handler = (c: unknown) => Promise<Response>;

/** 造一个最小上下文：路由只用到 env / req / _repo / _fetchImpl */
function ctx(opts: {
  url: string;
  method?: string;
  body?: unknown;
  auth?: string | null;
  repo?: ReturnType<typeof createMemoryRepo>;
  fetchImpl?: typeof fetch;
  env?: Record<string, unknown>;
}): unknown {
    return {
    env: { ACCESS_TOKEN: TOKEN, MAGPIE_BASE_URL: "https://mock/v1", MAGPIE_API_KEY: "k", MAGPIE_MODEL: "m", ...(opts.env ?? {}) },
    _repo: opts.repo,
    _fetchImpl: opts.fetchImpl,
    req: {
      url: opts.url,
      method: opts.method ?? "GET",
      header(name: string) {
        if (name.toLowerCase() === "authorization") {
          return opts.auth === null ? undefined : (opts.auth ?? `Bearer ${TOKEN}`);
        }
        return undefined;
      },
      async json() {
        if (opts.body === undefined) throw new Error("no body");
        return opts.body;
      },
    },
  };
}

function mockLLM(content: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

const GOOD = JSON.stringify({
  check_date: "2025-03-14",
  hospital: "示例医院",
  metrics: [{ raw_name: "甘油三酯", value_text: "2.31", unit: "mmol/L", ref_text: "0.45-1.7", source_quote: "甘油三酯 2.31" }],
});

describe("routes — 令牌契约", () => {
  it("未带令牌 → 401（各路由一致）", async () => {
    const repo = createMemoryRepo();
    const handlers: Array<[string, Handler, string]> = [
      ["reports GET", reportsRoute.GET as Handler, "/api/reports"],
      ["reports POST", reportsRoute.POST as Handler, "/api/reports"],
      ["trends GET", trendsRoute.GET as Handler, "/api/trends"],
      ["metrics POST", metricsRoute.POST as Handler, "/api/metrics"],
      ["interpret POST", interpretRoute.POST as Handler, "/api/interpret"],
      ["extract POST", extractRoute.POST as Handler, "/api/extract"],
    ];
    for (const [name, h, url] of handlers) {
      const res = await h(ctx({ url, method: "POST", body: {}, auth: null, repo }));
      assertEqual(res.status, 401, `${name} 应 401`);
    }
  });

  it("未配置 ACCESS_TOKEN 时不校验（本地演示路径）", async () => {
    const repo = createMemoryRepo();
    const res = await (reportsRoute.GET as Handler)(
      ctx({ url: "/api/reports", auth: null, repo, env: { ACCESS_TOKEN: undefined } }),
    );
    assertEqual(res.status, 200);
  });
});

describe("routes — extract", () => {
  it("合法文本 → 200 预览，含服务端算好的状态", async () => {
    const res = await (extractRoute.POST as Handler)(
      ctx({ url: "/api/extract", method: "POST", body: { text: "报告正文" }, fetchImpl: mockLLM(GOOD) }),
    );
    assertEqual(res.status, 200);
    const data = (await res.json()) as { metrics: Array<{ status: string; valueNum: number }> };
    assertEqual(data.metrics[0].status, "high");
    assertEqual(data.metrics[0].valueNum, 2.31);
  });

  it("空文本 → 400", async () => {
    const res = await (extractRoute.POST as Handler)(
      ctx({ url: "/api/extract", method: "POST", body: { text: "" }, fetchImpl: mockLLM(GOOD) }),
    );
    assertEqual(res.status, 400);
  });

  it("非法 sourceType → 400", async () => {
    const res = await (extractRoute.POST as Handler)(
      ctx({ url: "/api/extract", method: "POST", body: { text: "x", sourceType: "weird" }, fetchImpl: mockLLM(GOOD) }),
    );
    assertEqual(res.status, 400);
  });

  it("上游坏 → 502（不把上游细节透给前端）", async () => {
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const res = await (extractRoute.POST as Handler)(
      ctx({ url: "/api/extract", method: "POST", body: { text: "报告正文" }, fetchImpl }),
    );
    assertEqual(res.status, 502);
    const data = (await res.json()) as { error: string };
    assert(!data.error.includes("boom"), "不应回传上游响应体");
  });
});

describe("routes — reports 入库（服务端重算，不接受客户端算好的值）", () => {
  it("客户端伪造 status/valueNum 会被服务端覆盖", async () => {
    const repo = createMemoryRepo();
    const res = await (reportsRoute.POST as Handler)(
      ctx({
        url: "/api/reports",
        method: "POST",
        repo,
        body: {
          checkDate: "2025-03-14",
          rawText: "报告原文",
          sourceType: "pdf",
          metrics: [
            {
              rawName: "甘油三酯",
              valueText: "2.31",
              unit: "mmol/L",
              refText: "0.45-1.7",
              // 伪造：
              status: "normal",
              valueNum: 1.0,
              refHigh: 99,
            },
          ],
        },
      }),
    );
    assertEqual(res.status, 201);
    const data = (await res.json()) as { metrics: Array<{ status: string; valueNum: number; refHigh: number }> };
    assertEqual(data.metrics[0].status, "high", "2.31 > 1.7 必须偏高，客户端伪造无效");
    assertEqual(data.metrics[0].valueNum, 2.31);
    assertEqual(data.metrics[0].refHigh, 1.7);

    const list = await repo.listReports();
    assertEqual(list.length, 1);
    assertEqual(list[0].metricCount, 1);
  });

  it("缺日期 / 缺原文 / 无指标 → 400", async () => {
    const repo = createMemoryRepo();
    for (const body of [
      { rawText: "x", metrics: [{ rawName: "a", valueText: "1" }] },
      { checkDate: "2025-01-01", metrics: [{ rawName: "a", valueText: "1" }] },
      { checkDate: "2025-01-01", rawText: "x", metrics: [] },
      { checkDate: "2025-01-01", rawText: "x", metrics: [{ rawName: "", valueText: "" }] },
    ]) {
      const res = await (reportsRoute.POST as Handler)(ctx({ url: "/api/reports", method: "POST", repo, body }));
      assertEqual(res.status, 400, `应当 400：${JSON.stringify(body)}`);
    }
  });

  it("超长原文 → 413（不把超大 blob 写进库）", async () => {
    const repo = createMemoryRepo();
    const res = await (reportsRoute.POST as Handler)(
      ctx({
        url: "/api/reports",
        method: "POST",
        repo,
        body: {
          checkDate: "2025-01-01",
          rawText: "x".repeat(200_001),
          metrics: [{ rawName: "甘油三酯", valueText: "1.2" }],
        },
      }),
    );
    assertEqual(res.status, 413);
    assertEqual((await repo.listReports()).length, 0, "不应入库");
  });

  it("列表与详情（?id=）", async () => {
    const repo = createMemoryRepo();
    const saved = await saveReport(repo, {
      sourceType: "pdf", fileName: "a.pdf", checkDate: "2025-03-14", hospital: "H", rawText: "原文",
      metrics: [{
        standardName: "甘油三酯", rawName: "甘油三酯", valueNum: 2.31, valueText: "2.31",
        unit: "mmol/L", refLow: 0.45, refHigh: 1.7, refText: "0.45-1.7", status: "high", sourceQuote: "q",
      }],
    });

    const listRes = await (reportsRoute.GET as Handler)(ctx({ url: "/api/reports", repo }));
    const list = (await listRes.json()) as { reports: Array<{ id: string }> };
    assertEqual(list.reports.length, 1);

    const detailRes = await (reportsRoute.GET as Handler)(ctx({ url: `/api/reports?id=${saved.report.id}`, repo }));
    const detail = (await detailRes.json()) as { report: { rawText: string }; metrics: unknown[] };
    assertEqual(detail.report.rawText, "原文");
    assertEqual(detail.metrics.length, 1);

    const missing = await (reportsRoute.GET as Handler)(ctx({ url: "/api/reports?id=nope", repo }));
    assertEqual(missing.status, 404);
  });

  it("删除：存在 → 200，不存在 → 404", async () => {
    const repo = createMemoryRepo();
    const saved = await saveReport(repo, {
      sourceType: "pdf", fileName: null, checkDate: "2025-01-01", hospital: null, rawText: "x",
      metrics: [{ standardName: "s", rawName: "s", valueNum: 1, valueText: "1", unit: null, refLow: null, refHigh: null, refText: null, status: "unknown", sourceQuote: null }],
    });
    const ok = await (reportsRoute.DELETE as Handler)(ctx({ url: `/api/reports?id=${saved.report.id}`, method: "DELETE", repo }));
    assertEqual(ok.status, 200);
    const gone = await (reportsRoute.DELETE as Handler)(ctx({ url: "/api/reports?id=nope", method: "DELETE", repo }));
    assertEqual(gone.status, 404);
  });
});

describe("routes — metrics（手工补录）", () => {
  it("合法 → 201 且入库", async () => {
    const repo = createMemoryRepo();
    const res = await (metricsRoute.POST as Handler)(
      ctx({
        url: "/api/metrics",
        method: "POST",
        repo,
        body: { checkDate: "2025-05-01", metrics: [{ rawName: "空腹血糖", valueText: "5.4", unit: "mmol/L", refText: "3.9-6.1" }] },
      }),
    );
    assertEqual(res.status, 201);
    const data = (await res.json()) as { metrics: Array<{ status: string; standardName: string }> };
    assertEqual(data.metrics[0].standardName, "空腹血糖");
    assertEqual(data.metrics[0].status, "normal");
  });

  it("缺日期 / 无有效指标 → 400", async () => {
    const repo = createMemoryRepo();
    const a = await (metricsRoute.POST as Handler)(
      ctx({ url: "/api/metrics", method: "POST", repo, body: { metrics: [{ rawName: "x", valueText: "1" }] } }),
    );
    assertEqual(a.status, 400);
    const b = await (metricsRoute.POST as Handler)(
      ctx({ url: "/api/metrics", method: "POST", repo, body: { checkDate: "2025-01-01", metrics: [{ rawName: "", valueText: "" }] } }),
    );
    assertEqual(b.status, 400);
  });
});

describe("routes — interpret", () => {
  it("无数据 → 200 且 refused（不是错误码）", async () => {
    const repo = createMemoryRepo();
    const res = await (interpretRoute.POST as Handler)(
      ctx({ url: "/api/interpret", method: "POST", repo, body: { standardName: "甘油三酯" } }),
    );
    assertEqual(res.status, 200);
    const data = (await res.json()) as { refused: boolean; refusalReason: string; disclaimer: string };
    assertEqual(data.refused, true);
    assertEqual(data.refusalReason, "no_data");
    assert(data.disclaimer.length > 0);
  });

  it("有数据 + 正常提问 → 解读文本与引用", async () => {
    const repo = createMemoryRepo();
    await saveReport(repo, {
      sourceType: "pdf", fileName: null, checkDate: "2025-01-01", hospital: null, rawText: "x",
      metrics: [{ standardName: "甘油三酯", rawName: "甘油三酯", valueNum: 2.1, valueText: "2.1", unit: "mmol/L", refLow: 0.45, refHigh: 1.7, refText: "0.45-1.7", status: "high", sourceQuote: null }],
    });
    const res = await (interpretRoute.POST as Handler)(
      ctx({
        url: "/api/interpret", method: "POST", repo,
        body: { standardName: "甘油三酯", question: "这个指标是查什么的" },
        fetchImpl: mockLLM("甘油三酯反映血脂水平……"),
      }),
    );
    assertEqual(res.status, 200);
    const data = (await res.json()) as { refused: boolean; text: string; citations: unknown[] };
    assertEqual(data.refused, false);
    assertEqual(data.text, "甘油三酯反映血脂水平……");
    assertEqual(data.citations.length, 1);
  });

  it("红线提问 → refused 且不调模型", async () => {
    const repo = createMemoryRepo();
    await saveReport(repo, {
      sourceType: "pdf", fileName: null, checkDate: "2025-01-01", hospital: null, rawText: "x",
      metrics: [{ standardName: "甘油三酯", rawName: "甘油三酯", valueNum: 2.1, valueText: "2.1", unit: "mmol/L", refLow: 0.45, refHigh: 1.7, refText: "0.45-1.7", status: "high", sourceQuote: null }],
    });
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;

    const res = await (interpretRoute.POST as Handler)(
      ctx({ url: "/api/interpret", method: "POST", repo, body: { standardName: "甘油三酯", question: "我该吃什么药" }, fetchImpl }),
    );
    assertEqual(res.status, 200);
    const data = (await res.json()) as { refused: boolean; refusalReason: string };
    assertEqual(data.refused, true);
    assertEqual(data.refusalReason, "question_guard");
    assert(!called, "红线提问不应调用模型");
  });
});

describe("routes — trends", () => {
  it("返回按标准名聚合的序列（含 refChanged）", async () => {
    const repo = createMemoryRepo();
    const mk = (date: string, low: number, high: number) => ({
      sourceType: "pdf" as const, fileName: null, checkDate: date, hospital: null, rawText: "x",
      metrics: [{ standardName: "甘油三酯", rawName: "甘油三酯", valueNum: 1.5, valueText: "1.5", unit: "mmol/L", refLow: low, refHigh: high, refText: `${low}-${high}`, status: "normal" as const, sourceQuote: null }],
    });
    await saveReport(repo, mk("2025-01-01", 0.45, 1.7));
    await saveReport(repo, mk("2025-06-01", 0.4, 1.8));

    const res = await (trendsRoute.GET as Handler)(ctx({ url: "/api/trends", repo }));
    assertEqual(res.status, 200);
    const data = (await res.json()) as { series: Array<{ standardName: string; points: unknown[]; refChanged: boolean }> };
    assertEqual(data.series.length, 1);
    assertEqual(data.series[0].points.length, 2);
    assertEqual(data.series[0].refChanged, true);
  });
});