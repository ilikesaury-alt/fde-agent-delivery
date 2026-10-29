/** 极简测试运行器（零依赖，Node --experimental-strip-types 直接跑） */

type TestFn = () => void | Promise<void>;

type Case = { name: string; fn: TestFn };

const suites: Array<{ name: string; cases: Case[] }> = [];
let current: { name: string; cases: Case[] } | null = null;

export function describe(name: string, fn: () => void): void {
  current = { name, cases: [] };
  suites.push(current);
  fn();
  current = null;
}

export function it(name: string, fn: TestFn): void {
  if (!current) throw new Error("it() must be inside describe()");
  current.cases.push({ name, fn });
}

export function assert(cond: unknown, message = "断言失败"): asserts cond {
  if (!cond) throw new Error(message);
}

export function assertEqual<T>(actual: T, expected: T, message = ""): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}\n  期望: ${b}\n  实际: ${a}`);
}

export async function assertThrows(
  fn: () => unknown | Promise<unknown>,
  matcher?: (err: unknown) => boolean,
  message = "期望抛出异常",
): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    if (matcher && !matcher(err)) {
      throw new Error(`${message}：异常类型/内容不符 → ${String(err)}`);
    }
    return err;
  }
  throw new Error(message);
}

export async function runAll(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const filter = process.env.TEST_FILTER ?? "";

  for (const suite of suites) {
    if (filter && !suite.name.includes(filter)) continue;
    console.log(`\n── ${suite.name} ──`);
    for (const c of suite.cases) {
      if (filter && !suite.name.includes(filter) && !c.name.includes(filter)) continue;
      try {
        await c.fn();
        passed++;
        console.log(`  ✅ ${c.name}`);
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
        failures.push(`${suite.name} › ${c.name}\n${msg}`);
        console.log(`  ❌ ${c.name}`);
        console.log(`     ${err instanceof Error ? err.message.split("\n").join("\n     ") : err}`);
      }
    }
  }

  console.log(`\n${"=".repeat(56)}`);
  console.log(`通过 ${passed} · 失败 ${failed}`);
  if (failures.length) {
    console.log(`\n失败详情:\n${failures.map((f) => `\n${f}`).join("\n")}`);
    process.exitCode = 1;
  }
  return { passed, failed };
}
