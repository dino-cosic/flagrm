/**
 * `flagrm hook stop`: the Claude Code Stop hook. It blocks the agent from
 * finishing while a flag removal is underway and not verified. It never runs
 * builds or tests, and anything unexpected allows the stop: a broken hook
 * must never trap the user.
 */

import fs from "node:fs";
import path from "node:path";
import { type ChangeFilter, changeFilterAt } from "./change-filter.js";
import { findConfigRoot } from "./config.js";
import { scanConfigChanged } from "./config-snapshot.js";
import { headSha, isAncestor, trackedChangesSince, treeFingerprint } from "./git.js";
import { COMMIT_ID, isConfigSnapshot } from "./state-files.js";
import type { ConfigSnapshot, VerifyReport } from "./types.js";
import { readJson } from "./util.js";

/** The fields flagrm reads from the hook's stdin JSON. */
export interface StopHookInput {
  stop_hook_active?: boolean;
  cwd?: string;
}

/** The hook's stdin: only a JSON object counts, and only fields of the expected type are kept. */
export function parseHookInput(text: string): StopHookInput {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const { stop_hook_active, cwd } = raw as Record<string, unknown>;
  const input: StopHookInput = {};
  if (typeof stop_hook_active === "boolean") input.stop_hook_active = stop_hook_active;
  if (typeof cwd === "string") input.cwd = cwd;
  return input;
}

/** The config root for a hook run in `cwd`: Claude Code may run it from a subdirectory of the repository. */
export function hookRoot(cwd: string): string {
  return findConfigRoot(cwd) ?? cwd;
}

export interface StopDecision {
  block: boolean;
  /** One line per unverified flag, shown to the agent. */
  reason?: string;
}

/**
 * Whether to block the stop: a removal is in progress and no passing verify
 * matches the current tree. A removal is tracked while HEAD is its baseline
 * commit, or a later commit on top of it as long as no verify of that flag
 * ever passed: an agent that commits before verifying is still checked, and
 * one that verified and then committed is released. A baseline commit no
 * longer in HEAD's history (a branch switch, a rebase) isn't tracked.
 * In progress means a file git tracks changed since the baseline commit,
 * other than flagrm's setup files and paths matching `exclude` (a removal
 * paused on a question to the user, or a stray test result file, doesn't
 * count), the config changed in what it scans or ignores, or the last verify
 * skipped checks. The fingerprint leaves out the same paths, as verify's does.
 */
export function stopDecision(root: string, input: StopHookInput): StopDecision {
  if (input.stop_hook_active) return { block: false };
  try {
    if (!fs.existsSync(path.join(root, ".flagrm"))) return { block: false };
    const ignore = changeFilterAt(root);
    const started = startedRemovals(root, ignore);
    if (started.length === 0) return { block: false };
    const current = treeFingerprint(root, ignore);
    if (!current) return { block: false };
    const reasons = started.map((r) => unverified(r, current)).filter((r): r is string => r !== undefined);
    return reasons.length ? { block: true, reason: reasons.join("\n") } : { block: false };
  } catch {
    return { block: false };
  }
}

/**
 * The removals `doctor` warns about: committed on this branch, never
 * verified, and in progress, so the Stop hook blocks on each of them.
 * `dir` is the `.flagrm/` directory name, `flag` the flag's name.
 */
export function committedUnverified(root: string): { dir: string; flag: string }[] {
  return startedRemovals(root, changeFilterAt(root))
    .filter((r) => r.committed)
    .map((r) => ({ dir: path.basename(r.flagDir), flag: r.baseline.flag }));
}

/** The removals the hook guards and that are in progress: see {@link stopDecision}. */
function startedRemovals(root: string, ignore: ChangeFilter): Tracked[] {
  const dir = path.join(root, ".flagrm");
  if (!fs.existsSync(dir)) return [];
  const head = headSha(root);
  if (!head) return [];
  const active = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => tracked(path.join(dir, e.name), root, head))
    .filter((r): r is Tracked => r !== undefined);
  const editedSince = new Map<string, boolean>();
  const edited = (sha: string) => {
    if (!editedSince.has(sha)) editedSince.set(sha, (trackedChangesSince(root, sha, ignore) ?? []).length > 0);
    return editedSince.get(sha) === true;
  };
  return active.filter(
    (r) => edited(r.baseline.sha) || lastVerifySkipped(r.flagDir) || scanConfigChanged(r.baseline.config, root),
  );
}

interface Tracked {
  flagDir: string;
  baseline: HookBaseline;
  /** HEAD moved past the baseline commit. */
  committed: boolean;
}

/** The removal in `flagDir` if the hook guards it at `head`: see {@link stopDecision}. */
function tracked(flagDir: string, root: string, head: string): Tracked | undefined {
  const baseline = readBaseline(flagDir);
  if (!baseline) return undefined;
  if (baseline.sha === head) return { flagDir, baseline, committed: false };
  if (everPassed(flagDir) || !isAncestor(root, baseline.sha)) return undefined;
  return { flagDir, baseline, committed: true };
}

function everPassed(flagDir: string): boolean {
  return readJson<Partial<VerifyReport>>(path.join(flagDir, "verify.json"))?.status === "pass";
}

function lastVerifySkipped(flagDir: string): boolean {
  const skipped = readJson<Partial<VerifyReport>>(path.join(flagDir, "verify.json"))?.skipped;
  return Array.isArray(skipped) && skipped.length > 0;
}

/** What the hook reads of a baseline. */
interface HookBaseline {
  flag: string;
  sha: string;
  /**
   * `acceptedConfig`, else `config`: whether it changed in what is scanned or
   * ignored counts as in progress, since widening `exclude` would otherwise
   * hide the removal's edits from the hook. A verify passing on this tree allows.
   */
  config?: ConfigSnapshot;
}

/**
 * The fields of `flagDir`'s baseline the hook reads, or undefined without a
 * commit id. Only those are checked, so a baseline broken elsewhere (which
 * verify reports) stays guarded; a flag name that isn't a string falls back
 * to the directory name, and a malformed config snapshot counts as none.
 */
function readBaseline(flagDir: string): HookBaseline | undefined {
  const raw = readJson<{ flag?: unknown; git?: { sha?: unknown }; config?: unknown; acceptedConfig?: unknown }>(
    path.join(flagDir, "baseline.json"),
  );
  const sha = raw?.git?.sha;
  if (typeof sha !== "string" || !COMMIT_ID.test(sha)) return undefined;
  const flag = typeof raw?.flag === "string" ? raw.flag : path.basename(flagDir);
  const config = raw?.acceptedConfig ?? raw?.config;
  return { flag, sha, ...(isConfigSnapshot(config) ? { config } : {}) };
}

/** Why the in-progress removal is not verified, or undefined when a full verify passed on `current`. */
function unverified({ flagDir, baseline, committed }: Tracked, current: string): string | undefined {
  const run = `run flagrm verify ${baseline.flag} --json`;
  if (committed) {
    // Not released by a verify yet, or `tracked` would have dropped it.
    const abandoned = `.flagrm/${path.basename(flagDir)}`;
    return `flagrm: ${baseline.flag} removal committed but never verified — ${run} (or delete ${abandoned} if it was abandoned)`;
  }
  const verify = readJson<Partial<VerifyReport>>(path.join(flagDir, "verify.json"));
  // A report without `skipped` comes from an older flagrm, which didn't record skips.
  const skipped = verify?.skipped;
  if (verify?.status !== "pass" || verify.fingerprint !== current || !isStringArray(skipped)) {
    return `flagrm: ${baseline.flag} removal not verified — ${run}`;
  }
  if (skipped.length) {
    return `flagrm: ${baseline.flag} verified with --skip ${skipped.join(",")} — ${run} without --skip`;
  }
  return undefined;
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
