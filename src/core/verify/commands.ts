/**
 * The `build` and `tests` checks: the configured commands must exit 0. Tests
 * that no longer run are listed for the agent to account for: deleting the
 * tests of the OFF path is part of removing a flag, losing any other test is not.
 * A changed test file none of whose tests ran is a warning too: the test
 * command doesn't cover it, so verify didn't check the edit.
 *
 * The `lint` check: a failing lint command fails. One that already failed at
 * the baseline (lint debt) only warns, unless its log has error lines the
 * baseline's didn't.
 */

import fs from "node:fs";
import path from "node:path";
import { errorExcerpt, logLines, looksLikeError, templateCheckGap } from "../baseline.js";
import { projectCommands } from "../config-snapshot.js";
import { escapeRegExp, isTestPath } from "../scan.js";
import {
  type CheckFinding,
  type CheckResult,
  type CheckRun,
  RUN_CHECK_ID,
  type TestComparison,
  type TestRunResults,
} from "../types.js";
import { relativePath } from "../util.js";
import { checkResult, configFindings, plural, skippedResult, type VerifyContext } from "./context.js";
import { classifyRemovedTests, declaredTestDiff } from "./removed-tests.js";
import { diffTestNames, hasTestNames, shortTestNames, splitFailures } from "./test-results.js";

function failedRunFindings(run: CheckRun): CheckFinding[] {
  const findings: CheckFinding[] = [
    {
      severity: "fail",
      message: `\`${run.command}\` exited with ${run.exitCode} (log: ${run.log})`,
      project: run.project,
      file: run.log,
    },
  ];
  if (run.failure) findings.push(setupFinding(run));
  else
    for (const line of errorExcerpt(run.log)) findings.push({ severity: "info", message: line, project: run.project });
  return findings;
}

/** A failed run's setup problem: the machine, not the edit, is what needs fixing. */
function setupFinding(run: CheckRun): CheckFinding {
  return { severity: "info", message: `setup problem: ${run.failure?.message}`, project: run.project };
}

/** No command to run: skipped, unless the baseline had one, which is worth a warning. */
function noCommandResult(v: VerifyContext, kind: CheckRun["check"]): CheckResult {
  const id = RUN_CHECK_ID[kind];
  const summary = `no ${kind} command configured`;
  const findings = configFindings(v, id);
  return findings.length ? checkResult(id, summary, findings) : skippedResult(id, summary);
}

export function buildCheck(v: VerifyContext): CheckResult {
  const runs = v.runs.filter((r) => r.check === "build");
  if (runs.length === 0) return noCommandResult(v, "build");
  const findings = runs.flatMap((r) => (r.exitCode === 0 ? [] : failedRunFindings(r)));
  findings.push(...configFindings(v, "build"));
  for (const run of runs) {
    const project = v.projects.find(({ ctx }) => ctx.name === run.project);
    const gap = project && templateCheckGap(project.adapter, run.command);
    if (!gap) continue;
    const templates = (v.changedFiles ?? [])
      .filter((rel) => rel.endsWith(".html"))
      .filter((rel) => !path.relative(project.ctx.root, path.join(v.root, rel)).startsWith(".."));
    if (templates.length) findings.push({ severity: "warn", message: gap, project: run.project });
  }
  const failed = runs.filter((r) => r.exitCode !== 0).length;
  const summary = failed
    ? `${plural(failed, "build")} failed`
    : `${runs.map((r) => r.project).join(", ")} built successfully`;
  return checkResult("build", summary, findings);
}

export function lintCheck(v: VerifyContext): CheckResult {
  const runs = v.runs.filter((r) => r.check === "lint");
  if (runs.length === 0) return noCommandResult(v, "lint");
  const findings: CheckFinding[] = [];
  let failed = 0;
  let known = 0;
  for (const run of runs) {
    if (run.exitCode === 0) continue;
    const before = v.baseline.checks?.find((c) => c.project === run.project && c.check === "lint");
    // A setup problem, or a run cut short, is no lint debt: it fails even when the baseline failed too.
    if (run.failure || run.interrupted || !before || before.exitCode === 0 || before.failure || before.interrupted) {
      failed++;
      findings.push(...failedRunFindings(run));
      if (!before) {
        findings.push({
          severity: "info",
          message:
            "the baseline has no lint run to compare with (lint configured after it, or baseline --no-checks), so every lint error fails: show the user",
          project: run.project,
        });
      }
      continue;
    }
    const debt = knownLintFindings(before, run);
    if (debt.some((f) => f.severity === "fail")) failed++;
    else known++;
    findings.push(...debt);
  }
  findings.push(...configFindings(v, "lint"));
  const summary = failed
    ? `${plural(failed, "lint run")} failed`
    : known
      ? `${plural(known, "lint run fails", "lint runs fail")} as at the baseline`
      : `${runs.map((r) => r.project).join(", ")} linted cleanly`;
  return checkResult("lint", summary, findings);
}

/**
 * A lint run that failed at the baseline too: compared line by line with the
 * baseline's log. Numbers are masked first, so an old error whose line moved
 * (`40:5` → `30:5`) or a changed problem count isn't new. Lines are counted,
 * not just compared: ESLint prints an error without its file, so a second
 * identical one is still new. A new line that looks like an error fails; other
 * new lines only warn. At most 20 are listed, errors first.
 */
function knownLintFindings(before: CheckRun, run: CheckRun): CheckFinding[] {
  const was = logLines(before.log);
  if (!was) {
    return [
      {
        severity: "warn",
        message: `lint already failed at the baseline; its log wasn't found, so new errors can't be told (log: ${run.log})`,
        project: run.project,
        file: run.log,
      },
    ];
  }
  const mask = (line: string) => line.replace(/\d+/g, "#");
  const seen = new Map<string, number>();
  for (const line of was) seen.set(mask(line), (seen.get(mask(line)) ?? 0) + 1);
  const added = (logLines(run.log) ?? []).filter((line) => {
    const left = seen.get(mask(line)) ?? 0;
    seen.set(mask(line), left - 1);
    return left <= 0;
  });
  const errors = added.filter(looksLikeError);
  const listed = [...errors, ...added.filter((line) => !looksLikeError(line))].slice(0, 20);
  const head: CheckFinding = errors.length
    ? {
        severity: "fail",
        message: `lint already failed at the baseline, but ${plural(errors.length, "error line is", "error lines are")} new: fix ${errors.length === 1 ? "it" : "them"} (log: ${run.log})`,
        project: run.project,
        file: run.log,
      }
    : {
        severity: "warn",
        message: `lint already failed at the baseline: ${added.length ? `${plural(added.length, "new line")} in the log, none an error` : "no new lines in the log"} (log: ${run.log})`,
        project: run.project,
        file: run.log,
      };
  return [
    head,
    ...listed.map((line) => ({ severity: "info" as const, message: `new: ${line}`, project: run.project })),
  ];
}

export function compareTests(v: VerifyContext): TestComparison[] {
  const out: TestComparison[] = [];
  for (const run of v.runs.filter((r) => r.check === "test")) {
    const before = v.baseline.checks?.find((c) => c.project === run.project && c.check === "test")?.results;
    const after = run.results;
    const counted = (r: TestRunResults | undefined) => (r && (r.total > 0 || hasTestNames(r)) ? r.total : undefined);
    const comparison: TestComparison = {
      project: run.project,
      before: counted(before),
      after: counted(after),
      removed: [],
      added: [],
      deleted: [],
      renamed: [],
      excludedByConfig: [],
      unexplained: [],
      newFailures: [],
      knownFailures: [],
    };
    if (after) comparison.failed = after.failed;
    const failures = splitBaselineFailures(v, run);
    if (failures) {
      comparison.newFailures = shortTestNames(failures.new);
      comparison.knownFailures = shortTestNames(failures.known);
    }
    const projectRoot = v.projects.find(({ ctx }) => ctx.name === run.project)?.ctx.root;
    const removedCtx = {
      root: v.root,
      sha: v.baseline.git.sha,
      changedFiles: projectRoot
        ? (v.changedFiles ?? []).filter((rel) => !path.relative(projectRoot, path.join(v.root, rel)).startsWith(".."))
        : v.changedFiles,
      names: v.baseline.names,
      testConfigChanged: v.originalConfigChanges.some((c) => c.check === "tests" && c.project === run.project),
    };
    if (hasTestNames(before) && hasTestNames(after)) {
      const { removed, added } = diffTestNames(before.names, after.names);
      Object.assign(comparison, { removed, added });
      Object.assign(comparison, classifyRemovedTests(removed, added, after.names, removedCtx));
    } else {
      // No names from result files on both sides: the test files' declarations show what the diff deleted or renamed.
      const declared = declaredTestDiff(removedCtx);
      const { renamed } = classifyRemovedTests(declared.removed, declared.added, declared.now, removedCtx);
      const from = new Set(renamed.map((r) => r.from));
      Object.assign(comparison, {
        removed: declared.removed,
        added: declared.added,
        renamed,
        deleted: declared.removed.filter((name) => !from.has(name)),
      });
      if (comparison.before !== undefined && comparison.after !== undefined) {
        const gap =
          comparison.before - comparison.after - comparison.deleted.length + (declared.added.length - renamed.length);
        if (gap > 0) {
          comparison.missing = gap;
          if (declared.rows) comparison.missingMayBeRows = true;
        }
      }
    }
    out.push(comparison);
  }
  return out;
}

/**
 * For a test run that exited non-zero: its failed tests split into the ones
 * that already failed at the baseline and new ones. Undefined when that can't
 * be told (no results now or at the baseline, from different sources, or none of them failed, so
 * the command broke some other way).
 */
function splitBaselineFailures(v: VerifyContext, run: CheckRun): { known: string[]; new: string[] } | undefined {
  const before = v.baseline.checks?.find((c) => c.project === run.project && c.check === "test")?.results;
  if (!before || !run.results?.failed) return undefined;
  // Counts without all their names (a log may not name every failing test) can't be split.
  if (run.results.failedNames.length < run.results.failed || before.failedNames.length < before.failed)
    return undefined;
  // Names from a log and from result files aren't spelled alike, so they can't be matched.
  if ((before.source ?? "files") !== (run.results.source ?? "files")) return undefined;
  return splitFailures(before.failedNames, run.results.failedNames);
}

/**
 * A failed test run fails the check, unless every failed test already failed
 * at the baseline: those are known failures, and only warn, or are only
 * listed once the user accepted them (`baseline --accept failures`).
 */
function failedTestFindings(
  run: CheckRun,
  failures: { known: string[]; new: string[] } | undefined,
  accepted = false,
): CheckFinding[] {
  const list = (names: string[], prefix: string): CheckFinding[] =>
    shortTestNames(names)
      .slice(0, 20)
      .map((name) => ({ severity: "info", message: `${prefix}: ${name}`, project: run.project }));
  if (!failures) {
    const names = run.results?.failedNames ?? [];
    const [head, ...excerpt] = failedRunFindings(run);
    // Without failing test names, the log's error lines are all there is to go on; the caller adds a setup problem.
    return [head, ...(names.length || run.failure ? [] : excerpt), ...list(names, "failed")];
  }
  if (failures.new.length === 0) {
    return [
      {
        severity: accepted ? "info" : "warn",
        message: `${plural(failures.known.length, "test fails", "tests fail")}, as at the baseline (known failures${accepted ? ", accepted" : ""}; log: ${run.log})`,
        project: run.project,
        file: run.log,
      },
      ...list(failures.known, "known failure"),
    ];
  }
  return [
    {
      severity: "fail",
      message: `${plural(failures.new.length, "test fails that", "tests fail that")} passed or didn't run at the baseline (log: ${run.log})`,
      project: run.project,
      file: run.log,
    },
    ...list(failures.new, "new failure"),
    ...(failures.known.length
      ? [
          {
            severity: "info" as const,
            message: `plus ${plural(failures.known.length, "known failure")} from the baseline`,
            project: run.project,
          },
        ]
      : []),
  ];
}

export function testsCheck(v: VerifyContext, comparisons: TestComparison[]): CheckResult {
  const runs = v.runs.filter((r) => r.check === "test");
  if (runs.length === 0) return noCommandResult(v, "test");
  const findings: CheckFinding[] = configFindings(v, "tests");
  let failed = 0;
  let known = 0;
  for (const run of runs) {
    if (run.exitCode !== 0) {
      const failures = splitBaselineFailures(v, run);
      if (failures?.new.length !== 0) failed++;
      known += failures?.known.length ?? 0;
      findings.push(...failedTestFindings(run, failures, v.baseline.acceptedFailures));
      if (run.failure) findings.push(setupFinding(run));
    }
    const entry = v.projects.find(({ ctx }) => ctx.name === run.project);
    const ctx = entry?.ctx;
    const testResults = entry && projectCommands(entry.adapter, entry.ctx).testResults;
    const comparison = comparisons.find((c) => c.project === run.project);
    if (testResults && !hasTestNames(run.results)) {
      findings.push({
        severity: "warn",
        message: `no test results found at ${testResults}, so tests were not compared by name${run.results ? " (failing tests and counts read from the log)" : ""}`,
        project: run.project,
      });
    } else if (hasTestNames(run.results) && comparison?.before === undefined) {
      findings.push({
        severity: "info",
        message: "the baseline has no test results to compare with (run `flagrm baseline` before the removal)",
        project: run.project,
      });
    }
    const unexplained = comparison?.unexplained ?? [];
    if (unexplained.length) {
      findings.push({
        severity: "warn",
        message: `${plural(unexplained.length, "test no longer runs", "tests no longer run")} though the diff doesn't delete or rename it and the test config is unchanged: account for ${unexplained.length === 1 ? "it" : "them"} in the PR`,
        project: run.project,
      });
      for (const name of shortTestNames(unexplained).slice(0, 20)) {
        findings.push({ severity: "info", message: `no longer runs: ${name}`, project: run.project });
      }
    }
    const missing = comparison?.missing ?? 0;
    if (missing > 0 && comparison) {
      const configChanged = v.originalConfigChanges.some((c) => c.check === "tests" && c.project === run.project);
      findings.push({
        severity: configChanged || comparison.missingMayBeRows ? "info" : "warn",
        message: `${plural(missing, "more test stopped running", "more tests stopped running")} than the diff deletes (${comparison.before} → ${comparison.after}, ${comparison.deleted.length} deleted): account for ${missing === 1 ? "it" : "them"} in the PR${comparison.missingMayBeRows ? " (data rows and .each cases count separately, so this may be them)" : ""}`,
        project: run.project,
      });
    }
    if (hasTestNames(run.results) && ctx) {
      for (const file of changedTestFiles(v, ctx.root)) {
        if (testFileRan(file, ctx.root, run.results.names)) continue;
        findings.push({
          severity: "warn",
          message:
            "changed, but none of its tests ran, so verify didn't check it: run them yourself or widen the project's `test` command",
          project: run.project,
          file,
        });
      }
    }
  }
  const counts = comparisons
    .filter((c) => c.after !== undefined)
    .map((c) => {
      if (c.before === undefined) return `${c.project} ${c.after}`;
      const why = [
        c.deleted.length && `${c.deleted.length} deleted`,
        c.renamed.length && `${c.renamed.length} renamed`,
        c.excludedByConfig.length && `${c.excludedByConfig.length} excluded by config`,
        c.unexplained.length && `${c.unexplained.length} unexplained`,
        c.missing && `${c.missing} unaccounted for`,
      ].filter(Boolean);
      return `${c.project} ${c.before} → ${c.after}${why.length ? `: ${why.join(", ")}` : ""}`;
    });
  const summary = [
    failed ? `${plural(failed, "test run")} failed` : "tests passed",
    known ? `apart from ${plural(known, "known failure")}` : undefined,
    counts.length ? `(${counts.join("; ")})` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  return checkResult("tests", summary, findings);
}

/** Absolute paths of test files under `root` changed since the baseline that still exist. */
function changedTestFiles(v: VerifyContext, root: string): string[] {
  return (v.changedFiles ?? [])
    .map((rel) => path.join(v.root, rel))
    .filter((file) => !path.relative(root, file).startsWith(".."))
    .filter((file) => isTestPath(path.relative(root, file)) && fs.existsSync(file));
}

/**
 * Whether any of a test file's tests are among the names in the test results.
 * Result formats don't reliably record the source file, so this matches what
 * the names do carry: the file path (Vitest), the class named after the file
 * (xUnit/NUnit/JUnit, qualified by the file's namespace or package when it
 * declares one, so a unit and an integration test class of the same name
 * aren't confused), the first `describe` title (Jest, Karma), or a
 * `TestX`/`test_x` function name (Go, pytest).
 */
export function testFileRan(file: string, root: string, names: string[]): boolean {
  const rel = relativePath(root, file);
  const base = path.basename(file).replace(/\.[^.]+$/, "");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return true;
  }
  const keys = [rel];
  const describe = /\b(?:describe|suite|context)(?:\.\w+)?\s*\(\s*(["'`])((?:(?!\1).)+)\1/.exec(text)?.[2];
  if (describe) keys.push(describe);
  for (const m of text.matchAll(/\bfunc (Test\w+)|\bdef (test_\w+)/g)) keys.push(m[1] ?? m[2]);
  const ns = /^\s*(?:namespace|package)\s+([\w.]+)/m.exec(text)?.[1];
  const qualified = ns ? `${ns}.${base}` : base;
  const className = new RegExp(`(?:^|[./\\\\ ])${escapeRegExp(qualified)}(?:[./\\\\ ]|$)`);
  return names.some((name) => className.test(name) || keys.some((key) => name.includes(key)));
}
