/**
 * A flag's baseline: what `flagrm baseline <flag>` records before the removal
 * starts (git state, check runs, the flag's names) and the ways it may change
 * later (`--name`, `--accept`, `--force`).
 */

import fs from "node:fs";
import path from "node:path";
import type { Workspace } from "./adapter.js";
import { type ChangeFilter, changeFilter } from "./change-filter.js";
import { configSnapshot, projectCommands } from "./config-snapshot.js";
import { UsageError } from "./errors.js";
import { blobIds, changedFilesSince, gitState } from "./git.js";
import { buildInventory } from "./inventory.js";
import { assertOwnNames } from "./name-owner.js";
import { baselinePath, flagDir } from "./paths.js";
import { baselineRuns } from "./run-cache.js";
import { matchingFiles } from "./scan.js";
import { withScopeFiles } from "./scope-files.js";
import { baselineProblem, COMMIT_ID } from "./state-files.js";
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
import { shortTestNames } from "./verify/test-results.js";

/** The `flagrm baseline` options, as parsed from the command line. */
export interface BaselineOptions {
  /** Run build, test and lint (default true; `--no-checks`). */
  checks?: boolean;
  /** Reuse the runs a passing verify saved (default true; `--no-reuse`). */
  reuse?: boolean;
  /** `--name`: names the flag is read through, added for the leftovers check. */
  names?: string[];
  /** `--kind`: alias or wrapper; default alias, wrapper with `files`. */
  kind?: string;
  /** `--file`: scope `names` to these files (resolved against `cwd`) and the files sharing their scope. */
  files?: string[];
  /** `--force`: replace an existing baseline, only while the code is unedited since it. */
  force?: boolean;
  /** `--accept`: the raw comma-separated value. */
  accept?: string;
  /** What relative `files` resolve against; default the process's working directory. */
  cwd?: string;
}

/**
 * `flagrm baseline <flag>`: validate the options, then record an
 * acknowledgement (`accept`), add names to an existing baseline (`names`
 * without `force`), or write a new one. Throws a `UsageError` for options
 * that don't fit together or a baseline that can't be changed that way.
 */
export async function takeBaseline(
  root: string,
  projects: Workspace,
  flag: string,
  opts: BaselineOptions = {},
): Promise<{ baseline: Baseline; file: string }> {
  const checks = opts.checks ?? true;
  const reuse = opts.reuse ?? true;
  const nameArgs = opts.names ?? [];
  const fileArgs = opts.files ?? [];
  if (opts.accept !== undefined) {
    if (opts.force || nameArgs.length || fileArgs.length || opts.kind || !checks || !reuse) {
      throw new UsageError(
        "--accept only records an acknowledgement; run it without --force, --name, --file, --kind, --no-checks and --no-reuse.",
      );
    }
    return acceptBaseline(root, flag, projects, parseAccept(opts.accept));
  }
  // Only wrappers are matched per file: a name scoped with --file is a local, parameter or field.
  const kind = opts.kind ?? (fileArgs.length ? "wrapper" : "alias");
  if (kind !== "alias" && kind !== "wrapper") throw new UsageError(`--kind must be alias or wrapper, not "${kind}".`);
  if (!checks && !reuse) throw new UsageError("--no-reuse has nothing to reuse with --no-checks.");
  if (fileArgs.length && nameArgs.length === 0) throw new UsageError("--file scopes --name entries; pass --name too.");
  if (fileArgs.length && kind !== "wrapper") throw new UsageError("--file scopes wrapper names; drop --kind alias.");
  const cwd = opts.cwd ?? process.cwd();
  const scopes = [
    ...new Set(
      fileArgs.flatMap((file) => {
        const rel = relativePath(root, path.resolve(cwd, file));
        if (rel.startsWith("..")) throw new UsageError(`--file ${file} is outside ${root}.`);
        return withScopeFiles(projects, root, rel);
      }),
    ),
  ];
  const added: RecordedName[] = nameArgs.flatMap((name) =>
    (scopes.length ? scopes : [undefined]).map(
      (file): RecordedName => ({ name, kind, source: "agent", ...(file ? { file } : {}) }),
    ),
  );
  validateAgentNames(projects, added);
  await assertOwnNames(root, projects, flag, added);
  const exists = fs.existsSync(baselinePath(root, flag));
  if (exists && opts.force) {
    const testResults = projects.flatMap(({ adapter, ctx }) => projectCommands(adapter, ctx).testResults ?? []);
    assertNoEditsSinceBaseline(root, flag, testResults, changeFilter(projects[0]?.ctx.config));
  }
  if (exists && !opts.force) {
    if (added.length === 0) {
      throw new UsageError(`Baseline for ${flag} already exists; pass --name to add names, or --force to start over.`);
    }
    return addNames(root, flag, added);
  }
  const git = gitState(root);
  if (git.dirtyFiles?.length) git.dirtyHashes = blobIds(root, git.dirtyFiles);
  const runs = checks ? await baselineRuns(root, flag, projects, reuse) : undefined;
  const { names, ...flow } = await discoverFlag(projects, flag);
  return writeBaseline(root, flag, projects, git, runs, mergeNames(names, added), flow);
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
  const { config: _config, acceptedConfig: _accepted, checks, ...rest } = baseline;
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

/** Read `.flagrm/<flag>/baseline.json`, which `flagrm baseline <flag>` writes. */
export function readBaseline(root: string, flag: string): { baseline: Baseline; file: string } {
  const file = baselinePath(root, flag);
  if (!fs.existsSync(file)) {
    throw new UsageError(
      `No baseline for ${flag} at ${file}. Run \`flagrm baseline ${flag}\` before changing the code.`,
    );
  }
  const redo = `Re-run \`flagrm baseline ${flag} --force\` on the code as it was before the removal.`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new UsageError(`${file} is not valid JSON (${(err as Error).message}). ${redo}`);
  }
  const version = (parsed as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (typeof version === "number" && !READABLE_BASELINE_VERSIONS.includes(version)) {
    throw new UsageError(
      `${file} was written by schema version ${version}; this flagrm expects ${JSON_SCHEMA_VERSION}. ${redo}`,
    );
  }
  const problem = baselineProblem(parsed);
  if (problem) throw new UsageError(`${file} is not a valid baseline: ${problem}. ${redo}`);
  const baseline = parsed as Baseline;
  const sha = baseline.git.sha;
  if (sha != null && !COMMIT_ID.test(sha)) {
    throw new UsageError(`${file} has git.sha "${sha}", which is not a git commit id. ${redo}`);
  }
  return { baseline, file };
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
      ...flow.filter((n) => n.record).flatMap((n) => flowNames(projects, n)),
    ],
  );
  const key = (n: RecordedName) => `${n.name}\0${n.file ?? ""}`;
  const recorded = new Set(names.map(key));
  const suggestedNames = flow
    .filter((n) => !n.record && !recorded.has(key(flowNames(projects, n)[0])))
    .map(({ record: _record, ...name }) => name)
    .filter((n, i, all) => all.findIndex((m) => m.name === n.name && m.file === n.file) === i);
  return { names, suggestedNames, parameterizedTests: entry?.parameterizedTests ?? [] };
}

/** A flow name as recorded: an alias everywhere; a wrapper, a local, parameter or field only in its own file. */
function flowNames(projects: Workspace, n: FlagFlowName): RecordedName[] {
  if (n.kind === "alias") return [{ name: n.name, kind: "alias", source: "discovery" }];
  const name: RecordedName = { name: n.name, kind: "wrapper", source: "discovery" };
  const root = projects[0]?.ctx.config.root;
  if (root && (n.kind === "local" || n.kind === "parameter" || n.kind === "field")) {
    return withScopeFiles(projects, root, relativePath(root, n.file)).map((file) => ({ ...name, file }));
  }
  return [name];
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
 * `.flagrm/`, what `ignore` names (flagrm's setup files, which may change to
 * fix the setup, and `exclude`d paths), and the files matching `testResults`
 * patterns (absolute), which the baseline's own test run writes. Undefined
 * when git can't tell (not a repository, or `sha` isn't in it).
 */
export function editsSince(
  root: string,
  sha: string,
  testResults: readonly string[] = [],
  ignore: ChangeFilter = changeFilter(),
): string[] | undefined {
  const results = matchingFiles(root, testResults);
  return changedFilesSince(root, sha, ignore)?.filter((rel) => !results.has(rel));
}
/**
 * `baseline --force` starts over only before the removal began: the working
 * tree must still match the baseline commit. Otherwise the new baseline would
 * record half-removed code, and verify would no longer see those edits.
 * Without git there is nothing to compare, so it is allowed. Files matching
 * `testResults` (absolute patterns) and the ones `ignore` names are not edits.
 */
export function assertNoEditsSinceBaseline(
  root: string,
  flag: string,
  testResults: readonly string[] = [],
  ignore: ChangeFilter = changeFilter(),
): void {
  const sha = readJson<Partial<Baseline>>(baselinePath(root, flag))?.git?.sha;
  // Unreadable or without a commit: nothing to compare, and \`--force\` is how a broken baseline is replaced.
  if (typeof sha !== "string" || !COMMIT_ID.test(sha)) return;
  const edits = editsSince(root, sha, testResults, ignore);
  if (edits === undefined) {
    throw new UsageError(
      `The baseline commit ${sha.slice(0, 7)} of ${flag} is not in this repository, so flagrm can't tell whether the ` +
        `code was edited since. If it wasn't, delete ${relativePath(root, flagDir(root, flag))}/ and take a new baseline.`,
    );
  }
  if (edits.length === 0) return;
  const shown = edits.slice(0, 5).join(", ") + (edits.length > 5 ? `, and ${edits.length - 5} more` : "");
  const uncommitted = new Set(changedFilesSince(root, "HEAD", ignore) ?? []);
  const fix = edits.every((rel) => uncommitted.has(rel))
    ? `Set the edits aside with \`git stash -u\`, run \`flagrm baseline ${flag} --force\` again, then \`git stash pop\`.`
    : `Some are committed since the baseline commit ${sha.slice(0, 7)}: check out code without the removal first.`;
  throw new UsageError(
    `The code changed since the baseline of ${flag} (${shown}), so --force would record a half-done removal. ${fix}`,
  );
}

export type Acceptance = "config" | "failures";

/** Parse `--accept config,failures`; throws on anything else, or nothing. */
export function parseAccept(value: string): Acceptance[] {
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length === 0) throw new UsageError("--accept takes config, failures; got nothing.");
  for (const item of items) {
    if (item !== "config" && item !== "failures") {
      throw new UsageError(`--accept takes config, failures; not "${item}".`);
    }
  }
  return [...new Set(items)] as Acceptance[];
}

/**
 * Record the user's acknowledgement: the current configuration (verify then
 * warns only about later changes) and/or the baseline's failing tests (listed
 * as info). The git state, checks and names stay as they are, so this is
 * safe mid-removal, unlike `--force`.
 */
export function acceptBaseline(
  root: string,
  flag: string,
  projects: Workspace,
  what: Acceptance[],
): { baseline: Baseline; file: string } {
  const { baseline } = readBaseline(root, flag);
  const next: Baseline = { ...baseline };
  if (what.includes("config")) next.acceptedConfig = configSnapshot(projects);
  if (what.includes("failures")) next.acceptedFailures = true;
  return saveBaseline(root, next);
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
