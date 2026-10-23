/**
 * `flagrm verify <flag> --md`: a compact markdown overview of a verify result
 * for the user or a PR. Every fact comes from the report; the agent adds
 * notes and the commit message around it.
 */

import { reusedNote } from "./run-cache.js";
import type { CheckFinding, CheckStatus, StaleEnvironment, StaleReport, StaleVerdict, VerifyReport } from "./types.js";
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

/** One environment in a few words: `production true 45d`, `staging targeted (1 rule(s))`. */
export function staleEnvironmentText(e: StaleEnvironment): string {
  if (e.serves === "targeted") return `${e.environment} targeted (${e.detail})`;
  const days = e.days === undefined ? "" : ` ${e.days}d${e.sinceSource === "lastModified" ? "*" : ""}`;
  return `${e.environment} ${JSON.stringify(e.value)}${days}`;
}

/** The conditions a report applied, in one line. */
export function staleConditionsText(report: StaleReport): string {
  const c = report.conditions;
  const parts = [
    `boolean, true in ${c.environments.join(", ") || "no environment"} for ${c.minDaysOn}+ days`,
    ...(c.temporaryOnly ? ["temporary"] : []),
    ...(c.tags.include.length ? [`tags ${c.tags.include.join(", ")}`] : []),
    ...(c.tags.exclude.length ? [`not tagged ${c.tags.exclude.join(", ")}`] : []),
  ];
  return parts.join("; ");
}

const STALE_TITLES: Record<StaleVerdict, string> = {
  remove: "Ready to remove",
  keep: "Keep",
  unreferenced: "Not referenced in this repository",
};

/** `flagrm stale --md`: the flags per verdict, for a pull request or a pipeline summary. */
export function staleMarkdown(report: StaleReport): string {
  const count = (v: StaleVerdict) => report.flags.filter((f) => f.verdict === v).length;
  const out = [
    `### flagrm stale: ${report.project} — ${count("remove")} ready to remove`,
    "",
    `_Conditions: ${staleConditionsText(report)}. Evaluated ${report.evaluatedAt}._`,
  ];
  const cell = (text: string) => text.replace(/\|/g, "\\|");
  for (const verdict of ["remove", "keep"] as const) {
    const flags = report.flags.filter((f) => f.verdict === verdict);
    if (!flags.length) continue;
    const columns = ["Flag", "Code name", "Environments", ...(verdict === "keep" ? ["Reasons"] : [])];
    out.push(
      "",
      `**${STALE_TITLES[verdict]} (${flags.length})**`,
      "",
      `| ${columns.join(" | ")} |`,
      `|${"---|".repeat(columns.length)}`,
    );
    for (const f of flags) {
      const cells = [
        f.key ? `\`${f.key}\`` : "—",
        f.codeName ? `\`${f.codeName}\`` : "—",
        cell(f.environments.map(staleEnvironmentText).join(", ") || "—"),
        ...(verdict === "keep" ? [cell(f.reasons.join("; "))] : []),
      ];
      out.push(`| ${cells.join(" | ")} |`);
    }
  }
  const unreferenced = report.flags.filter((f) => f.verdict === "unreferenced").map((f) => f.key ?? "");
  if (unreferenced.length) {
    out.push(
      "",
      `**${STALE_TITLES.unreferenced} (${unreferenced.length}):** ${codeList(unreferenced)}`,
      "",
      "_Another repository may still read these; flagrm doesn't recommend archiving them._",
    );
  }
  if (report.flags.some((f) => f.environments.some((e) => e.sinceSource === "lastModified"))) {
    out.push("", "_\\* days since the environment last changed: the audit log had no targeting change to date._");
  }
  return out.join("\n");
}
