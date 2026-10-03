import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Adapter, ProjectContext, Workspace } from "./adapter.js";
import { CONFIG_FILENAMES } from "./config.js";
import { configSnapshot, projectCommands } from "./config-snapshot.js";
import { environmentProblem } from "./environment.js";
import { changedFilesSince } from "./git.js";
import { buildInventory } from "./inventory.js";
import {
  type Baseline,
  type CheckRun,
  type FlagFlowName,
  type GitState,
  JSON_SCHEMA_VERSION,
  type ParameterizedTest,
  READABLE_BASELINE_VERSIONS,
  type RecordedName,
} from "./types.js";
import { readJson, relativePath } from "./util.js";
import { collectTestResults, shortTestNames } from "./verify/test-results.js";

/**
 * `.flagrm/<flag>/` under the config root. A name that isn't safe as a directory
 * (`team/new`, `..`) is sanitized and suffixed with a hash of the original, so
 * it stays inside `.flagrm/` and can't collide with another flag's directory.
 */
export function flagDir(root: string, flag: string): string {
  const safe = flag.replace(/[^\w.-]/g, "_");
  if (flag && safe === flag && !flag.startsWith(".")) return path.join(root, ".flagrm", flag);
  const hash = createHash("sha256").update(flag).digest("hex").slice(0, 8);
  return path.join(root, ".flagrm", `${safe.replace(/^\.+/, "")}-${hash}`);
}

export function baselinePath(root: string, flag: string): string {
  return path.join(flagDir(root, flag), "baseline.json");
}

/** `.flagrm/<flag>/verify.json`: the last verify result. */
export function verifyPath(root: string, flag: string): string {
  return path.join(flagDir(root, flag), "verify.json");
}

/** At most this many failed test names in `baseline --json`. */
const MAX_FAILED_NAMES = 20;

/**
 * What `baseline --json` prints: the baseline without the per-test name lists
 * (every test of a large suite, with its data-row arguments: megabytes) and
 * the config snapshot. Failed tests are listed by short name, at most 20;
 * `baseline.json` keeps everything.
 */
export function baselineSummary(baseline: Baseline, file: string): Record<string, unknown> {
  const { config: _config, checks, ...rest } = baseline;
  return {
    ...rest,
    ...(checks
      ? {
          checks: checks.map(({ results, ...run }) => {
            if (!results) return run;
            const { names: _names, failedNames, files, ...counts } = results;
            const failed = shortTestNames(failedNames);
            return {
              ...run,
              results: {
                ...counts,
                files: files.length,
                failedTests: failed.slice(0, MAX_FAILED_NAMES),
                ...(failed.length > MAX_FAILED_NAMES ? { moreFailedTests: failed.length - MAX_FAILED_NAMES } : {}),
              },
            };
          }),
        }
      : {}),
    baselineFile: file,
  };
}

/** A problem with how flagrm was run (missing baseline, stale schema) rather than with the code under check. */
export class UsageError extends Error {}

/** Read `.flagrm/<flag>/baseline.json`, which `flagrm baseline <flag>` writes. */
export function readBaseline(root: string, flag: string): { baseline: Baseline; file: string } {
  const file = baselinePath(root, flag);
  if (!fs.existsSync(file)) {
    throw new UsageError(
      `No baseline for ${flag} at ${file}. Run \`flagrm baseline ${flag}\` before changing the code.`,
    );
  }
  const baseline = JSON.parse(fs.readFileSync(file, "utf8")) as Baseline;
  if (!READABLE_BASELINE_VERSIONS.includes(baseline.schemaVersion)) {
    throw new UsageError(
      `${file} was written by schema version ${baseline.schemaVersion}; this flagrm expects ${JSON_SCHEMA_VERSION}. ` +
        `Re-run \`flagrm baseline ${flag} --force\` on the code as it was before the removal.`,
    );
  }
  return { baseline, file };
}

/**
 * Run one shell command inside a project, streaming its output to `logFile`
 * (no buffer limit, stdout and stderr interleaved as printed). A command that
 * can't start, is killed or outlives the project's `timeout` fails with the
 * reason at the end of the log. A test run also reads the project's
 * `testResults` files written during it.
 */
export async function runCheck(
  ctx: ProjectContext,
  check: CheckRun["check"],
  command: string,
  logFile: string,
): Promise<CheckRun> {
  const started = Date.now();
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, `$ ${command}\n`, "utf8");
  const fd = fs.openSync(logFile, "a");
  let exit: CommandExit;
  try {
    exit = await runCommand(command, ctx.root, fd, ctx.project.timeout);
  } finally {
    fs.closeSync(fd);
  }
  const reason = failureReason(exit, ctx.project.timeout);
  if (reason) fs.appendFileSync(logFile, `\nflagrm: error: ${reason}\n`, "utf8");
  const run: CheckRun = {
    project: ctx.name,
    check,
    command,
    exitCode: exit.status ?? 1,
    durationMs: Date.now() - started,
    log: logFile,
  };
  if (run.exitCode !== 0) {
    const problem = environmentProblem(fs.readFileSync(logFile, "utf8"), ctx.root);
    if (problem) run.failure = { kind: "environment", message: problem };
  }
  const results =
    check === "test" && ctx.project.testResults ? collectTestResults(ctx.project.testResults, started) : undefined;
  if (results) run.results = results;
  return run;
}

interface CommandExit {
  status: number | null;
  signal: NodeJS.Signals | null;
  timedOut?: boolean;
  error?: Error;
}

/**
 * Run `command` in a shell with its output on `fd`. On timeout the whole
 * process tree is killed: on Windows the shell is `cmd.exe`, and killing only
 * it would leave the real command (`dotnet test`, `node`) running.
 */
function runCommand(command: string, cwd: string, fd: number, timeout: number | undefined): Promise<CommandExit> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", fd, fd], windowsHide: true });
    let timedOut = false;
    const timer = timeout
      ? setTimeout(() => {
          timedOut = true;
          killTree(child.pid, () => child.kill("SIGKILL"));
        }, timeout * 1000)
      : undefined;
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: null, signal: null, error });
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, timedOut });
    });
  });
}

function killTree(pid: number | undefined, fallback: () => void): void {
  if (pid !== undefined && process.platform === "win32") {
    const r = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    if (r.status === 0) return;
  }
  fallback();
}

/** Why a command ended without an exit code, or undefined when it exited normally. */
function failureReason(exit: CommandExit, timeout: number | undefined): string | undefined {
  if (exit.timedOut) return `timed out after ${timeout}s (timeout in flagrm.config.yaml)`;
  if (exit.error) return `could not run the command: ${exit.error.message}`;
  if (exit.status === null) return `killed by ${exit.signal ?? "a signal"}`;
  return undefined;
}

/**
 * Why an Angular project's build can't catch template errors, if it can't:
 * `tsc` never reads templates, so a member removed or renamed in a component
 * but still used in its `.html` passes the build. `ngc` and `ng build` check them.
 */
export function templateCheckGap(adapter: Adapter, build: string | undefined): string | undefined {
  if (adapter.id !== "angular" || !build || !/\btsc\b/.test(build)) return undefined;
  if (/\bngc\b|\bng\s+build\b|\bnx\b/.test(build)) return undefined;
  return "`tsc` doesn't type-check Angular templates: add `npx ngc -p <app>/tsconfig.json --noEmit` to `build` so a member removed from a component but still used in its template fails the build";
}

/**
 * Why a .NET build can't feed the dead-code check, if it can't: an incremental
 * `dotnet build` skips compiling up-to-date projects and prints none of their
 * warnings, so a baseline taken on a built tree records no pre-existing unused
 * code and verify reports all of it as new.
 */
export function incrementalBuildGap(adapter: Adapter, build: string | undefined): string | undefined {
  if (adapter.id !== "dotnet" || !build || !/\bdotnet\s+build\b/.test(build)) return undefined;
  if (/--no-incremental\b|[-/]t(arget)?:\s*Rebuild\b/i.test(build)) return undefined;
  return "`dotnet build` without `--no-incremental` skips up-to-date projects and prints none of their warnings, so the dead-code check may report existing unused code as new: add `--no-incremental` to `build`";
}

/**
 * Build then test every project. A project that configures `build` and/or
 * `test` runs exactly those; one that configures neither gets the adapter's
 * defaults (`dotnet build --no-incremental`, `npx ng test`, ...).
 */
export async function runChecks(
  projects: Workspace,
  logDir: string,
  only: ReadonlyArray<CheckRun["check"]> = ["build", "test"],
): Promise<CheckRun[]> {
  const runs: CheckRun[] = [];
  for (const { adapter, ctx } of projects) {
    const commands = projectCommands(adapter, ctx);
    for (const check of only) {
      const command = commands[check];
      if (command) runs.push(await runCheck(ctx, check, command, path.join(logDir, `${ctx.name}.${check}.log`)));
    }
  }
  return runs;
}

/**
 * Write the flag's baseline: the git state and optional check runs. Take
 * `git` before running checks, whose logs land under `.flagrm/` and would
 * otherwise make the tree look dirty.
 */
export function writeBaseline(
  root: string,
  flag: string,
  projects: Workspace,
  git: GitState,
  checks?: CheckRun[],
  names: RecordedName[] = [],
  flow?: Omit<FlagDiscovery, "names">,
): { baseline: Baseline; file: string } {
  const baseline: Baseline = {
    schemaVersion: JSON_SCHEMA_VERSION,
    flag,
    createdAt: new Date().toISOString(),
    projects: projects.map(({ ctx }) => ({ name: ctx.name, adapter: ctx.project.adapter })),
    git,
    names,
    config: configSnapshot(projects),
  };
  if (checks) baseline.checks = checks;
  if (flow?.suggestedNames.length) baseline.suggestedNames = flow.suggestedNames;
  if (flow?.parameterizedTests.length) baseline.parameterizedTests = flow.parameterizedTests;
  return saveBaseline(root, baseline);
}

function saveBaseline(root: string, baseline: Baseline): { baseline: Baseline; file: string } {
  const file = baselinePath(root, baseline.flag);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  return { baseline, file };
}

/** What discovery knows about one flag before its removal. */
export interface FlagDiscovery {
  /** The literal, each definition's qualified name, and the flow names that mention the flag. */
  names: RecordedName[];
  /** Flow names too generic to record (`enabled`, `Plural`): the agent confirms them with `--name`. */
  suggestedNames: FlagFlowName[];
  parameterizedTests: ParameterizedTest[];
}

/**
 * The flag's names from discovery: the literal, then each definition's
 * qualified name, then the names its value travels through that contain one
 * of the flag's words, as wrappers.
 */
export async function discoverFlag(projects: Workspace, flag: string): Promise<FlagDiscovery> {
  const entry = (await buildInventory(projects)).flags.find((f) => f.flag === flag);
  const flow = entry?.flow ?? [];
  const names = mergeNames(
    [{ name: flag, kind: "literal", source: "discovery" }],
    [
      ...(entry?.definitions ?? []).map((d): RecordedName => ({ name: d.name, kind: "alias", source: "discovery" })),
      ...flow.filter((n) => n.record).map((n) => flowName(projects, n)),
    ],
  );
  const key = (n: RecordedName) => `${n.name}\0${n.file ?? ""}`;
  const recorded = new Set(names.map(key));
  const suggestedNames = flow
    .filter((n) => !n.record && !recorded.has(key(flowName(projects, n))))
    .map(({ record: _record, ...name }) => name)
    .filter((n, i, all) => all.findIndex((m) => m.name === n.name && m.file === n.file) === i);
  return { names, suggestedNames, parameterizedTests: entry?.parameterizedTests ?? [] };
}

/** A flow name as a wrapper; a local, parameter or field only in its own file. */
function flowName(projects: Workspace, n: FlagFlowName): RecordedName {
  const name: RecordedName = { name: n.name, kind: "wrapper", source: "discovery" };
  const root = projects[0]?.ctx.config.root;
  if (root && (n.kind === "local" || n.kind === "parameter" || n.kind === "field"))
    name.file = relativePath(root, n.file);
  return name;
}

/** The names {@link discoverFlag} records. */
export async function discoverNames(projects: Workspace, flag: string): Promise<RecordedName[]> {
  return (await discoverFlag(projects, flag)).names;
}

/** `existing` followed by the names in `added` it doesn't already cover. */
export function mergeNames(existing: RecordedName[], added: RecordedName[]): RecordedName[] {
  // A name recorded for every file already covers the same name in one file.
  const key = (n: RecordedName) => `${n.name}\0${n.file ?? ""}`;
  const seen = new Set(existing.map(key));
  const everywhere = new Set(existing.filter((n) => !n.file).map((n) => n.name));
  const merged = [...existing];
  for (const n of added) {
    if (seen.has(key(n)) || everywhere.has(n.name)) continue;
    seen.add(key(n));
    if (!n.file) everywhere.add(n.name);
    merged.push(n);
  }
  return merged;
}

/**
 * Files changed since `sha` that count as edits to the code: everything but
 * `.flagrm/` and the flagrm config, which may change to fix the setup.
 * Undefined when git can't tell (not a repository, or `sha` isn't in it).
 */
export function editsSince(root: string, sha: string): string[] | undefined {
  return changedFilesSince(root, sha)?.filter((rel) => !CONFIG_FILENAMES.includes(rel));
}

/**
 * `baseline --force` starts over only before the removal began: the working
 * tree must still match the baseline commit. Otherwise the new baseline would
 * record half-removed code, and verify would no longer see those edits.
 * Without git there is nothing to compare, so it is allowed.
 */
export function assertNoEditsSinceBaseline(root: string, flag: string): void {
  const sha = readJson<Partial<Baseline>>(baselinePath(root, flag))?.git?.sha;
  if (!sha) return;
  const edits = editsSince(root, sha);
  if (edits === undefined) {
    throw new UsageError(
      `The baseline commit ${sha.slice(0, 7)} of ${flag} is not in this repository, so flagrm can't tell whether the ` +
        `code was edited since. If it wasn't, delete ${relativePath(root, flagDir(root, flag))}/ and take a new baseline.`,
    );
  }
  if (edits.length === 0) return;
  const shown = edits.slice(0, 5).join(", ") + (edits.length > 5 ? `, and ${edits.length - 5} more` : "");
  const uncommitted = new Set(changedFilesSince(root, "HEAD") ?? []);
  const fix = edits.every((rel) => uncommitted.has(rel))
    ? `Set the edits aside with \`git stash -u\`, run \`flagrm baseline ${flag} --force\` again, then \`git stash pop\`.`
    : `Some are committed since the baseline commit ${sha.slice(0, 7)}: check out code without the removal first.`;
  throw new UsageError(
    `The code changed since the baseline of ${flag} (${shown}), so --force would record a half-done removal. ${fix}`,
  );
}

/** Append names to an existing baseline; its git state and checks stay as they are. */
export function addNames(root: string, flag: string, added: RecordedName[]): { baseline: Baseline; file: string } {
  const { baseline } = readBaseline(root, flag);
  return saveBaseline(root, { ...baseline, names: mergeNames(baseline.names, added) });
}

/**
 * Refuse names that would match far more than this flag: a configured flag
 * evaluation method (`isEnabled`) is called for every flag in the project.
 */
export function validateAgentNames(projects: Workspace, names: RecordedName[]): void {
  const methods = new Set(projects.flatMap(({ ctx }) => ctx.project.methods));
  for (const { name } of names) {
    if (methods.has(name)) {
      throw new UsageError(
        `"${name}" is a flag evaluation method (methods in flagrm.config.yaml), so it matches every flag. ` +
          "Record the wrapper or constant specific to this flag instead.",
      );
    }
  }
}

/**
 * Up to `max` distinct lines of a log that look like errors, so the reader sees
 * why a command failed without opening the log. Compiler warnings and summary
 * lines such as `0 Error(s)` are skipped: in a large build they bury the one
 * real error. When no line looks like an error, the last `max` lines instead.
 */
export function errorExcerpt(log: string | undefined, max = 10): string[] {
  if (!log) return [];
  let text: string;
  try {
    text = fs.readFileSync(log, "utf8");
  } catch {
    return [];
  }
  const all = text
    .split(/\r?\n/)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colors (ngc colors even when piped)
    .map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").trim())
    .filter((line) => line && !line.startsWith("$ "));
  const lines = all
    .filter((line) => /\berror\b|\bfailed\b|✗|×/i.test(line))
    .filter((line) => !/:\s*warning\b/i.test(line) && !/^\d+ Error\(s\)$/i.test(line));
  // No line says error (e.g. "A compatible .NET SDK was not found"): the end of the log usually does.
  if (!lines.length) return all.slice(-max);
  return [...new Set(lines)].slice(0, max);
}
