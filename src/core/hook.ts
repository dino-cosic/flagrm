/**
 * `flagrm hook stop`: the Claude Code Stop hook. It blocks the agent from
 * finishing while a flag removal is underway and not verified. It never runs
 * builds or tests, and anything unexpected allows the stop: a broken hook
 * must never trap the user.
 */

import fs from "node:fs";
import path from "node:path";
import { CONFIG_FILENAMES, findConfigRoot } from "./config.js";
import { headSha, trackedChangesSince, treeFingerprint } from "./git.js";
import type { Baseline, VerifyReport } from "./types.js";
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
 * matches the current tree. In progress means HEAD is still the baseline
 * commit and a file git tracks changed, other than the flagrm config (a
 * removal paused on a question to the user, or a stray test result file,
 * doesn't count), or the last verify skipped checks. Once HEAD moves (a
 * commit, a branch switch, a merge), that removal is no longer guarded.
 */
export function stopDecision(root: string, input: StopHookInput): StopDecision {
  if (input.stop_hook_active) return { block: false };
  try {
    const dir = path.join(root, ".flagrm");
    if (!fs.existsSync(dir)) return { block: false };
    const head = headSha(root);
    if (!head) return { block: false };
    const active = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name))
      .filter((flagDir) => readJson<Baseline>(path.join(flagDir, "baseline.json"))?.git?.sha === head);
    if (active.length === 0) return { block: false };
    const edited = (trackedChangesSince(root, head) ?? []).some((rel) => !CONFIG_FILENAMES.includes(rel));
    const started = active.filter((flagDir) => edited || lastVerifySkipped(flagDir));
    if (started.length === 0) return { block: false };
    const current = treeFingerprint(root);
    if (!current) return { block: false };
    const reasons = started.map((flagDir) => unverified(flagDir, current)).filter((r): r is string => r !== undefined);
    return reasons.length ? { block: true, reason: reasons.join("\n") } : { block: false };
  } catch {
    return { block: false };
  }
}

function lastVerifySkipped(flagDir: string): boolean {
  const skipped = readJson<Partial<VerifyReport>>(path.join(flagDir, "verify.json"))?.skipped;
  return Array.isArray(skipped) && skipped.length > 0;
}

/** Why the in-progress removal in `flagDir` is not verified, or undefined when a full verify passed on `current`. */
function unverified(flagDir: string, current: string): string | undefined {
  const baseline = readJson<Baseline>(path.join(flagDir, "baseline.json"));
  if (!baseline) return undefined;
  const verify = readJson<Partial<VerifyReport>>(path.join(flagDir, "verify.json"));
  const run = `run flagrm verify ${baseline.flag} --json`;
  // A report without `skipped` comes from an older flagrm, which didn't record skips.
  if (verify?.status !== "pass" || verify.fingerprint !== current || !Array.isArray(verify.skipped)) {
    return `flagrm: ${baseline.flag} removal not verified — ${run}`;
  }
  if (verify.skipped.length) {
    return `flagrm: ${baseline.flag} verified with --skip ${verify.skipped.join(",")} — ${run} without --skip`;
  }
  return undefined;
}
