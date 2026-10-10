/**
 * Why each baseline test no longer runs. Deleting the OFF path's tests and
 * dropping the flag from test names is part of a removal, and a narrower test
 * command leaves tests out on purpose; only the rest needs explaining.
 * Without result files, the changed test files' declarations stand in for the
 * names (`declaredTestDiff`).
 */

import fs from "node:fs";
import path from "node:path";
import { flagWords, words } from "../flag-words.js";
import { fileAt } from "../git.js";
import { computeCodeMask, escapeRegExp, isTestPath } from "../scan.js";
import type { RecordedName } from "../types.js";
import { JUNIT_SEPARATOR, testKey } from "./test-results.js";

export interface RemovedTests {
  /** Removed in the diff: gone from a changed test file, or a data row dropped from one. */
  deleted: string[];
  /** The same test under a name without the flag's words. `to` is the new test's name. */
  renamed: Array<{ from: string; to: string }>;
  /** Still in the code, but the test configuration changed since the baseline. */
  excludedByConfig: string[];
  unexplained: string[];
}

export interface RemovedTestsContext {
  /** Config root; `changedFiles` are relative to it. */
  root: string;
  /** Baseline commit, to read changed test files as they were. */
  sha?: string | null;
  changedFiles?: string[];
  names: RecordedName[];
  /** Whether the project's test command, its named files or `testResults` changed since the baseline. */
  testConfigChanged: boolean;
}

/** Sort the tests that no longer run (`removed`) using the new ones (`added`) and the diff. */
export function classifyRemovedTests(
  removed: string[],
  added: string[],
  afterNames: string[],
  ctx: RemovedTestsContext,
): RemovedTests {
  const out: RemovedTests = { deleted: [], renamed: [], excludedByConfig: [], unexplained: [] };
  const renamedTo = matchRenames(removed, added, flagWords(ctx.names));
  const stillRuns = new Set(afterNames.map(testKey));
  const files = changedTestFiles(ctx);
  for (const name of removed) {
    const to = renamedTo.get(testKey(name));
    if (to) out.renamed.push({ from: name, to });
    else if (isDeleted(name, stillRuns.has(testKey(name)), files)) out.deleted.push(name);
    else if (ctx.testConfigChanged) out.excludedByConfig.push(name);
    else out.unexplained.push(name);
  }
  return out;
}

// --- renames -------------------------------------------------------------------

/** A test name's class (`Ns.ClassTests`, JUnit classname) and its own name (method or title). */
function split(key: string): { owner: string; own: string } {
  const sep = key.indexOf(JUNIT_SEPARATOR);
  if (sep >= 0) return { owner: key.slice(0, sep), own: key.slice(sep + JUNIT_SEPARATOR.length) };
  const dot = key.lastIndexOf(".");
  return { owner: key.slice(0, Math.max(dot, 0)), own: key.slice(dot + 1) };
}

function isSubsequence(short: string[], long: string[]): boolean {
  let i = 0;
  for (const w of long) if (i < short.length && w === short[i]) i++;
  return i === short.length;
}

/**
 * Removed test keys mapped to the new test they were renamed to: same class,
 * the new name's words in order within the old one's, and the dropped words
 * include one of the flag's. Each new test explains one old one; the closest
 * (fewest dropped words) wins.
 */
function matchRenames(removed: string[], added: string[], flag: Set<string>): Map<string, string> {
  const addedByKey = new Map<string, string>();
  for (const name of added) if (!addedByKey.has(testKey(name))) addedByKey.set(testKey(name), name);
  const candidates: Array<{ from: string; to: string; dropped: number }> = [];
  for (const from of new Set(removed.map(testKey))) {
    const old = split(from);
    const oldWords = words(old.own);
    for (const to of addedByKey.keys()) {
      const neu = split(to);
      if (neu.owner !== old.owner) continue;
      const newWords = words(neu.own);
      if (newWords.length === 0 || newWords.length >= oldWords.length || !isSubsequence(newWords, oldWords)) continue;
      const dropped = [...oldWords];
      for (const w of newWords) dropped.splice(dropped.indexOf(w), 1);
      if (dropped.some((w) => flag.has(w))) candidates.push({ from, to, dropped: dropped.length });
    }
  }
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const c of candidates.sort((a, b) => a.dropped - b.dropped)) {
    if (out.has(c.from) || used.has(c.to)) continue;
    out.set(c.from, addedByKey.get(c.to) ?? c.to);
    used.add(c.to);
  }
  return out;
}

// --- deletions -----------------------------------------------------------------

interface ChangedTestFile {
  rel: string;
  before: string;
  /** Undefined when the file was deleted. */
  now?: string;
}

function changedTestFiles(ctx: RemovedTestsContext): ChangedTestFile[] {
  if (!ctx.sha) return [];
  const out: ChangedTestFile[] = [];
  for (const rel of ctx.changedFiles ?? []) {
    if (!isTestPath(rel)) continue;
    const before = fileAt(ctx.root, ctx.sha, rel);
    if (before === undefined) continue;
    let now: string | undefined;
    try {
      now = fs.readFileSync(path.join(ctx.root, rel), "utf8");
    } catch {
      now = undefined;
    }
    out.push({ rel, before, now });
  }
  return out;
}

/**
 * Whether a changed test file had this test at the baseline and the edit
 * removed it: the method or title is gone, or (a data row whose test still
 * runs) the file still has it but with fewer rows.
 */
function isDeleted(name: string, keyStillRuns: boolean, files: ChangedTestFile[]): boolean {
  const { owner, own } = split(testKey(name));
  const ownerName = owner.split(/[.+/\\ ]/).pop() ?? "";
  const junit = name.includes(JUNIT_SEPARATOR);
  const has = (text: string) =>
    junit
      ? text.includes(own)
      : new RegExp(`\\b${escapeRegExp(own)}\\b`).test(text) && (!ownerName || text.includes(ownerName));
  return files.some(
    (f) =>
      has(f.before) &&
      (f.now === undefined ||
        !has(f.now) ||
        (keyStillRuns && dataRows(f.now, own, junit) < dataRows(f.before, own, junit))),
  );
}

/** xUnit (`InlineData`, `[Bit]AutoData(...)` with values), NUnit and MSTest attributes that each add a data row. */
const DATA_ROW = /\b(?:\w*InlineData|\w*AutoData|TestCase|DataRow)\s*\(/g;

/** Whether a test file has data-row attributes or `.each` cases. */
function hasDataRows(text: string): boolean {
  return new RegExp(DATA_ROW.source).test(text) || /\.each\s*[(`]/.test(text);
}

/**
 * How many data rows `own` has in `text`: the row attributes between the end
 * of the previous member and its declaration. For JUnit names (`it.each`
 * titles), how often the title appears.
 */
function dataRows(text: string, own: string, junit: boolean): number {
  if (junit) return text.split(own).length - 1;
  let rows = 0;
  for (const m of text.matchAll(new RegExp(`\\b${escapeRegExp(own)}\\s*\\(`, "g"))) {
    const before = text.slice(0, m.index);
    const start = Math.max(before.lastIndexOf("}"), before.lastIndexOf(";"), before.lastIndexOf("{")) + 1;
    rows += before.slice(start).match(DATA_ROW)?.length ?? 0;
  }
  return rows;
}

// --- declarations ----------------------------------------------------------------

const JS_TEST =
  /(?<![\w$.])(describe|fdescribe|xdescribe|context|suite|it|fit|xit|test)(?:\.(?:only|skip))?(?:\.each\s*(?:\([\s\S]*?\)|`[\s\S]*?`))?\s*\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g;

/** `it`/`test` titles prefixed with the titles of the `describe` blocks around them (by brace depth over code). */
function jsTests(text: string): string[] {
  const code = computeCodeMask(text);
  const out: string[] = [];
  const open: Array<{ title: string; depth: number }> = [];
  let depth = 0;
  let pos = 0;
  for (const m of text.matchAll(JS_TEST)) {
    if (!code[m.index]) continue;
    for (; pos < m.index; pos++) if (code[pos]) depth += text[pos] === "{" ? 1 : text[pos] === "}" ? -1 : 0;
    while (open.length && open[open.length - 1].depth >= depth) open.pop();
    if (/describe|context|suite/.test(m[1])) open.push({ title: m[3], depth });
    else out.push([...open.map((d) => d.title), m[3]].join(JUNIT_SEPARATOR));
  }
  return out;
}

const CS_TEST =
  /\[(?:Fact|Theory|Test|TestCase|TestMethod)\b[^\]]*\][\s\S]*?\b(?:void|Task|ValueTask)(?:<[^>]*>)?\s+(\w+)\s*\(/g;

/** Test methods as TRX names them without data-row arguments: `Namespace.Class.Method`. */
function csTests(text: string): string[] {
  const ns = /^\s*namespace\s+([\w.]+)/m.exec(text)?.[1];
  return [...text.matchAll(CS_TEST)].map((m) => {
    const cls = [...text.slice(0, m.index).matchAll(/\bclass\s+(\w+)/g)].pop()?.[1];
    return [ns, cls, m[1]].filter(Boolean).join(".");
  });
}

/** The tests a test file declares, named as result files name them where the syntax allows. */
export function declaredTests(text: string, file: string): string[] {
  if (/\.[cm]?[jt]sx?$/.test(file)) return jsTests(text);
  if (file.endsWith(".cs")) return csTests(text);
  if (file.endsWith(".go")) return [...text.matchAll(/\bfunc (Test\w+)\s*\(/g)].map((m) => m[1]);
  if (file.endsWith(".py")) return [...text.matchAll(/^\s*def (test_\w+)\s*\(/gm)].map((m) => m[1]);
  return [];
}

/** `from` without the names in `other`, counting duplicates. */
function minus(from: string[], other: string[]): string[] {
  const left = new Map<string, number>();
  for (const name of other) left.set(name, (left.get(name) ?? 0) + 1);
  return from.filter((name) => {
    const n = left.get(name) ?? 0;
    left.set(name, n - 1);
    return n <= 0;
  });
}

/**
 * What the changed test files declared at the baseline and don't now, the
 * new declarations, and all declared now: the stand-in for result files'
 * names when there are none.
 */
export function declaredTestDiff(ctx: RemovedTestsContext): {
  removed: string[];
  added: string[];
  now: string[];
  /** Whether a changed file has data rows or `.each` cases, which result logs count one by one and declarations don't. */
  rows: boolean;
} {
  const before: string[] = [];
  const now: string[] = [];
  let rows = false;
  for (const file of changedTestFiles(ctx)) {
    rows ||= hasDataRows(file.before) || (file.now !== undefined && hasDataRows(file.now));
    before.push(...declaredTests(file.before, file.rel));
    if (file.now !== undefined) now.push(...declaredTests(file.now, file.rel));
  }
  return { removed: minus(before, now), added: minus(now, before), now, rows };
}
