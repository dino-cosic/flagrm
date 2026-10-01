/**
 * `flagrm verify <flag> --md`: a compact markdown overview of a verify result
 * for the user or a PR. Every fact comes from the report; the agent adds
 * notes and the commit message around it.
 */

import type { CheckFinding, CheckStatus, VerifyReport } from "./types.js";
import { relativePath } from "./util.js";
import { shortTestNames } from "./verify/test-results.js";

const ICON: Record<CheckStatus, string> = { pass: "✅", fail: "❌", warn: "⚠️", skipped: "➖" };

/** How many entries a list shows before summarizing the rest. */
const MAX_ITEMS = 20;

function codeList(items: string[]): string {
  const shown = items
    .slice(0, MAX_ITEMS)
    .map((i) => `\`${i}\``)
    .join(", ");
  return items.length > MAX_ITEMS ? `${shown} and ${items.length - MAX_ITEMS} more` : shown;
}

function findingLine(root: string, f: CheckFinding): string {
  if (!f.file) return `- ${f.message}`;
  const rel = relativePath(root, f.file);
  return `- \`${rel}${f.line ? `:${f.line}` : ""}\` ${f.message}`;
}

/** Render a verify report as markdown: status, checks table, changed files, removed and new tests, failures and warnings. */
export function verifyMarkdown(report: VerifyReport, root: string): string {
  const out = [
    `### flagrm verify: ${report.flag} ${report.status === "pass" ? "✅ pass" : "❌ fail"}`,
    "",
    "| Check | Status | Summary |",
    "|---|---|---|",
    ...report.checks.map((c) => `| ${c.id} | ${ICON[c.status]} ${c.status} | ${c.summary.replace(/\|/g, "\\|")} |`),
  ];
  const changed = report.changedFiles ?? [];
  if (changed.length) out.push("", `**Files changed since baseline (${changed.length}):** ${codeList(changed)}`);
  const removed = report.tests.flatMap((t) => t.removed);
  if (removed.length) {
    out.push("", `**Tests that no longer run (${removed.length}):** ${codeList(shortTestNames(removed))}`);
  }
  const added = report.tests.flatMap((t) => t.added);
  if (added.length) out.push("", `**New tests (${added.length}):** ${codeList(shortTestNames(added))}`);
  for (const [severity, title] of [
    ["fail", "Failures"],
    ["warn", "Warnings"],
  ] as const) {
    const items = report.checks.flatMap((c) => c.findings.filter((f) => f.severity === severity));
    if (items.length === 0) continue;
    out.push("", `**${title}:**`, ...items.slice(0, MAX_ITEMS).map((f) => findingLine(root, f)));
    if (items.length > MAX_ITEMS) out.push(`- and ${items.length - MAX_ITEMS} more (see --json)`);
  }
  return `${out.join("\n")}\n`;
}
