import pc from "picocolors";
import type { DoctorReport, DoctorStatus } from "./doctor.js";
import type { StepResult, StepStatus } from "./install.js";
import { reusedNote } from "./run-cache.js";
import type { ProjectSetup } from "./scope.js";
import type { Baseline, CheckStatus, ConfigState, FlagInventoryEntry, ListReport, VerifyReport } from "./types.js";
import { plural, relativePath } from "./util.js";

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

    const project = pad([...entry.definitions, ...entry.config, ...entry.flow].map((x) => x.project));
    const kind = pad(entry.definitions.map((d) => d.kind));
    const name = pad(entry.definitions.map((d) => d.name));
    for (const d of entry.definitions) {
      console.log(
        `  ${pc.dim("defined")}  ${pc.dim(project(d.project))}  ${pc.dim(kind(d.kind))}  ${name(d.name)}  ${pc.cyan(`${rel(d.file)}:${d.line}`)}`,
      );
    }
    const flowKind = pad(entry.flow.map((n) => n.kind));
    const flowName = pad(entry.flow.map((n) => n.name));
    for (const n of entry.flow) {
      console.log(
        `  ${pc.dim("flows  ")}  ${pc.dim(project(n.project))}  ${pc.dim(flowKind(n.kind))}  ${flowName(n.name)}  ${pc.cyan(`${rel(n.file)}:${n.line}`)}` +
          (n.record ? "" : pc.dim("  (suggested)")),
      );
    }
    if (entry.parameterizedTests.length) {
      console.log(
        `  ${pc.dim("tests  ")}  ${plural(entry.parameterizedTests.length, "test call")} pass the flag's value as a literal`,
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
    pc.dim(
      "Reference counts are direct uses of the flag's literal and definitions, not reads through wrappers. " +
        "`flows` are the names its value travels through; `baseline` records the ones not marked suggested.",
    ),
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
  const note = reusedNote(checks ?? [], baseline.createdAt);
  if (note) console.log(`  ${pc.dim(note)}`);
  if (baseline.names.length) {
    const names = baseline.names.map((n) =>
      n.kind === "literal" ? n.name : `${n.name} (${n.kind}${n.file ? ` in ${n.file}` : ""})`,
    );
    console.log(`  names: ${pc.dim(names.join(", "))}`);
  }
  const accepted = [
    baseline.acceptedConfig && "the config as of now",
    baseline.acceptedFailures && "the baseline's failing tests",
  ].filter(Boolean);
  if (accepted.length) console.log(`  accepted: ${pc.dim(accepted.join(", "))}`);
  for (const n of baseline.suggestedNames ?? []) {
    console.log(
      `  ${pc.yellow("suggested")} ${n.name} ${pc.dim(`(${n.kind})`)} ${pc.cyan(`${rel(n.file)}:${n.line}`)} ` +
        pc.dim(
          `if it only carries this flag: --name ${n.name} --kind wrapper` +
            (n.kind === "method" || n.kind === "property" ? "" : ` --file ${rel(n.file)}`),
        ),
    );
  }
  for (const t of baseline.parameterizedTests ?? []) {
    console.log(
      `  ${pc.dim("test passes")} ${t.parameter}: ${t.value} ${pc.dim(`to ${t.method}`)} ${pc.cyan(`${rel(t.file)}:${t.line}`)}`,
    );
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
  }
  if (report.strict && warned) console.log(pc.dim("\n  --strict: warnings count as failures."));
  const note = reusedNote(report.runs, report.createdAt);
  if (note) console.log(pc.dim(`\n  ${note}`));
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

/** `flagrm scope`: each .NET project's setup problems and what flagrm.slnf leaves out. */
export function printScope(setups: ProjectSetup[], root: string, written: boolean): void {
  if (setups.length === 0) {
    console.log(pc.dim("No .NET projects in the config."));
    return;
  }
  for (const s of setups) {
    const solution = s.setup ? relativePath(root, s.setup.solution) : s.note;
    console.log(`${pc.bold(s.project)} ${pc.dim(solution ?? "")}`);
    if (s.sdk) console.log(`  ${pc.red("✗")} ${s.sdk}`);
    for (const p of s.setup?.problems ?? []) console.log(`  ${pc.yellow("!")} ${p}`);
    const out = s.setup?.leaveOut ?? [];
    if (!s.sdk && !s.setup?.problems.length) console.log(`  ${pc.green("✓")} this machine has what it needs`);
    if (out.length) {
      const total = s.setup?.projects.length ?? 0;
      console.log(
        `  ${written ? "flagrm.slnf leaves out" : "flagrm.slnf would leave out"} ${out.length} of ${total} projects:`,
      );
      for (const l of out.slice(0, 30)) console.log(`    ${l.entry} ${pc.dim(`— ${l.reason}`)}`);
      if (out.length > 30) console.log(pc.dim(`    … ${out.length - 30} more`));
      console.log(
        pc.dim(
          written
            ? "  Their builds and tests won't run: verify can't check edits to them, so say so in the PR."
            : "  Run `flagrm scope --write` to create it and point the build and test at it.",
        ),
      );
    }
    if (s.sdk) console.log(pc.dim("  A solution filter can't help here: install the SDK or change global.json."));
  }
}
