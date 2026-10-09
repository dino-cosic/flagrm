/**
 * Build and test runs a passing full verify saves, so the next baseline or
 * verify on the same tree with the same commands reuses them instead of
 * running them again: in a sequential removal, the next flag's baseline
 * starts on the commit the previous flag's verify passed on.
 */

import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import type { Workspace } from "./adapter.js";
import { flagDir, matchingFiles, runChecks } from "./baseline.js";
import { changeFilter } from "./change-filter.js";
import { configSnapshot, projectCommands } from "./config-snapshot.js";
import { treeFingerprint } from "./git.js";
import { packageVersion } from "./package.js";
import { type CheckRun, JSON_SCHEMA_VERSION, type SavedRuns } from "./types.js";
import { readJson } from "./util.js";

type Planned = { project: string; check: CheckRun["check"] };

export interface FoundRuns {
  saved: SavedRuns;
  /** The saved runs, in the order they were asked for. */
  runs: CheckRun[];
}

/** `.flagrm/<flag>/verify/runs.json`. */
export function runsPath(root: string, flag: string): string {
  return path.join(flagDir(root, flag), "verify", "runs.json");
}

/**
 * The tree the commands will run on: its fingerprint before they run, without
 * flagrm's setup files and the test result files the runs themselves rewrite.
 * Commands are compared on their own, so leaving out the config file is safe.
 * Unlike the Stop hook's fingerprint, `exclude`d paths count: a build or test
 * may read them (a lockfile, generated sources), so a change there must rerun.
 */
export function runsKey(root: string, projects: Workspace): string | undefined {
  const ignore = changeFilter();
  const patterns = projects.flatMap(({ adapter, ctx }) => projectCommands(adapter, ctx).testResults ?? []);
  const results = matchingFiles(root, patterns);
  return treeFingerprint(root, (rel) => ignore(rel) || results.has(rel));
}

/** The (project, check) pairs a run of `only` would run: those with a command. */
export function plannedRuns(projects: Workspace, only: ReadonlyArray<CheckRun["check"]>): Planned[] {
  return projects.flatMap(({ adapter, ctx }) => {
    const commands = projectCommands(adapter, ctx);
    return only.filter((check) => commands[check]).map((check) => ({ project: ctx.name, check }));
  });
}

/**
 * Save a passing full verify's runs; never a set with a setup problem, which would come back on every rerun,
 * nor runs that were themselves reused: the set they came from keeps its own flag and time.
 * The logs are copied next to `runs.json`, so a later verify overwriting its own logs leaves the saved set whole.
 */
export function saveRuns(
  root: string,
  flag: string,
  projects: Workspace,
  key: string,
  runs: CheckRun[],
  createdAt = new Date().toISOString(),
): void {
  if (runs.some((r) => r.failure || r.reused)) return;
  const file = runsPath(root, flag);
  const logDir = path.join(path.dirname(file), "saved");
  fs.mkdirSync(logDir, { recursive: true });
  const kept = runs.map(({ reused: _reused, ...run }) => {
    if (!run.log) return run;
    const log = path.join(logDir, `${run.project}.${run.check}.log`);
    fs.copyFileSync(run.log, log);
    return { ...run, log };
  });
  const saved: SavedRuns = {
    schemaVersion: JSON_SCHEMA_VERSION,
    flagrmVersion: packageVersion(),
    flag,
    createdAt,
    key,
    commands: configSnapshot(projects).projects,
    runs: kept,
  };
  fs.writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`, "utf8");
}

/** Forget every saved set, of any flag, for this tree: a fresh run on it failed, so they may hide a flaky test or a changed machine. */
export function dropRuns(root: string, key: string): void {
  for (const file of fg.sync(".flagrm/*/verify/runs.json", { cwd: root, absolute: true, dot: true })) {
    if (readJson<SavedRuns>(file)?.key === key) fs.rmSync(file, { force: true });
  }
}

/** The newest saved set, of any flag, for this tree and these commands that has every `needed` run and its log. */
export function findRuns(root: string, projects: Workspace, key: string, needed: Planned[]): FoundRuns | undefined {
  if (needed.length === 0) return undefined;
  const commands = JSON.stringify(configSnapshot(projects).projects);
  const version = packageVersion();
  let best: FoundRuns | undefined;
  for (const file of fg.sync(".flagrm/*/verify/runs.json", { cwd: root, absolute: true, dot: true })) {
    const saved = readJson<SavedRuns>(file);
    if (!saved || !Array.isArray(saved.runs) || typeof saved.createdAt !== "string") continue;
    if (saved.key !== key || saved.schemaVersion !== JSON_SCHEMA_VERSION) continue;
    if (saved.flagrmVersion !== version || JSON.stringify(saved.commands) !== commands) continue;
    const runs = needed.map((n) => saved.runs.find((r) => r.project === n.project && r.check === n.check));
    if (runs.some((r) => !r || (r.log !== undefined && !fs.existsSync(r.log)))) continue;
    if (!best || saved.createdAt > best.saved.createdAt) best = { saved, runs: runs as CheckRun[] };
  }
  return best;
}

/** The found runs as this flag's own: logs copied into `logDir` under their usual names, marked `reused`. */
export function reuseRuns(found: FoundRuns, logDir: string): CheckRun[] {
  fs.mkdirSync(logDir, { recursive: true });
  const reused = { flag: found.saved.flag, createdAt: found.saved.createdAt };
  return found.runs.map((run) => {
    if (!run.log) return { ...run, reused };
    const log = path.join(logDir, `${run.project}.${run.check}.log`);
    if (path.resolve(run.log) !== path.resolve(log)) fs.copyFileSync(run.log, log);
    return { ...run, log, reused };
  });
}

/** A baseline's build and test runs: reused from a passing verify on the same tree and commands, else run. */
export async function baselineRuns(root: string, flag: string, projects: Workspace, reuse = true): Promise<CheckRun[]> {
  const logDir = flagDir(root, flag);
  const key = reuse ? runsKey(root, projects) : undefined;
  const found = key ? findRuns(root, projects, key, plannedRuns(projects, ["build", "test"])) : undefined;
  return found ? reuseRuns(found, logDir) : runChecks(projects, logDir);
}

/** One line saying which runs were reused and from where, or undefined when none were. `at`: when they were reused. */
export function reusedNote(runs: ReadonlyArray<Pick<CheckRun, "check" | "reused">>, at: string): string | undefined {
  const reused = runs.find((r) => r.reused)?.reused;
  if (!reused) return undefined;
  const checks = [...new Set(runs.filter((r) => r.reused).map((r) => (r.check === "test" ? "tests" : "build")))];
  const what = checks.length === 2 ? "build and tests" : checks[0];
  return `${what} reused from ${reused.flag}'s verify (same tree and commands, ${age(Date.parse(at) - Date.parse(reused.createdAt))} ago; --no-reuse to run them)`;
}

function age(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "under a minute";
  if (min < 60) return `${min} min`;
  const hours = Math.round(min / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}
