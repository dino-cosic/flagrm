/**
 * Shape checks for the JSON flagrm keeps in `.flagrm/`: `baseline.json`,
 * `verify.json` and `verify/runs.json`. They sit in a working tree an agent
 * edits freely, so a truncated or hand-edited file is realistic; without a
 * check it would surface as a `TypeError` deep inside a verify check. Each
 * guard returns the first problem as `field: what is wrong`, or undefined.
 * Only what flagrm reads is checked, so files from older versions that lack
 * an optional field still pass.
 */

import type { ConfigSnapshot, SavedRuns } from "./types.js";

type Check = (value: unknown, at: string) => string | undefined;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const describe = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "an array" : `a ${typeof v}`);

const typed =
  (type: "string" | "number" | "boolean"): Check =>
  (v, at) =>
    typeof v === type && (type !== "number" || Number.isFinite(v))
      ? undefined
      : `${at} must be a ${type}, not ${describe(v)}`;

const string = typed("string");
const number = typed("number");
const boolean = typed("boolean");

const oneOf =
  (values: readonly string[]): Check =>
  (v, at) =>
    typeof v === "string" && values.includes(v) ? undefined : `${at} must be one of ${values.join(", ")}`;

const nullable =
  (check: Check): Check =>
  (v, at) =>
    v === null ? undefined : check(v, at);

const arrayOf =
  (check: Check): Check =>
  (v, at) => {
    if (!Array.isArray(v)) return `${at} must be an array, not ${describe(v)}`;
    for (const [i, item] of v.entries()) {
      const problem = check(item, `${at}[${i}]`);
      if (problem) return problem;
    }
    return undefined;
  };

const recordOf =
  (check: Check): Check =>
  (v, at) => {
    if (!isObject(v)) return `${at} must be an object, not ${describe(v)}`;
    for (const [key, item] of Object.entries(v)) {
      const problem = check(item, `${at}.${key}`);
      if (problem) return problem;
    }
    return undefined;
  };

/** An object with `required` fields and, when present, `optional` ones. */
const object =
  (required: Record<string, Check>, optional: Record<string, Check> = {}): Check =>
  (v, at) => {
    if (!isObject(v)) return `${at || "the file"} must be an object, not ${describe(v)}`;
    const field = (key: string) => (at ? `${at}.${key}` : key);
    for (const [key, check] of Object.entries(required)) {
      if (!(key in v)) return `${field(key)} is missing`;
      const problem = check(v[key], field(key));
      if (problem) return problem;
    }
    for (const [key, check] of Object.entries(optional)) {
      if (v[key] === undefined) continue;
      const problem = check(v[key], field(key));
      if (problem) return problem;
    }
    return undefined;
  };

const gitState = object(
  { sha: nullable(string), dirty: boolean },
  { dirtyFiles: arrayOf(string), dirtyHashes: recordOf(nullable(string)) },
);

const checkRun = object(
  { project: string, check: oneOf(["build", "test", "lint"]), command: string, exitCode: number, durationMs: number },
  {
    log: string,
    results: object(
      {
        total: number,
        passed: number,
        failed: number,
        skipped: number,
        names: arrayOf(string),
        failedNames: arrayOf(string),
        files: arrayOf(string),
      },
      { source: oneOf(["files", "log"]) },
    ),
    failure: object({ kind: oneOf(["environment"]), message: string }),
    interrupted: string,
    reused: object({ flag: string, createdAt: string }),
  },
);

const commandSnapshot = object({ command: string, files: arrayOf(object({ path: string, sha256: string })) });

const projectCommands = object(
  { name: string },
  { build: commandSnapshot, test: commandSnapshot, lint: commandSnapshot, testResults: string },
);

const configSnapshot = object({ projects: arrayOf(projectCommands) }, { file: object({ path: string, text: string }) });

const located = { project: string, file: string, line: number, flag: string };

const baseline = object(
  {
    schemaVersion: number,
    flag: string,
    createdAt: string,
    projects: arrayOf(object({ name: string, adapter: string })),
    git: gitState,
    names: arrayOf(
      object(
        { name: string, kind: oneOf(["literal", "alias", "wrapper"]), source: oneOf(["discovery", "agent"]) },
        { file: string },
      ),
    ),
  },
  {
    checks: arrayOf(checkRun),
    config: configSnapshot,
    acceptedConfig: configSnapshot,
    acceptedFailures: boolean,
    suggestedNames: arrayOf(object({ ...located, name: string, kind: string })),
    parameterizedTests: arrayOf(object({ ...located, method: string, parameter: string, value: boolean })),
  },
);

const savedRuns = object({
  schemaVersion: number,
  flagrmVersion: string,
  flag: string,
  createdAt: string,
  key: string,
  commands: arrayOf(projectCommands),
  runs: arrayOf(checkRun),
});

/** What is wrong with a parsed `baseline.json`, or undefined when it has the shape of a `Baseline`. */
export function baselineProblem(value: unknown): string | undefined {
  return baseline(value, "");
}

/** Whether a parsed `config` or `acceptedConfig` of a baseline has the shape of a {@link ConfigSnapshot}. */
export function isConfigSnapshot(value: unknown): value is ConfigSnapshot {
  return configSnapshot(value, "") === undefined;
}

/** A full SHA-1 or SHA-256 commit id, as `git rev-parse HEAD` prints it. */
export const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Whether a parsed `verify/runs.json` has the shape of {@link SavedRuns}. */
export function isSavedRuns(value: unknown): value is SavedRuns {
  return savedRuns(value, "") === undefined;
}
