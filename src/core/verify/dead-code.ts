/**
 * The `dead-code` check: compiler unused-code diagnostics in the changed
 * files that the baseline did not have (fail; warn when the adapter cannot
 * tell which ones are new).
 */

import fs from "node:fs";
import path from "node:path";
import { fileAt } from "../git.js";
import type { CheckFinding, CheckResult } from "../types.js";
import { checkResult, plural, skippedResult, type VerifyContext } from "./context.js";

export function deadCodeCheck(v: VerifyContext): CheckResult {
  const { findings, summary, analyzed } = compilerFindings(v);
  // A check that did not look at every changed file must not read as a pass (a found diagnostic still fails it).
  if (!analyzed && !findings.some((f) => f.severity === "fail" || f.severity === "warn")) {
    return skippedResult("dead-code", summary, findings);
  }
  return checkResult("dead-code", summary, findings);
}

function compilerFindings(v: VerifyContext): { findings: CheckFinding[]; summary: string; analyzed: boolean } {
  const sha = v.baseline.git.sha;
  if (!sha || !v.changedFiles) {
    const reason = sha
      ? "the baseline commit is no longer reachable (amended, rebased or garbage-collected)"
      : "the baseline has no git commit to diff against";
    return {
      findings: [{ severity: "info", message: `compiler diagnostics skipped: ${reason}` }],
      summary: "compiler diagnostics skipped",
      analyzed: false,
    };
  }
  const findings: CheckFinding[] = [];
  let count = 0;
  let supported = false;
  const unread: string[] = [];
  for (const { adapter, ctx } of v.projects) {
    if (!adapter.unusedDiagnostics) continue;
    supported = true;
    const inProject = new Set(ctx.files);
    const changedFiles = v.changedFiles
      .map((rel) => path.join(v.root, rel))
      .filter((file) => inProject.has(file) && fs.existsSync(file));
    if (changedFiles.length === 0) continue;
    const readLog = (log?: string) => {
      try {
        return log ? fs.readFileSync(log, "utf8") : undefined;
      } catch {
        return undefined;
      }
    };
    const buildLog = readLog(v.runs.find((r) => r.project === ctx.name && r.check === "build")?.log);
    const baselineBuildLog = readLog(
      v.baseline.checks?.find((r) => r.project === ctx.name && r.check === "build")?.log,
    );
    const result = adapter.unusedDiagnostics(ctx, {
      changedFiles,
      baselineText: (file) => fileAt(v.root, sha, path.relative(v.root, file)),
      buildLog,
      baselineBuildLog,
    });
    if (!result) {
      unread.push(ctx.name);
      findings.push({
        severity: "info",
        message: "compiler diagnostics skipped: no build output to read (the build check did not run)",
        project: ctx.name,
      });
      continue;
    }
    for (const d of result.diagnostics) {
      count++;
      findings.push({
        severity: result.compared ? "fail" : "warn",
        message: `${d.code} ${d.message}${result.compared ? "" : " (the baseline has no build log, so it may predate the removal)"}`,
        project: ctx.name,
        file: d.file,
        line: d.line,
      });
    }
  }
  if (!supported) {
    return { findings, summary: "compiler diagnostics skipped: no adapter reports unused code here", analyzed: false };
  }
  const found = count ? plural(count, "new unused-code diagnostic") : "no new unused-code diagnostics";
  if (unread.length) {
    return {
      findings,
      summary: `${count ? `${found}; ` : ""}compiler diagnostics skipped for ${unread.join(", ")}: no build output`,
      analyzed: false,
    };
  }
  return { findings, summary: found, analyzed: true };
}
