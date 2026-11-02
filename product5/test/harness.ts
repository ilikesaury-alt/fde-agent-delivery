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

export async function runAll(): Promise<void> {
  let passed = 0;
  const failures: Array<{ suite: string; name: string; error: unknown }> = [];

  for (const suite of suites) {
    for (const testCase of suite.cases) {
      try {
        await testCase.fn();
        passed++;
      } catch (error) {
        failures.push({ suite: suite.name, name: testCase.name, error });
      }
    }
  }

  for (const f of failures) {
    const message = f.error instanceof Error ? f.error.message : String(f.error);
    console.error(`✖ ${f.suite} › ${f.name}\n  ${message}`);
  }
  console.log(`\n${passed} 通过 / ${failures.length} 失败（共 ${passed + failures.length}）`);
  if (failures.length > 0) process.exitCode = 1;
}