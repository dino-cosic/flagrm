/**
 * Read test counts and names from the result files a test command writes:
 * TRX (`dotnet test --logger trx`) and JUnit XML (Karma, Jest, Vitest, NUnit
 * and most CI reporters). Both are parsed with regexes over tags and
 * attributes, which is enough for these machine-written formats.
 */

import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import type { TestRunResults } from "../types.js";

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = decode(m[2] ?? m[3]);
  return out;
}

function decode(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function empty(): TestRunResults {
  return { total: 0, passed: 0, failed: 0, skipped: 0, names: [], failedNames: [], files: [] };
}

function record(results: TestRunResults, name: string, outcome: "passed" | "failed" | "skipped"): void {
  results.total++;
  results[outcome]++;
  results.names.push(name);
  if (outcome === "failed") results.failedNames.push(name);
}

/** One `<UnitTestResult>` per executed test or data row. */
export function parseTrx(xml: string): TestRunResults {
  const results = empty();
  for (const m of xml.matchAll(/<UnitTestResult\b[^>]*>/g)) {
    const attrs = attributes(m[0]);
    const outcome = (attrs.outcome ?? "").toLowerCase();
    const kind = outcome === "passed" ? "passed" : outcome === "failed" || outcome === "error" ? "failed" : "skipped";
    record(results, attrs.testName ?? "", kind);
  }
  return results;
}

/** Joins a JUnit `classname` and test `name` (Jest's separator; test titles may contain dots). */
export const JUNIT_SEPARATOR = " › ";

/**
 * A test name short enough to read in an overview. TRX names lose their
 * namespace and data-row arguments (`Ns.JobTests.Run(sutProvider: …)` becomes
 * `JobTests.Run(…)`); a JUnit name whose class repeats the title (Jest's
 * default) is shown once. Names are only shortened for display, never compared.
 */
export function shortTestName(name: string): string {
  const sep = name.indexOf(JUNIT_SEPARATOR);
  if (sep >= 0) {
    const cls = name.slice(0, sep);
    const title = name.slice(sep + JUNIT_SEPARATOR.length);
    if (cls.endsWith(title)) return cls;
    if (title.startsWith(cls)) return title;
    return name;
  }
  const paren = name.indexOf("(");
  const qualified = paren >= 0 ? name.slice(0, paren) : name;
  return qualified.split(".").slice(-2).join(".") + (paren >= 0 ? "(…)" : "");
}

/** Short names, each once, with a count when data rows collapse into one (`Run(…) ×3`). */
export function shortTestNames(names: string[]): string[] {
  const counts = new Map<string, number>();
  for (const name of names) {
    const short = shortTestName(name);
    counts.set(short, (counts.get(short) ?? 0) + 1);
  }
  return [...counts].map(([short, n]) => (n > 1 ? `${short} ×${n}` : short));
}

/**
 * The name a test is compared by: a TRX data row without its arguments, since
 * AutoFixture-style attributes put random values in them on every run. JUnit
 * names are kept whole (a test title may contain parentheses).
 */
export function testKey(name: string): string {
  if (name.includes(JUNIT_SEPARATOR)) return name;
  const m = /^([\w.`+<>,[\]]+)\(.*\)$/s.exec(name);
  return m ? m[1] : name;
}

/**
 * The tests in `before` that no longer run and the ones in `after` that are new.
 * Data rows are counted per test, so dropping the OFF row of a theory still
 * shows up; among a test's rows, the ones whose exact name is gone are reported.
 */
export function diffTestNames(before: string[], after: string[]): { removed: string[]; added: string[] } {
  const onlyIn = (from: string[], other: string[]) => {
    const exact = new Set(other);
    const left = new Map<string, number>();
    for (const name of exact) left.set(testKey(name), (left.get(testKey(name)) ?? 0) + 1);
    const rows = new Map<string, string[]>();
    for (const name of new Set(from)) rows.set(testKey(name), [...(rows.get(testKey(name)) ?? []), name]);
    const out: string[] = [];
    for (const [key, names] of rows) {
      const extra = names.length - (left.get(key) ?? 0);
      if (extra > 0)
        out.push(...[...names].sort((a, b) => Number(exact.has(a)) - Number(exact.has(b))).slice(0, extra));
    }
    return out;
  };
  return { removed: onlyIn(before, after), added: onlyIn(after, before) };
}

/**
 * Split the tests failing now into the ones that already failed at the
 * baseline (`known`) and the rest (`new`). Names are compared without TRX
 * data-row arguments, counting rows per test: a theory whose OFF row failed at
 * the baseline and whose ON row fails now has a new failure.
 */
export function splitFailures(baseline: string[], now: string[]): { known: string[]; new: string[] } {
  const left = new Map<string, number>();
  for (const name of baseline) left.set(testKey(name), (left.get(testKey(name)) ?? 0) + 1);
  const out = { known: [] as string[], new: [] as string[] };
  for (const name of now) {
    const n = left.get(testKey(name)) ?? 0;
    if (n > 0) left.set(testKey(name), n - 1);
    (n > 0 ? out.known : out.new).push(name);
  }
  return out;
}

/** One `<testcase>` per test; a `<failure>`/`<error>` child fails it, `<skipped>` skips it. */
export function parseJUnit(xml: string): TestRunResults {
  const results = empty();
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = attributes(m[1]);
    const name = [attrs.classname, attrs.name].filter(Boolean).join(JUNIT_SEPARATOR);
    const body = m[2] ?? "";
    const kind = /<(?:failure|error)\b/.test(body) ? "failed" : /<skipped\b/.test(body) ? "skipped" : "passed";
    record(results, name, kind);
  }
  return results;
}

/** Result files earlier runs read, with their modification time then: a file rewritten since is new data. */
export type ClaimedResults = Map<string, number>;

/**
 * Merge every result file matching `pattern` (an absolute path or glob)
 * modified at or after `since` — test runners keep older result files around.
 * Files in `claimed` that haven't changed since are skipped: another
 * project's run just wrote them, and an overlapping pattern
 * (`./**\/TestResults/*.trx`) would count them twice. The files read are
 * added to `claimed`. Undefined when no such file exists.
 */
export function collectTestResults(
  pattern: string,
  since: number,
  claimed: ClaimedResults = new Map(),
): TestRunResults | undefined {
  // Filesystem timestamps can be coarser than Date.now().
  const cutoff = since - 2000;
  const files = fg
    .sync(path.sep === "\\" ? pattern.replace(/\\/g, "/") : pattern, { absolute: true, dot: true })
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .filter(({ file, mtime }) => mtime >= cutoff && claimed.get(file) !== mtime)
    .sort((a, b) => a.file.localeCompare(b.file));
  for (const { file, mtime } of files) claimed.set(file, mtime);
  if (files.length === 0) return undefined;
  const merged = empty();
  for (const { file } of files) {
    const xml = fs.readFileSync(file, "utf8");
    const parsed = /<TestRun\b/.test(xml) ? parseTrx(xml) : parseJUnit(xml);
    merged.total += parsed.total;
    merged.passed += parsed.passed;
    merged.failed += parsed.failed;
    merged.skipped += parsed.skipped;
    merged.names.push(...parsed.names);
    merged.failedNames.push(...parsed.failedNames);
    merged.files.push(file);
  }
  return merged;
}
