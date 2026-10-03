/**
 * The `build` and `tests` checks: the configured commands must exit 0. Tests
 * that no longer run are listed for the agent to account for: deleting the
 * tests of the OFF path is part of removing a flag, losing any other test is not.
 * A changed test file none of whose tests ran is a warning too: the test
 * command doesn't cover it, so verify didn't check the edit.
 */

import fs from "node:fs";
import path from "node:path";
import { errorExcerpt, templateCheckGap } from "../baseline.js";
import { escapeRegExp, isTestPath } from "../scan.js";
import type { CheckFinding, CheckResult, CheckRun, TestComparison } from "../types.js";
import { relativePath } from "../util.js";
import { checkResult, configFindings, plural, skippedResult, type VerifyContext } from "./context.js";
import { classifyRemovedTests } from "./removed-tests.js";
import { diffTestNames, shortTestNames, splitFailures } from "./test-results.js";

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
function noCommandResult(v: VerifyContext, id: "build" | "tests"): CheckResult {
  const summary = `no ${id === "build" ? "build" : "test"} command configured`;
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

export function compareTests(v: VerifyContext): TestComparison[] {
  const out: TestComparison[] = [];
  for (const run of v.runs.filter((r) => r.check === "test")) {
    const before = v.baseline.checks?.find((c) => c.project === run.project && c.check === "test")?.results;
    const after = run.results;
    const comparison: TestComparison = {
      project: run.project,
      before: before?.total,
      after: after?.total,
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
    if (before && after) {
      const { removed, added } = diffTestNames(before.names, after.names);
      Object.assign(comparison, { removed, added });
      Object.assign(
        comparison,
        classifyRemovedTests(removed, added, after.names, {
          root: v.root,
          sha: v.baseline.git.sha,
          changedFiles: v.changedFiles,
          names: v.baseline.names,
          testConfigChanged: v.configChanges.some((c) => c.check === "tests" && c.project === run.project),
        }),
      );
    }
    out.push(comparison);
  }
  return out;
}

/**
 * For a test run that exited non-zero: its failed tests split into the ones
 * that already failed at the baseline and new ones. Undefined when that can't
 * be told (no result files now or at the baseline, or none of them failed, so
 * the command broke some other way).
 */
function splitBaselineFailures(v: VerifyContext, run: CheckRun): { known: string[]; new: string[] } | undefined {
  const before = v.baseline.checks?.find((c) => c.project === run.project && c.check === "test")?.results;
  if (!before || !run.results?.failed) return undefined;
  return splitFailures(before.failedNames, run.results.failedNames);
}

/**
 * A failed test run fails the check, unless every failed test already failed
 * at the baseline: those are known failures, and only warn.
 */
function failedTestFindings(run: CheckRun, failures: { known: string[]; new: string[] } | undefined): CheckFinding[] {
  const list = (names: string[], prefix: string): CheckFinding[] =>
    shortTestNames(names)
      .slice(0, 20)
      .map((name) => ({ severity: "info", message: `${prefix}: ${name}`, project: run.project }));
  if (!failures) {
    return [...failedRunFindings(run).slice(0, 1), ...list(run.results?.failedNames ?? [], "failed")];
  }
  if (failures.new.length === 0) {
    return [
      {
        severity: "warn",
        message: `${plural(failures.known.length, "test fails", "tests fail")}, as at the baseline (known failures; log: ${run.log})`,
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
  if (runs.length === 0) return noCommandResult(v, "tests");
  const findings: CheckFinding[] = configFindings(v, "tests");
  let failed = 0;
  let known = 0;
  for (const run of runs) {
    if (run.exitCode !== 0) {
      const failures = splitBaselineFailures(v, run);
      if (failures?.new.length !== 0) failed++;
      known += failures?.known.length ?? 0;
      findings.push(...failedTestFindings(run, failures));
      if (run.failure) findings.push(setupFinding(run));
    }
    const ctx = v.projects.find(({ ctx }) => ctx.name === run.project)?.ctx;
    const project = ctx?.project;
    const comparison = comparisons.find((c) => c.project === run.project);
    if (project?.testResults && !run.results) {
      findings.push({
        severity: "warn",
        message: `no test results found at ${project.testResults}, so the test count was not compared`,
        project: run.project,
      });
    } else if (run.results && comparison?.before === undefined) {
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
    if (run.results && ctx) {
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
