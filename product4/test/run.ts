/** 测试入口：node --experimental-strip-types test/run.ts */

import { runAll } from "./harness.ts";

import "./trend.test.ts";
import "./metrics-dict.test.ts";
import "./extract.test.ts";
import "./interpret-guard.test.ts";
import "./interpret.test.ts";
import "./repo.test.ts";
import "./table-reconstruct.test.ts";
import "./ocr-client.test.ts";
import "./routes.test.ts";

await runAll();