/**
 * `flagrm verify <flag>`: the pass/fail gate for a removal. It compares the
 * current tree with the flag's baseline (`flagrm baseline`), runs the checks
 * and writes `.flagrm/<flag>/verify.json`.
 */

import fs from "node:fs";
import path from "node:path";
import type { Workspace } from "../adapter.js";
import { flagDir, readBaseline, runChecks, verifyPath } from "../baseline.js";
import { changeFilter, changeFilterAt } from "../change-filter.js";
import { configChanges as configChangesSince, configSnapshot } from "../config-snapshot.js";
import { changedFilesSince, gitState, treeFingerprint } from "../git.js";
import {
  CHECK_IDS,
  type CheckId,
  type CheckResult,
  type CheckRun,
  JSON_SCHEMA_VERSION,
  type VerifyReport,
  type VerifyRun,
} from "../types.js";
import { buildCheck, compareTests, testsCheck } from "./commands.js";
import { skippedResult, type VerifyContext } from "./context.js";
import { deadCodeCheck } from "./dead-code.js";
import { leftoversCheck } from "./leftovers.js";

export interface VerifyOptions {
  /** Checks not to run; they report `skipped`. */
  skip?: CheckId[];
  /** Treat warnings as failures. */
  strict?: boolean;
}

export async function verifyFlag(
  root: string,
  projects: Workspace,
  flag: string,
  options: VerifyOptions = {},
): Promise<{ report: VerifyReport; file: string }> {
  const { baseline, file: baselineFile } = readBaseline(root, flag);
  const skip = new Set(options.skip ?? []);

  // Take the git state before running commands: their output (bin/, test
  // results) is not part of the change under review.
  const git = gitState(root);
  // flagrm's setup files and `exclude`d paths (the config's and --exclude) aren't part of the removal.
  const ignore = changeFilter(projects[0]?.ctx.config);
  const changedFiles = baseline.git.sha ? changedFilesSince(root, baseline.git.sha, ignore) : undefined;

  const only = [...(skip.has("build") ? [] : ["build" as const]), ...(skip.has("tests") ? [] : ["test" as const])];
  const runs = only.length ? await runChecks(projects, path.join(flagDir(root, flag), "verify"), only) : [];
  // The fingerprint, though, is the tree the Stop hook will see next, so take it
  // after the commands: a test report they write outside .gitignore is part of it.
  // The Stop hook compares it with its own, so take it exactly as the hook does: from the config file
  // alone, without --exclude, which the hook can't know.
  const fingerprint = treeFingerprint(root, changeFilterAt(root));

  const now = configSnapshot(projects);
  const configChanges = configChangesSince(baseline.acceptedConfig ?? baseline.config, now);
  const originalConfigChanges = baseline.acceptedConfig ? configChangesSince(baseline.config, now) : configChanges;
  const v: VerifyContext = { root, flag, projects, baseline, changedFiles, runs, configChanges, originalConfigChanges };
  const tests = compareTests(v);
  const run: Record<Exclude<CheckId, "leftovers">, () => CheckResult> = {
    "dead-code": () => deadCodeCheck(v),
    build: () => buildCheck(v),
    tests: () => testsCheck(v, tests),
  };
  const checks: CheckResult[] = [];
  for (const id of CHECK_IDS) {
    if (skip.has(id)) checks.push(skippedResult(id, "skipped (--skip)"));
    else checks.push(id === "leftovers" ? await leftoversCheck(v) : run[id]());
  }

  const strict = Boolean(options.strict);
  const failed = checks.some((c) => c.status === "fail" || (strict && c.status === "warn"));
  const report: VerifyReport = {
    schemaVersion: JSON_SCHEMA_VERSION,
    flag,
    status: failed ? "fail" : "pass",
    strict,
    createdAt: new Date().toISOString(),
    baseline: { file: baselineFile, createdAt: baseline.createdAt, git: baseline.git },
    git,
    fingerprint,
    changedFiles,
    checks,
    skipped: CHECK_IDS.filter((id) => skip.has(id)),
    runs: runs.map(countsOnly),
    tests,
  };
  const file = verifyPath(root, flag);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, file };
}

/** Drop the per-test name lists: thousands of names in a large suite, and `tests` already has the comparison. */
function countsOnly(run: CheckRun): VerifyRun {
  if (!run.results) return run;
  const { names: _names, failedNames: _failed, ...counts } = run.results;
  return { ...run, results: counts };
}

/** Parse `--skip build,tests`; throws on an unknown check name. */
export function parseSkip(value: string | undefined): CheckId[] {
  if (!value) return [];
  const ids = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of ids) {
    if (!(CHECK_IDS as readonly string[]).includes(id)) {
      throw new Error(`Unknown check "${id}" in --skip. Checks: ${CHECK_IDS.join(", ")}.`);
    }
  }
  return ids as CheckId[];
}
