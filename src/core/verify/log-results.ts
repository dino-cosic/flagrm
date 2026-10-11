/**
 * Test results from a test command's log, for a run without result files:
 * the failing tests' names and the summary counts the common runners print
 * (Karma, Jest, Vitest, `dotnet test`; Go and pytest failures without
 * counts). Passing tests aren't in these logs, so only failing ones are named.
 */

import type { TestRunResults } from "../types.js";
import { JUNIT_SEPARATOR } from "./test-results.js";

interface Counts {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

const vitestName = (name: string) => name.split(" > ").join(JUNIT_SEPARATOR);

/** A failing test's name in one log line, per runner. */
const FAILED: Array<[RegExp, (m: RegExpExecArray) => string | undefined]> = [
  // Karma: `Chrome Headless 120.0.0.0 (Mac OS 10.15.7) CheckoutComponent places the order FAILED`
  [/^\S.*? \d[\d.]* \((?:Mac OS|Linux|Windows|Ubuntu)[^)]*\) (.+?) FAILED$/, (m) => m[1]],
  // Jest: `● CheckoutComponent › places the order`; its notices (`● Console`, `● Multiple configurations found:`) aren't tests
  [/^● (.+)$/, (m) => (/^(?:Test suite failed to run|Console)$|:$/.test(m[1]) ? undefined : m[1])],
  // Vitest: `FAIL  src/a.spec.ts > Suite > title` (optionally after a `|project|` tag) and `× Suite > title 12ms`
  [/^FAIL\s+(?:\|[^|]+\|\s+)?\S+ > (.+)$/, (m) => vitestName(m[1])],
  [/^[×✗] (.+ > .+?)(?: \d+ms)?$/, (m) => vitestName(m[1])],
  // dotnet test: `Failed Shop.Tests.CheckoutTests.Quote(express: False) [12 ms]`
  [/^Failed (\S.*?) \[(?:< ?)?[\d.,]+ (?:ms|s|m)\]$/, (m) => m[1]],
  // go test: `--- FAIL: TestX (0.00s)`
  [/^--- FAIL: (\S+)/, (m) => m[1]],
  // pytest: `FAILED tests/test_a.py::test_x - AssertionError`
  [/^FAILED (\S+::\S+)/, (m) => m[1]],
];

function count(parts: string, word: string): number {
  return Number(new RegExp(`(\\d+) ${word}`).exec(parts)?.[1] ?? 0);
}

/**
 * The summary counts in one log line; `sum` for runners that print one
 * summary per test project, `browser` for Karma's one summary per browser.
 */
function summary(line: string): { counts: Counts; sum?: boolean; browser?: string } | undefined {
  // Karma, possibly several `\r`-separated progress updates: the last one counts.
  const karma = [
    ...line.matchAll(
      /(?:^|\r)\s*(?:(\S[^\r]*?):\s+)?Executed (\d+) of (\d+)(?: \((\d+) FAILED\))?(?: \(skipped (\d+)\))?/g,
    ),
  ].pop();
  if (karma) {
    const failed = Number(karma[4] ?? 0);
    return {
      counts: { total: Number(karma[3]), passed: Number(karma[2]) - failed, failed, skipped: Number(karma[5] ?? 0) },
      browser: karma[1] ?? "",
    };
  }
  const jest = /^Tests:\s+(.*?)(\d+) total/.exec(line);
  if (jest) {
    return {
      counts: {
        total: Number(jest[2]),
        passed: count(jest[1], "passed"),
        failed: count(jest[1], "failed"),
        skipped: count(jest[1], "skipped") + count(jest[1], "todo"),
      },
    };
  }
  const vitest = /^Tests\s+(.+)\((\d+)\)$/.exec(line);
  if (vitest) {
    return {
      counts: {
        total: Number(vitest[2]),
        passed: count(vitest[1], "passed"),
        failed: count(vitest[1], "failed"),
        skipped: count(vitest[1], "skipped") + count(vitest[1], "todo"),
      },
    };
  }
  const dotnet = /^(?:Failed|Passed)!\s+-\s+Failed:\s+(\d+), Passed:\s+(\d+), Skipped:\s+(\d+), Total:\s+(\d+)/.exec(
    line,
  );
  if (dotnet) {
    return {
      counts: {
        failed: Number(dotnet[1]),
        passed: Number(dotnet[2]),
        skipped: Number(dotnet[3]),
        total: Number(dotnet[4]),
      },
      sum: true,
    };
  }
  return undefined;
}

const add = (a: Counts, b: Counts): Counts => ({
  total: a.total + b.total,
  passed: a.passed + b.passed,
  failed: a.failed + b.failed,
  skipped: a.skipped + b.skipped,
});

export function parseTestLog(text: string): TestRunResults | undefined {
  const failed = new Set<string>();
  let counts: Counts | undefined;
  const browsers = new Map<string, Counts>();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colors
  for (const raw of text.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    const line = raw.trim();
    const found = summary(line);
    if (found?.browser !== undefined) {
      // Several browsers each run every test: the last summary per browser counts, summed over browsers.
      browsers.set(found.browser, found.counts);
      counts = [...browsers.values()].reduce(add);
    } else if (found) {
      counts = found.sum && counts ? add(counts, found.counts) : found.counts;
    }
    // Karma's progress updates share a line through `\r`: names are looked for in each part.
    for (const part of line.split("\r")) {
      for (const [pattern, name] of FAILED) {
        const m = pattern.exec(part.trim());
        const found = m && name(m);
        if (found) {
          failed.add(found);
          break;
        }
      }
    }
  }
  if (!counts && failed.size === 0) return undefined;
  const names = [...failed];
  return {
    total: counts?.total ?? 0,
    passed: counts?.passed ?? 0,
    failed: counts?.failed ?? names.length,
    skipped: counts?.skipped ?? 0,
    names,
    failedNames: [...names],
    files: [],
    source: "log",
  };
}
