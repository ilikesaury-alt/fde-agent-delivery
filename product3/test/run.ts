/** 测试入口：node --experimental-strip-types test/run.ts */

import { runAll } from "./harness.ts";

import "./chunk.test.ts";
import "./hash.test.ts";
import "./fetch-article.test.ts";
import "./ingest.test.ts";
import "./retrieve.test.ts";
import "./hybrid.test.ts";
import "./conversation.test.ts";
import "./ocr.test.ts";
import "./answer.test.ts";
import "./repo.test.ts";
import "./routes.test.ts";

await runAll();