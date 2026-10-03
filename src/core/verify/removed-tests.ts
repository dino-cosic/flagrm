/**
 * Why each baseline test no longer runs. Deleting the OFF path's tests and
 * dropping the flag from test names is part of a removal, and a narrower test
 * command leaves tests out on purpose; only the rest needs explaining.
 */

import fs from "node:fs";
import path from "node:path";
import { flagWords, words } from "../flag-words.js";
import { fileAt } from "../git.js";
import { escapeRegExp, isTestPath } from "../scan.js";
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
    out.push({ before, now });
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
  return files.some((f) => has(f.before) && (f.now === undefined || !has(f.now) || keyStillRuns));
}
