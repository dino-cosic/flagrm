import type { AdapterId, ProjectConfig, ToolConfig } from "./config.js";
import type { FlagCandidate, FlagFlowName, ParameterizedTest } from "./types.js";

/** Everything an adapter needs to work on one configured project. */
export interface ProjectContext {
  /** The project's configured name. */
  name: string;
  /** Absolute project root. */
  root: string;
  project: ProjectConfig;
  config: ToolConfig;
  /** Files in scope: the project's globs (or the adapter's defaults), minus ignored and excluded paths. */
  files: string[];
}

/**
 * A language/framework adapter: how to discover a stack's flags, which
 * build/test commands to run, and how to read its compiler's "unused"
 * diagnostics. The registry maps a project's `adapter:` id to an implementation.
 */
export interface Adapter {
  id: AdapterId;
  /** Globs (relative to the project root) used when the project doesn't set `globs`. */
  defaultGlobs: string[];
  /** Candidate flag names for `flagrm list`. */
  discover(ctx: ProjectContext): Promise<FlagCandidate[]>;
  /**
   * Where each flag's value goes: the locals, fields, properties, methods and
   * parameters that hold or pass it, and tests that call such a parameter
   * with a `true`/`false` literal.
   */
  flow?(ctx: ProjectContext, flags: FlagRef[]): FlagFlow;
  /**
   * Other files that share `file`'s scope (absolute paths): an Angular
   * component's template, where a field of its class is used too.
   */
  scopeFiles?(ctx: ProjectContext, file: string): string[];
  /** Build/test commands (and where the default test writes results) for keys the project doesn't configure. */
  defaultCommands?(ctx: ProjectContext): { build?: string; test?: string; testResults?: string };
  /**
   * Compiler "unused" diagnostics (unused locals, imports, private members)
   * in the changed files that the baseline did not already have. Undefined
   * when the adapter has nothing to go on (e.g. no build log).
   */
  unusedDiagnostics?(ctx: ProjectContext, input: UnusedDiagnosticsInput): UnusedDiagnosticsResult | undefined;
}

/** A flag and the qualified names code reads it by (`FeatureFlags.NewCheckout`). */
export interface FlagRef {
  flag: string;
  aliases: string[];
}

export interface FlagFlow {
  names: FlagFlowName[];
  tests: ParameterizedTest[];
}

export interface UnusedDiagnosticsInput {
  /** Absolute paths of the project's files changed since the baseline that still exist. */
  changedFiles: string[];
  /** A file's content at the baseline commit, or undefined when it did not exist. */
  baselineText(file: string): string | undefined;
  /** Output of this verify's build command for the project. */
  buildLog?: string;
  /** Output of the baseline's build (`flagrm baseline`). */
  baselineBuildLog?: string;
}

export interface UnusedDiagnostic {
  /** Absolute file path. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** Compiler code, e.g. `TS6133`, `CS0169`, `IDE0051`. */
  code: string;
  message: string;
}

export interface UnusedDiagnosticsResult {
  /** Diagnostics not present at the baseline (all diagnostics when `compared` is false). */
  diagnostics: UnusedDiagnostic[];
  /** Whether baseline diagnostics were available to subtract. */
  compared: boolean;
}

/**
 * The diagnostics in `current` that `before` did not have. Line numbers move
 * with the edits, so a diagnostic is matched by file, code and message (which
 * names the member), counting repeats: a second identical message in a file
 * (another unused `ex`) is new, not the baseline's.
 */
export function newDiagnostics(current: UnusedDiagnostic[], before: UnusedDiagnostic[]): UnusedDiagnostic[] {
  const key = (d: UnusedDiagnostic) => `${d.file}\0${d.code}\0${d.message}`;
  const remaining = new Map<string, number>();
  for (const d of before) remaining.set(key(d), (remaining.get(key(d)) ?? 0) + 1);
  return current.filter((d) => {
    const n = remaining.get(key(d)) ?? 0;
    if (n > 0) remaining.set(key(d), n - 1);
    return n === 0;
  });
}

/** Every configured project paired with its adapter, in config order. */
export type Workspace = Array<{ adapter: Adapter; ctx: ProjectContext }>;
