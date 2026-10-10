/**
 * `flagrm verify <flag> --md`: a compact markdown overview of a verify result
 * for the user or a PR. Every fact comes from the report; the agent adds
 * notes and the commit message around it.
 */

import { reusedNote } from "./run-cache.js";
import type { CheckFinding, CheckStatus, VerifyReport } from "./types.js";
import { relativePath } from "./util.js";
import { shortTestName, shortTestNames } from "./verify/test-results.js";

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
  const note = reusedNote(report.runs, report.createdAt);
  if (note) out.push("", `_${note}_`);
  const changed = report.changedFiles ?? [];
  if (changed.length) out.push("", `**Files changed since baseline (${changed.length}):** ${codeList(changed)}`);
  const all = <K extends "deleted" | "excludedByConfig" | "unexplained">(key: K) => report.tests.flatMap((t) => t[key]);
  const renamed = report.tests.flatMap((t) => t.renamed);
  for (const [names, title] of [
    [all("deleted"), "Tests deleted"],
    [all("excludedByConfig"), "Tests excluded by a config change"],
    [all("unexplained"), "Tests that no longer run, unexplained"],
  ] as const) {
    if (names.length) out.push("", `**${title} (${names.length}):** ${codeList(shortTestNames(names))}`);
  }
  if (renamed.length) {
    const pairs = renamed.map((r) => `\`${shortTestName(r.from)}\` → \`${shortTestName(r.to)}\``);
    out.push("", `**Tests renamed (${renamed.length}):** ${pairs.slice(0, MAX_ITEMS).join(", ")}`);
  }
  const renamedTo = new Set(renamed.map((r) => r.to));
  const added = report.tests.flatMap((t) => t.added).filter((name) => !renamedTo.has(name));
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
