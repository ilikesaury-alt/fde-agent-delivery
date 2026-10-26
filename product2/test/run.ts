/** 测试入口：node --experimental-strip-types test/run.ts */

import { runAll } from "./harness.ts";

import "./note.test.ts";
import "./fetch-article.test.ts";
import "./llm.test.ts";
import "./pipeline.test.ts";
import "./store.test.ts";
import "./routes.test.ts";

await runAll();
