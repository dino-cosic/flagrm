import type { AdapterId } from "./config.js";

/**
 * Bumped whenever a `--json` payload shape changes in a way that could break
 * a consumer (field renamed/removed, meaning of an existing field changed).
 * Purely additive fields don't require a bump.
 *
 * - 2: `project` on every candidate and result is the configured project name.
 * - 3: agent-first release. `inspect`, `scan`, `fold` and `report` are gone;
 *   the baseline is written by `flagrm baseline` and holds only the git state and
 *   build/test runs; `verify` runs the `dead-code`, `build` and `tests` checks,
 *   and tests that no longer run are listed as `removed`.
 * - 4: the baseline records the flag's `names`; `verify` adds the `leftovers`
 *   check and reports `fingerprint` and `changedFiles`.
 * - 5: `verify` reports `runs[].results` as counts only (no `names` or
 *   `failedNames`: the comparison is in `tests`, failed tests in the findings),
 *   and one `tests` warning for all tests that no longer run.
 * - 6: `verify` reports `skipped`, the checks `--skip` left out.
 */
export const JSON_SCHEMA_VERSION = 6;

/** Where a candidate flag name was discovered by `flagrm list`. */
export type FlagCandidateSource =
  | "config" // appsettings*.json "FeatureManagement" key, or a flag in an Angular environment*.ts `features` object
  | "attribute" // [FeatureGate("Flag")]-style attribute argument
  | "eval" // first argument to a configured eval method call
  | "constant" // member of a class/struct/enum named like *Flag(s)*/*Feature(s)* (C# const or enum, TS enum)
  | "object-key"; // key of a flags object (`export const FLAGS = { newCheckout: 'NewCheckout' }`)

/** A flag's value in one configuration file. */
export type ConfigState = "on" | "off" | "conditional" | "unknown";

export interface FlagCandidate {
  flag: string;
  /** Name of the configured project. */
  project: string;
  source: FlagCandidateSource;
  /** Absolute file path. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** For `constant`/`object-key`: the qualified name code uses, e.g. `FeatureFlags.NewCheckout`, `FLAGS.newCheckout`. */
  symbol?: string;
  /** For `constant`/`object-key`: what declares {@link symbol}. */
  symbolKind?: FlagDefinition["kind"];
  /** For `config`: the environment the file configures (`default`, `Development`, `prod`, ...). */
  environment?: string;
  /** For `config`: the configured value. */
  state?: ConfigState;
  /** For a `conditional` config value: the feature filter names (`Percentage`, `Targeting`, ...). */
  filters?: string[];
}

/** Where a flag name is declared in code. */
export interface FlagDefinition {
  kind: "const" | "enum-member" | "object-key";
  /** Qualified name, e.g. `FeatureFlags.NewCheckout`. */
  name: string;
  project: string;
  /** Absolute file path. */
  file: string;
  /** 1-based line number. */
  line: number;
}

/** A flag's entry in one configuration file. */
export interface FlagConfigEntry {
  project: string;
  /** Absolute file path. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** `default` for the base file (`appsettings.json`, `environment.ts`), otherwise the file's suffix. */
  environment: string;
  state: ConfigState;
  filters?: string[];
}

/**
 * - `boolean`: every configuration entry is plain on/off.
 * - `conditional`: at least one entry uses feature filters (percentage, targeting, time window, ...).
 * - `unknown`: the flag has no configuration entries.
 */
export type FlagType = "boolean" | "conditional" | "unknown";

/** Overall configured state: the same everywhere (`on`/`off`), different per environment (`mixed`), or none. */
export type FlagState = "on" | "off" | "mixed" | "conditional" | "unconfigured";

/** One flag in the `flagrm list` inventory. */
export interface FlagInventoryEntry {
  flag: string;
  type: FlagType;
  state: FlagState;
  /** Projects that define, configure or reference the flag, in config order. */
  projects: string[];
  definitions: FlagDefinition[];
  config: FlagConfigEntry[];
  /**
   * Direct code references: the flag name as a string literal, or a
   * definition's qualified name (`FLAGS.newCheckout`, `nameof(Feature.NewCheckout)`).
   * Comments, definitions and config entries are not counted, and neither
   * are reads through wrappers.
   */
  /**
   * Names the flag's value travels through. `record` names contain one of the
   * flag's words, so `baseline` records them as wrappers; the others are only
   * suggested (`enabled`, `Plural` would match unrelated code).
   */
  flow: Array<FlagFlowName & { record: boolean }>;
  /** Tests that pass a `true`/`false` literal for one of the `parameter` names in `flow`. */
  parameterizedTests: ParameterizedTest[];
  references: {
    total: number;
    /** Distinct files with at least one reference. */
    files: number;
    /** References inside test files. */
    tests: number;
    byProject: Record<string, number>;
  };
}

/** A name the flag's value travels through, found by following it from the flag's evaluations. */
export interface FlagFlowName {
  flag: string;
  /** As code refers to it; a static method qualified by its class (`CollectionTerminology.Plural`). */
  name: string;
  kind: "local" | "field" | "property" | "method" | "parameter";
  /**
   * A parameter of one of several same-named methods the call could reach, or
   * an instance method whose name another method shares; never recorded automatically.
   */
  ambiguous?: boolean;
  project: string;
  /** Absolute file path of the declaration or assignment. */
  file: string;
  /** 1-based line number. */
  line: number;
}

/** A test call passing a `true`/`false` literal for a parameter the flag's value is passed as. */
export interface ParameterizedTest {
  flag: string;
  project: string;
  /** Absolute file path. */
  file: string;
  /** 1-based line number. */
  line: number;
  method: string;
  parameter: string;
  value: boolean;
}

export interface ListReport {
  schemaVersion: number;
  projects: Array<{ name: string; adapter: AdapterId }>;
  /** The flag inventory, sorted by flag name. */
  flags: FlagInventoryEntry[];
  /** Raw discovery evidence the inventory was built from. */
  candidates: FlagCandidate[];
}

/** Tests counted from the JUnit/TRX files a test command wrote. */
export interface TestRunResults {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  /** Fully qualified test names (TRX `testName`, JUnit `classname › name`), including data-row arguments. */
  names: string[];
  /** Names of the failed tests. */
  failedNames: string[];
  /** Result files the counts were read from. */
  files: string[];
}

/** One build or test command run for the baseline (or by `verify`). */
export interface CheckRun {
  project: string;
  check: "build" | "test";
  command: string;
  exitCode: number;
  durationMs: number;
  /** Combined stdout/stderr of the run. */
  log?: string;
  /** For a test run in a project with `testResults`: what the result files report. */
  results?: TestRunResults;
  /** Why a failed run failed, when the log shows a machine setup problem rather than broken code. */
  failure?: CheckFailure;
}

/** `environment`: the machine isn't set up to run the command (missing SDK or tool, Docker not running). */
export interface CheckFailure {
  kind: "environment";
  /** One line: what is missing and how to fix it. */
  message: string;
}

export interface GitState {
  sha: string | null;
  dirty: boolean;
  /** Files (relative to the config root) with uncommitted changes when the state was taken. */
  dirtyFiles?: string[];
}

/**
 * How a recorded name is matched by the `leftovers` check:
 * - `literal`: the flag name as a string literal (`"NewCheckout"`), and as a word in comments.
 * - `alias`: a qualified constant (`FeatureFlags.NewCheckout`, `FLAGS.newCheckout`).
 * - `wrapper`: an identifier the flag is read through, calls included (`IsNewCheckoutEnabledAsync()`).
 */
export type RecordedNameKind = "literal" | "alias" | "wrapper";

/** A name `verify` checks for: found by discovery at baseline, or added by the agent with `--name`. */
export interface RecordedName {
  name: string;
  kind: RecordedNameKind;
  source: "discovery" | "agent";
  /**
   * Only this file (relative to the config root) is checked for the name: a
   * local, parameter or field exists only there, and the same name elsewhere
   * is another variable.
   */
  file?: string;
}

/** `.flagrm/<flag>/baseline.json`: the state of the code before the removal. */
export interface Baseline {
  schemaVersion: number;
  flag: string;
  createdAt: string;
  projects: Array<{ name: string; adapter: AdapterId }>;
  git: GitState;
  /** Build/test runs, unless the baseline was taken with `--no-checks`. */
  checks?: CheckRun[];
  /** Names the `leftovers` check looks for. */
  names: RecordedName[];
  /** The configuration the baseline was taken with; `verify` warns about changes to it. */
  config?: ConfigSnapshot;
  /** Names the flag's value travels through that are too generic to record; confirm them with `--name`. */
  suggestedNames?: FlagFlowName[];
  /** Tests that pass a `true`/`false` literal for a parameter the flag's value is passed as. */
  parameterizedTests?: ParameterizedTest[];
}

/** A resolved build or test command and the files it names (a solution filter, run settings), hashed. */
export interface CommandSnapshot {
  command: string;
  /** Paths relative to the config root. */
  files: Array<{ path: string; sha256: string }>;
}

export interface ConfigSnapshot {
  /** The config file (relative to the config root) and its text; absent without one. */
  file?: { path: string; text: string };
  projects: Array<{ name: string; build?: CommandSnapshot; test?: CommandSnapshot; testResults?: string }>;
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

export const CHECK_IDS = ["leftovers", "dead-code", "build", "tests"] as const;

export type CheckId = (typeof CHECK_IDS)[number];

export type CheckStatus = "pass" | "fail" | "warn" | "skipped";

/** One thing a check found. `severity` is what the finding contributes to the check's status. */
export interface CheckFinding {
  severity: "fail" | "warn" | "info";
  message: string;
  project?: string;
  /** Absolute file path. */
  file?: string;
  /** 1-based line number. */
  line?: number;
}

export interface CheckResult {
  id: CheckId;
  status: CheckStatus;
  /** One-line outcome, e.g. `backend built successfully`. */
  summary: string;
  findings: CheckFinding[];
}

/** Test counts per project, baseline vs now. */
export interface TestComparison {
  project: string;
  before?: number;
  after?: number;
  /** Baseline tests that no longer run, sorted into the four lists below. */
  removed: string[];
  /** Tests that did not run at the baseline. */
  added: string[];
  /** Removed in the diff: gone from a changed test file, or a data row dropped from one. */
  deleted: string[];
  /** Renamed without the flag's words (`Save_Vfo1Enabled_Works` → `Save_Works`); `to` is in `added`. */
  renamed: Array<{ from: string; to: string }>;
  /** Not deleted, but the project's test command, its named files or `testResults` changed since the baseline. */
  excludedByConfig: string[];
  /** None of the above: the only ones `verify` warns about. */
  unexplained: string[];
}

/** A build/test run in a verify report: test counts without the per-test name lists. */
export type VerifyRun = Omit<CheckRun, "results"> & { results?: Omit<TestRunResults, "names" | "failedNames"> };

/** `.flagrm/<flag>/verify.json`, and `flagrm verify <flag> --json`. */
export interface VerifyReport {
  schemaVersion: number;
  flag: string;
  /** `fail` when any check fails (or, with `strict`, warns). */
  status: "pass" | "fail";
  strict: boolean;
  createdAt: string;
  baseline: { file: string; createdAt: string; git: GitState };
  git: GitState;
  /** Tree id of the verified working tree (see `treeFingerprint`); undefined without git. */
  fingerprint?: string;
  /** Files (relative to the config root) changed since the baseline commit; undefined without git. */
  changedFiles?: string[];
  checks: CheckResult[];
  /** Checks left out with `--skip`. The Stop hook only accepts a pass with none. */
  skipped: CheckId[];
  /** Build/test commands this verify ran. */
  runs: VerifyRun[];
  tests: TestComparison[];
}
