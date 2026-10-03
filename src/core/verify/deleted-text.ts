/**
 * Tests of the OFF path that never name the flag: a flag mock returns false
 * by default, so a test can check OFF behavior without mentioning the flag at
 * all. What gives it away is the text it expects. When the removal deletes a
 * string literal from the code (`"Single organization policy"`), a test still
 * checking that text most likely tests the OFF path. And when no test checks
 * the text that replaced it on the same line, the ON behavior lost coverage.
 */

import fs from "node:fs";
import path from "node:path";
import { fileAt } from "../git.js";
import { computeLexicalMask, isTestPath, LEX_STRING } from "../scan.js";
import { SourceText } from "../source-text.js";
import { toLf } from "../text-utils.js";
import type { CheckFinding } from "../types.js";
import type { VerifyContext } from "./context.js";

/** Extensions whose string literals are read: the `//`-comment languages flagrm's adapters cover. */
const CODE_FILE = /\.(cs|ts|tsx|js|jsx|mjs|cjs|go|java|kt)$/;

/** At most this many findings: the first ones show the pattern. */
const MAX = 20;

interface Literal {
  value: string;
  /** 1-based line. */
  line: number;
}

/** String literals worth looking for in tests: text (a space or 8+ characters, mostly letters), not interpolated. */
export function stringLiterals(text: string): Literal[] {
  const mask = computeLexicalMask(text, "slash");
  const source = new SourceText("", text);
  const out: Literal[] = [];
  let i = 0;
  while (i < text.length) {
    if (mask[i] !== LEX_STRING) {
      i++;
      continue;
    }
    const start = i;
    while (i < text.length && mask[i] === LEX_STRING) i++;
    const raw = text.slice(start, i);
    const m = /^([$@]*)(["'`]{1,3})([\s\S]*?)\2$/.exec(raw);
    if (!m) continue;
    // The lexer leaves a lone `$` (C# `$"..."`) outside the string.
    const interpolated = m[1].includes("$") || text[start - 1] === "$" || m[2] === "`";
    const value = m[3];
    if (interpolated && /\{|\$\{/.test(value)) continue;
    if (!isText(value)) continue;
    out.push({ value, line: source.position(start).line });
  }
  return out;
}

function isText(value: string): boolean {
  const letters = value.replace(/[^\p{L}]/gu, "").length;
  if (letters < 4 || letters < value.length / 2) return false;
  return /\s/.test(value.trim()) || value.length >= 8;
}

/** A deleted literal and the literals on its baseline line that the code still has: what replaced it. */
interface DeletedText {
  value: string;
  file: string;
  counterparts: string[];
}

/**
 * Literals the removal deleted from non-test code: in a changed file at the
 * baseline, and in no non-test file now (a string moved elsewhere wasn't deleted).
 */
function deletedTexts(v: VerifyContext, codeNow: string[], skip: Set<string>): DeletedText[] {
  const sha = v.baseline.git.sha;
  if (!sha || !v.changedFiles) return [];
  const out = new Map<string, DeletedText>();
  for (const rel of v.changedFiles) {
    if (!CODE_FILE.test(rel) || isTestPath(rel)) continue;
    const before = fileAt(v.root, sha, rel);
    if (before === undefined) continue;
    const now = read(path.join(v.root, rel)) ?? "";
    const remaining = new Set(stringLiterals(now).map((l) => l.value));
    const literals = stringLiterals(toLf(before));
    for (const l of literals) {
      if (remaining.has(l.value) || skip.has(l.value) || out.has(l.value)) continue;
      const counterparts = literals
        .filter((o) => o.line === l.line && o.value !== l.value && remaining.has(o.value))
        .map((o) => o.value);
      out.set(l.value, { value: l.value, file: rel, counterparts });
    }
  }
  return [...out.values()].filter((d) => !codeNow.some((text) => text.includes(d.value)));
}

function read(file: string): string | undefined {
  try {
    return toLf(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** The test enclosing `index`: the last `it('title'` / `test(` or C#/Java test method before it. */
function testName(text: string, index: number): string | undefined {
  const before = text.slice(0, index);
  let name: string | undefined;
  for (const m of before.matchAll(
    /\b(?:it|test)\s*\(\s*(['"`])((?:(?!\1).)*)\1|\b(?:public|internal)\s+(?:async\s+)?(?:Task|void)\s+(\w+)\s*\(|\bfunc\s+(Test\w+)\s*\(/g,
  )) {
    name = m[2] ?? m[3] ?? m[4];
  }
  return name;
}

/**
 * Warnings for tests that still check text the removal deleted from the
 * code, and for deleted text whose replacement no test checks.
 */
export function deletedTextFindings(v: VerifyContext): CheckFinding[] {
  const files = new Map<string, { project: string; isTest: boolean }>();
  for (const { ctx } of v.projects) {
    for (const file of ctx.files) {
      if (CODE_FILE.test(file) && !files.has(file)) {
        files.set(file, { project: ctx.name, isTest: isTestPath(path.relative(ctx.root, file)) });
      }
    }
  }
  const tests: Array<{ file: string; project: string; text: string }> = [];
  const code: string[] = [];
  for (const [file, { project, isTest }] of files) {
    const text = read(file);
    if (text === undefined) continue;
    if (isTest) tests.push({ file, project, text });
    else code.push(text);
  }
  const skip = new Set(v.baseline.names.map((n) => n.name));
  const findings: CheckFinding[] = [];
  const deletedList = deletedTexts(v, code, skip);
  const before = deletedList.length ? baselineTests(v) : [];
  for (const deleted of deletedList) {
    const quoted = JSON.stringify(deleted.value);
    let checked = false;
    for (const t of tests) {
      // One finding per test that checks the text, at its first check.
      const seen = new Set<string | undefined>();
      for (let at = t.text.indexOf(deleted.value); at !== -1; at = t.text.indexOf(deleted.value, at + 1)) {
        checked = true;
        const name = testName(t.text, at);
        if (seen.has(name)) continue;
        seen.add(name);
        findings.push({
          severity: "warn",
          project: t.project,
          file: t.file,
          line: new SourceText(t.file, t.text).position(at).line,
          message:
            `${name ? `\`${name}\` ` : ""}checks ${quoted}, which the removal deleted from ${deleted.file}: ` +
            "likely a test of the OFF path (the flag mock returns false by default); delete it",
        });
      }
    }
    const coveredBefore = checked || before.some((text) => text.includes(deleted.value));
    if (coveredBefore && deleted.counterparts.length) {
      // `"Single organization"` inside the OFF test's `"Single organization policy"` isn't a test of it.
      const onTested = deleted.counterparts.some((c) =>
        tests.some((t) => t.text.split(deleted.value).join("\0").includes(c)),
      );
      if (!onTested) {
        findings.push({
          severity: "warn",
          message:
            `a test checked ${quoted} (deleted from ${deleted.file}), but none checks ` +
            `${deleted.counterparts.map((c) => JSON.stringify(c)).join(" or ")}, the text kept on its line: ` +
            "the ON path lost its test coverage",
        });
      }
    }
  }
  if (findings.length <= MAX) return findings;
  return [
    ...findings.slice(0, MAX),
    { severity: "info", message: `and ${findings.length - MAX} more tests checking deleted text` },
  ];
}

/** The baseline text of the test files changed since the baseline: a deleted OFF test is in one of them. */
function baselineTests(v: VerifyContext): string[] {
  const sha = v.baseline.git.sha;
  if (!sha) return [];
  return (v.changedFiles ?? [])
    .filter((rel) => CODE_FILE.test(rel) && isTestPath(rel))
    .map((rel) => fileAt(v.root, sha, rel))
    .filter((text): text is string => text !== undefined);
}
