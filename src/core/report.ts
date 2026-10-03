import pc from "picocolors";
import type { DoctorReport, DoctorStatus } from "./doctor.js";
import type { StepResult, StepStatus } from "./install.js";
import type { Baseline, CheckStatus, ConfigState, FlagInventoryEntry, ListReport, VerifyReport } from "./types.js";
import { plural, relativePath } from "./util.js";
import { shortTestNames } from "./verify/test-results.js";

/** A path relative to the working directory, with `/` separators on every platform. */
function rel(file: string): string {
  return relativePath(process.cwd(), file) || file;
}

export function printInventory(report: ListReport): void {
  const { flags, projects } = report;
  if (flags.length === 0) {
    console.log(pc.dim("No feature flags found."));
    return;
  }
  console.log(
    pc.bold(`${plural(flags.length, "flag")} in ${plural(projects.length, "project")}`) +
      pc.dim(` (${projects.map((p) => p.name).join(", ")})\n`),
  );
  const pad = (values: string[]) => {
    const width = Math.max(0, ...values.map((v) => v.length));
    return (v: string) => v.padEnd(width);
  };
  for (const entry of flags) {
    const { references: refs } = entry;
    const byProject = Object.entries(refs.byProject)
      .map(([name, n]) => `${name} ${n}`)
      .join(", ");
    const usage =
      refs.total === 0
        ? pc.yellow("no references")
        : `${plural(refs.total, "ref")} in ${plural(refs.files, "file")}` +
          (refs.tests ? ` (${refs.tests} in tests)` : "") +
          pc.dim(` · ${byProject}`);
    console.log(`${pc.bold(entry.flag)}  ${pc.dim(`${entry.type} · ${stateLabel(entry.state)} ·`)} ${usage}`);

    const project = pad([...entry.definitions, ...entry.config].map((x) => x.project));
    const kind = pad(entry.definitions.map((d) => d.kind));
    const name = pad(entry.definitions.map((d) => d.name));
    for (const d of entry.definitions) {
      console.log(
        `  ${pc.dim("defined")}  ${pc.dim(project(d.project))}  ${pc.dim(kind(d.kind))}  ${name(d.name)}  ${pc.cyan(`${rel(d.file)}:${d.line}`)}`,
      );
    }
    const env = pad(entry.config.map((c) => c.environment));
    const state = pad(entry.config.map((c) => configLabel(c.state, c.filters)));
    for (const c of entry.config) {
      console.log(
        `  ${pc.dim("config ")}  ${pc.dim(project(c.project))}  ${pc.dim(env(c.environment))}  ${state(configLabel(c.state, c.filters))}  ${pc.cyan(`${rel(c.file)}:${c.line}`)}`,
      );
    }
    console.log("");
  }
  console.log(
    pc.dim("Reference counts are direct uses of the flag's literal and definitions, not reads through wrappers."),
  );
}

function stateLabel(state: FlagInventoryEntry["state"]): string {
  return state === "unconfigured" ? "not configured" : state;
}

function configLabel(state: ConfigState, filters?: string[]): string {
  return filters?.length ? `${state} (${filters.join(", ")})` : state;
}

export function printBaseline(baseline: Baseline, file: string): void {
  const { git, checks } = baseline;
  const state = git.sha
    ? `git ${git.sha.slice(0, 7)}${git.dirty ? ", uncommitted changes" : ""}`
    : "not a git repository";
  console.log(`${pc.green(`Baseline for ${baseline.flag} written to ${rel(file)}`)} ${pc.dim(`(${state})`)}`);
  for (const c of checks ?? []) {
    const status = c.exitCode === 0 ? pc.green("pass") : pc.red(`fail (exit ${c.exitCode})`);
    console.log(
      `  ${c.project} ${c.check}: ${status} ${pc.dim(`${c.command} — ${Math.round(c.durationMs / 100) / 10}s`)}`,
    );
    if (c.failure) console.log(`    ${pc.yellow("setup problem:")} ${c.failure.message}`);
  }
  if (baseline.names.length) {
    const names = baseline.names.map((n) => (n.kind === "literal" ? n.name : `${n.name} (${n.kind})`));
    console.log(`  names: ${pc.dim(names.join(", "))}`);
  }
}

const CHECK_STYLE: Record<CheckStatus, { icon: string; color: (s: string) => string }> = {
  pass: { icon: "✓", color: pc.green },
  fail: { icon: "✗", color: pc.red },
  warn: { icon: "!", color: pc.yellow },
  skipped: { icon: "–", color: pc.dim },
};

/** How many findings to print per check before summarizing the rest. */
const MAX_FINDINGS = 15;

export function printVerifyReport(report: VerifyReport, file: string): void {
  const failed = report.checks.filter((c) => c.status === "fail").length;
  const warned = report.checks.filter((c) => c.status === "warn").length;
  const verdict = report.status === "pass" ? pc.green(pc.bold("PASS")) : pc.red(pc.bold("FAIL"));
  const tally = [failed && `${failed} failed`, warned && `${warned} with warnings`].filter(Boolean).join(", ");
  console.log(`\n${pc.bold(`flagrm verify ${report.flag}`)} — ${verdict}${tally ? pc.dim(` (${tally})`) : ""}\n`);

  const width = Math.max(...report.checks.map((c) => c.id.length));
  for (const check of report.checks) {
    const { icon, color } = CHECK_STYLE[check.status];
    console.log(
      `  ${color(icon)} ${check.id.padEnd(width)}  ${check.status === "pass" ? pc.dim(check.summary) : check.summary}`,
    );
    if (check.status === "pass" || check.status === "skipped") continue;
    const shown = check.findings.slice(0, MAX_FINDINGS);
    for (const f of shown) {
      const where = f.file ? `${pc.cyan(`${rel(f.file)}${f.line ? `:${f.line}` : ""}`)} ` : "";
      const project = f.project ? pc.dim(`[${f.project}] `) : "";
      const text = f.severity === "info" ? pc.dim(f.message) : f.message;
      console.log(`      ${project}${where}${text}`);
    }
    if (check.findings.length > shown.length) {
      console.log(pc.dim(`      … ${check.findings.length - shown.length} more (see --json)`));
    }
    if (check.id === "tests") {
      const removed = shortTestNames(report.tests.flatMap((t) => t.removed));
      for (const name of removed.slice(0, MAX_FINDINGS)) console.log(pc.dim(`      no longer runs: ${name}`));
      if (removed.length > MAX_FINDINGS)
        console.log(pc.dim(`      … ${removed.length - MAX_FINDINGS} more (see --md)`));
    }
  }
  if (report.strict && warned) console.log(pc.dim("\n  --strict: warnings count as failures."));
  console.log(pc.dim(`\nResult written to ${rel(file)}.`));
}

const STEP_STYLE: Record<StepStatus, (s: string) => string> = {
  created: pc.green,
  updated: pc.green,
  unchanged: pc.dim,
  skipped: pc.dim,
};

/** One line per `init`/`update` step: `created   .claude/skills/flagrm-remove`. */
export function printSteps(steps: StepResult[]): void {
  for (const s of steps) {
    console.log(STEP_STYLE[s.status](`${s.status.padEnd(9)} ${s.path}${s.note ? ` — ${s.note}` : ""}`));
  }
}

const DOCTOR_STYLE: Record<DoctorStatus, { icon: string; color: (s: string) => string }> = {
  ok: { icon: "✓", color: pc.green },
  warn: { icon: "!", color: pc.yellow },
  fail: { icon: "✗", color: pc.red },
};

/** One line per doctor check, then the overall result. */
export function printDoctor(report: DoctorReport): void {
  for (const c of report.checks) {
    const { icon, color } = DOCTOR_STYLE[c.status];
    console.log(`  ${color(icon)} ${c.status === "ok" ? pc.dim(c.message) : c.message}`);
    for (const line of c.details ?? []) console.log(pc.dim(`      ${line}`));
  }
  console.log(report.status === "ok" ? pc.green("\nflagrm doctor: ok") : pc.red("\nflagrm doctor: problems found"));
}
