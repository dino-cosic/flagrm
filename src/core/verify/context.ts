import type { Workspace } from "../adapter.js";
import type { ConfigChange } from "../config-snapshot.js";
import type { Baseline, CheckFinding, CheckId, CheckResult, CheckRun } from "../types.js";

/** Everything the checks read. Nothing in here is re-derived by a check. */
export interface VerifyContext {
  /** Config root: `.flagrm/` and every git path are relative to it. */
  root: string;
  flag: string;
  projects: Workspace;
  baseline: Baseline;
  /** Files (relative to `root`) changed since the baseline commit; undefined without git. */
  changedFiles?: string[];
  /** Build/test commands this verify ran. */
  runs: CheckRun[];
  /** How the configuration differs from the baseline's. */
  configChanges: ConfigChange[];
}

/** Warnings about the configuration changes that affect check `id`. */
export function configFindings(v: VerifyContext, id: ConfigChange["check"]): CheckFinding[] {
  return v.configChanges
    .filter((c) => c.check === id)
    .flatMap((c) => [
      { severity: "warn" as const, message: c.message, project: c.project },
      ...(c.details ?? []).map((line) => ({ severity: "info" as const, message: line, project: c.project })),
    ]);
}

/** A check's status is the worst severity among its findings. */
export function checkResult(id: CheckId, summary: string, findings: CheckFinding[]): CheckResult {
  const status = findings.some((f) => f.severity === "fail")
    ? "fail"
    : findings.some((f) => f.severity === "warn")
      ? "warn"
      : "pass";
  return { id, status, summary, findings };
}

export function skippedResult(id: CheckId, summary: string, findings: CheckFinding[] = []): CheckResult {
  return { id, status: "skipped", summary, findings };
}

export { plural } from "../util.js";
