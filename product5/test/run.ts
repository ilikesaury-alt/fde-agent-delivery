/** 测试入口：node --experimental-strip-types test/run.ts */

import { runAll } from "./harness.ts";

import "./rss.test.ts";
import "./store.test.ts";
import "./score.test.ts";
import "./llm.test.ts";
import "./routes.test.ts";

await runAll();