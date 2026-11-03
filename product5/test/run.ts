/** 测试入口：node --experimental-strip-types test/run.ts */

import { runAll } from "./harness.ts";

import "./rss.test.ts";
import "./dedup.test.ts";
import "./coarse.test.ts";
import "./coarse-integration.test.ts";
import "./refresh.test.ts";
import "./store.test.ts";
import "./score.test.ts";
import "./llm.test.ts";
import "./digest.test.ts";
import "./routes.test.ts";
import "./review-fixes.test.ts";

await runAll();