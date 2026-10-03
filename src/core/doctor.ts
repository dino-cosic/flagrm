/**
 * `flagrm doctor`: is this repository ready for an agent to remove a flag?
 * Config, build/test commands, git, .gitignore, the installed skills and
 * hook, and baselines left behind by abandoned removals.
 */

import fs from "node:fs";
import path from "node:path";
import { realProbes, type SetupProbes } from "../adapters/dotnet/setup.js";
import type { Workspace } from "./adapter.js";
import { errorExcerpt, incrementalBuildGap, runCheck, templateCheckGap } from "./baseline.js";
import { findConfigFile, loadConfig } from "./config.js";
import { projectCommands } from "./config-snapshot.js";
import { gitState, isAncestor } from "./git.js";
import { AGENT_SKILL_DIRS, installedSkillVersion, SKILLS, stopHookState } from "./install.js";
import { packageVersion } from "./package.js";
import { resolveProjects } from "./registry.js";
import { setupReport } from "./scope.js";
import type { Baseline } from "./types.js";
import { onPath, readJson, relativePath } from "./util.js";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  status: DoctorStatus;
  message: string;
  /** Supporting lines, e.g. the errors from a failed command's log. */
  details?: string[];
}

export interface DoctorReport {
  /** `fail` when any check fails; warnings don't fail doctor. */
  status: "ok" | "fail";
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  config?: string;
  /** Also run each build and test command. */
  run?: boolean;
  /** What the machine has (SDKs, `cargo`, Docker); the real machine by default. */
  probes?: SetupProbes;
}

/** Check the setup in `cwd`: config and commands, git, .gitignore, skills, hook and abandoned baselines. */
export async function runDoctor(cwd: string, options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (status: DoctorStatus, message: string, details?: string[]) =>
    checks.push({ status, message, ...(details?.length ? { details } : {}) });
  // Skills, hook and .gitignore live next to the config, which may be in a parent of `cwd`.
  const configFile = options.config ? path.resolve(cwd, options.config) : findConfigFile(cwd);
  const root = configFile ? path.dirname(configFile) : cwd;
  await configChecks(cwd, configFile, options, add);

  const git = gitState(root);
  if (git.sha === null) add("warn", "not a git repository: verify can't diff against the baseline");
  else if (git.dirty)
    add("warn", `${git.dirtyFiles?.length ?? 0} uncommitted files — commit or stash before a removal`);
  else add("ok", "working tree clean");

  const gitignore = path.join(root, ".gitignore");
  const ignored = fs.existsSync(gitignore) && /^\/?\.flagrm\/?\s*$/m.test(fs.readFileSync(gitignore, "utf8"));
  add(
    ignored ? "ok" : "warn",
    ignored ? ".flagrm/ is gitignored" : "add .flagrm/ to .gitignore (flagrm init does this)",
  );

  const version = packageVersion();
  for (const dir of AGENT_SKILL_DIRS) {
    const versions = SKILLS.map((s) => installedSkillVersion(path.join(root, dir, s)));
    if (versions.every((v) => v === undefined)) add("warn", `${dir}: skills not installed (run flagrm init)`);
    else if (versions.some((v) => v !== version)) {
      const found = versions.find((v) => v !== version) ?? "missing";
      add("warn", `${dir}: skills from flagrm ${found}, this is ${version} (run flagrm update)`);
    } else add("ok", `${dir}: skills ${version}`);
  }

  const hook = stopHookState(root);
  if (hook === "current") add("ok", "Claude Code Stop hook installed");
  else if (hook === "outdated") add("warn", "Claude Code Stop hook runs an outdated command (run flagrm update)");
  else add("warn", "Claude Code Stop hook missing from .claude/settings.json (run flagrm init)");

  if (git.sha !== null) abandonedBaselines(root, add);
  return { status: checks.some((c) => c.status === "fail") ? "fail" : "ok", checks };
}

/** Config, project paths and commands of `configFile` (from --config or found from `cwd`). */
async function configChecks(
  cwd: string,
  configFile: string | undefined,
  options: DoctorOptions,
  add: (status: DoctorStatus, message: string, details?: string[]) => void,
): Promise<void> {
  if (!configFile) {
    add("fail", "no flagrm.config.yaml (run flagrm init)");
    return;
  }
  let root: string;
  let projects: ReturnType<typeof resolveProjects>;
  try {
    const config = loadConfig({ config: configFile }, cwd);
    root = config.root;
    projects = resolveProjects(config);
  } catch (err) {
    add("fail", `config: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  setupChecks(projects, root, options.probes ?? realProbes((exe) => onPath(exe, root)), add);
  for (const { adapter, ctx } of projects) {
    const commands = projectCommands(adapter, ctx);
    for (const check of ["build", "test"] as const) {
      const command = commands[check];
      if (!command) {
        add(
          "warn",
          `${ctx.name}: no ${check} command — verify can't ${check === "build" ? "check the build" : "compare tests"}`,
        );
        continue;
      }
      const missing = simpleCommandProgram(command);
      if (missing && !onPath(missing, ctx.root)) {
        add("fail", `${ctx.name}: \`${missing}\` (from \`${command}\`) is not on PATH`);
        continue;
      }
      if (check === "build") {
        for (const gap of [templateCheckGap(adapter, command), incrementalBuildGap(adapter, command)]) {
          if (gap) add("warn", `${ctx.name}: ${gap}`);
        }
      }
      if (!options.run) {
        add("ok", `${ctx.name}: ${check} command \`${command}\``);
        continue;
      }
      const run = await runCheck(ctx, check, command, path.join(root, ".flagrm", "doctor", `${ctx.name}.${check}.log`));
      if (run.exitCode === 0) {
        add("ok", `${ctx.name}: \`${command}\` passed`);
        continue;
      }
      add(
        "fail",
        `${ctx.name}: \`${command}\` failed (exit ${run.exitCode}, log ${relativePath(cwd, run.log ?? "")})`,
        run.failure ? [`setup problem: ${run.failure.message}`] : errorExcerpt(run.log, 3),
      );
    }
  }
}

/**
 * Whether the machine can build and test each .NET project: no SDK matching
 * global.json fails (nothing builds), a missing `cargo` or Docker warns (a
 * solution filter can leave out the projects that need them).
 */
function setupChecks(
  projects: Workspace,
  root: string,
  probes: SetupProbes,
  add: (status: DoctorStatus, message: string, details?: string[]) => void,
): void {
  for (const s of setupReport(projects, root, probes)) {
    if (s.sdk) add("fail", `${s.project}: ${s.sdk}`);
    const problems = s.setup?.problems ?? [];
    if (problems.length) {
      const out = s.setup?.leaveOut.length ?? 0;
      add(
        "warn",
        `${s.project}: ${problems.join("; ")} — \`flagrm scope\` shows the ${out} projects a solution filter would leave out`,
      );
    }
  }
}

/**
 * The program of a simple command (`dotnet build`, `CI=1 npm test`), for the
 * PATH check, or undefined when the command uses shell syntax (`&&`, `|`,
 * quotes, `$VAR`, redirections, ...). Those are left to the build and test
 * runs: parsing shell well enough to find every program is not worth it.
 */
export function simpleCommandProgram(command: string): string | undefined {
  if (/[;&|()<>`$"'\n{}]/.test(command)) return undefined;
  return command
    .trim()
    .split(/\s+/)
    .find((word) => !/^\w+=/.test(word));
}

/** `.flagrm/<flag>/` entries whose baseline commit is not in this branch's history. */
function abandonedBaselines(root: string, add: (status: DoctorStatus, message: string) => void): void {
  const dir = path.join(root, ".flagrm");
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sha = readJson<Partial<Baseline>>(path.join(dir, entry.name, "baseline.json"))?.git?.sha;
    if (sha && !isAncestor(root, sha)) {
      add(
        "warn",
        `.flagrm/${entry.name}: baseline commit ${sha.slice(0, 7)} is not in this branch's history — delete it if that removal was abandoned`,
      );
    }
  }
}
