/**
 * `flagrm scope`: check that the machine can build and test each .NET
 * project, and when it lacks something only some projects need (`cargo`,
 * Docker), narrow the build and test to a solution filter, `flagrm.slnf`,
 * that leaves those projects out. A smaller scope that runs beats a full one
 * that can't: the baseline's results are then real.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import YAML from "yaml";
import { type SetupProbes, type SolutionSetup, sdkProblem, solutionSetup } from "../adapters/dotnet/setup.js";
import type { ProjectContext, Workspace } from "./adapter.js";
import { projectCommands } from "./config-snapshot.js";
import { relativePath } from "./util.js";

export const SLNF = "flagrm.slnf";

/** What one .NET project of the config needs from the machine. */
export interface ProjectSetup {
  project: string;
  /** Why the project can't build with the installed SDKs. */
  sdk?: string;
  /** Its solution, checked; undefined when there is no single one to check (see `note`). */
  setup?: SolutionSetup;
  note?: string;
}

/** Check each .NET project of the workspace. */
export function setupReport(projects: Workspace, root: string, probes: SetupProbes): ProjectSetup[] {
  const out: ProjectSetup[] = [];
  for (const { adapter, ctx } of projects) {
    if (adapter.id !== "dotnet") continue;
    const entry: ProjectSetup = { project: ctx.name };
    const sdk = sdkProblem(ctx.root, probes, root);
    if (sdk) entry.sdk = sdk;
    const solution = solutionFor(ctx, projectCommands(adapter, ctx));
    if ("note" in solution) entry.note = solution.note;
    else {
      try {
        entry.setup = solutionSetup(solution.solution, probes, root, solution.only);
      } catch (err) {
        entry.note = `can't read ${relativePath(root, solution.solution)}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    out.push(entry);
  }
  return out;
}

/** A `.sln`, `.slnx` or `.slnf` named by a command. */
const SOLUTION_ARG = /(?<=^|\s)(?:(["'])([^"']+\.sln[xf]?)\1|([^\s"']+\.sln[xf]?))(?=\s|$)/;

/** The solution path in a SOLUTION_ARG match, quoted or not. */
const solutionArg = (m: RegExpExecArray | null) => m?.[2] ?? m?.[3];

/** A project file (`.csproj`, `.fsproj`, ...) named by a command. */
const PROJECT_ARG = /(?<=^|\s)["']?[^\s"']+\.\w*proj["']?(?=\s|$)/;

/**
 * The solution a project builds: the one its build or test command names, or
 * the only one in its directory. When the command names a solution filter
 * (a user's own or flagrm.slnf), the solution it filters, with `only` its
 * projects: that is the scope, which flagrm only narrows further.
 */
function solutionFor(
  ctx: ProjectContext,
  commands: { build?: string; test?: string },
): { solution: string; only?: string[] } | { note: string } {
  for (const command of [commands.build, commands.test]) {
    if (command && PROJECT_ARG.test(command) && !SOLUTION_ARG.test(command)) {
      return { note: `\`${command}\` builds a project, not a solution: nothing to narrow` };
    }
  }
  for (const command of [commands.build, commands.test]) {
    const arg = command && solutionArg(SOLUTION_ARG.exec(command));
    if (!arg) continue;
    const file = path.resolve(ctx.root, arg);
    if (!fs.existsSync(file)) return { note: `${arg} (from \`${command}\`) not found` };
    if (!file.endsWith(".slnf")) return { solution: file };
    try {
      const { path: inner, projects } = JSON.parse(fs.readFileSync(file, "utf8"))?.solution ?? {};
      if (typeof inner === "string") {
        const solution = path.resolve(path.dirname(file), inner.replace(/\\/g, "/"));
        const dir = path.dirname(solution);
        const only = Array.isArray(projects)
          ? projects.filter((p) => typeof p === "string").map((p) => path.resolve(dir, p.replace(/\\/g, "/")))
          : undefined;
        return { solution, only };
      }
    } catch {
      return { note: `can't read ${arg}` };
    }
  }
  const found = fg.sync("*.{sln,slnx}", { cwd: ctx.root, absolute: true });
  // fast-glob returns forward slashes, also on Windows.
  if (found.length === 1) return { solution: path.normalize(found[0]) };
  return { note: found.length ? "several solutions: name one in build/test" : "no solution file found" };
}

/** One line of what `--write` did. */
export interface ScopeStep {
  path: string;
  status: "created" | "updated" | "unchanged" | "skipped";
  note?: string;
}

/**
 * Create each solution's flagrm.slnf without the projects to leave out, keep
 * it out of git through `.git/info/exclude` (it describes this machine, not
 * the repository), and point the project's build and test at it in the config.
 */
export function writeScope(
  setups: ProjectSetup[],
  projects: Workspace,
  root: string,
  configFile: string | undefined,
): ScopeStep[] {
  const steps: ScopeStep[] = [];
  const commandUpdates: CommandUpdate[] = [];
  for (const s of setups) {
    if (!s.setup?.leaveOut.length) continue;
    const { solution, leaveOut, projects: all } = s.setup;
    const slnf = path.join(path.dirname(solution), SLNF);
    const out = new Set(leaveOut.map((l) => l.entry));
    const content = `${JSON.stringify(
      { solution: { path: path.basename(solution), projects: all.map((p) => p.entry).filter((e) => !out.has(e)) } },
      null,
      2,
    )}\n`;
    const before = fs.existsSync(slnf) ? fs.readFileSync(slnf, "utf8") : undefined;
    if (before !== content) fs.writeFileSync(slnf, content, "utf8");
    steps.push({
      path: relativePath(root, slnf),
      status: before === undefined ? "created" : before === content ? "unchanged" : "updated",
      note: `${all.length - out.size} of ${all.length} projects`,
    });
    steps.push(excludeFromGit(root, slnf));

    const target = projects.find((p) => p.ctx.name === s.project);
    if (target) {
      const commands = projectCommands(target.adapter, target.ctx);
      const relative = relativePath(target.ctx.root, slnf) || SLNF;
      const rel = /\s/.test(relative) ? `"${relative}"` : relative;
      commandUpdates.push({
        project: s.project,
        // The resolved commands: the configured ones, or the adapter's defaults when none are.
        build: commands.build && pointAt(commands.build, rel),
        test: commands.test && pointAt(commands.test, rel),
        // Written out, the test command is no longer the default, so its default results location must be too.
        testResults:
          commands.testResults && commands.defaults.includes("testResults")
            ? `./${relativePath(root, commands.testResults)}`
            : undefined,
      });
    }
  }
  if (commandUpdates.length) steps.push(updateConfig(configFile, root, commandUpdates));
  return steps;
}

/**
 * `command` building `slnf` instead of the solution it names, or the solution
 * `dotnet` would find. A command naming a project file is left as it is:
 * `dotnet` takes one project or solution, not both.
 */
export function pointAt(command: string, slnf: string): string {
  if (SOLUTION_ARG.test(command)) return command.replace(SOLUTION_ARG, slnf);
  if (PROJECT_ARG.test(command)) return command;
  return command.replace(/\bdotnet\s+(build|test)\b/, `dotnet $1 ${slnf}`);
}

/**
 * `file` with symlinks resolved and, on Windows, 8.3 short names expanded
 * (`RUNNER~1`): git prints long names, `os.tmpdir()` may give short ones. A
 * file that doesn't exist yet resolves through its directory.
 */
function realPath(file: string): string {
  try {
    return fs.realpathSync.native(file);
  } catch {
    const dir = path.dirname(file);
    return dir === file ? file : path.join(realPath(dir), path.basename(file));
  }
}

function excludeFromGit(root: string, file: string): ScopeStep {
  const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  const top = git("rev-parse", "--show-toplevel");
  const exclude = git("rev-parse", "--path-format=absolute", "--git-path", "info/exclude");
  if (top.status !== 0 || exclude.status !== 0)
    return { path: ".git/info/exclude", status: "skipped", note: "not a git repository" };
  const excludeFile = exclude.stdout.trim();
  const line = `/${relativePath(realPath(top.stdout.trim()), realPath(file))}`;
  const text = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf8") : "";
  const shown = relativePath(realPath(root), realPath(excludeFile));
  if (text.split(/\r?\n/).includes(line)) return { path: shown, status: "unchanged" };
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
  fs.appendFileSync(excludeFile, `${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`, "utf8");
  return { path: shown, status: "updated", note: line };
}

interface CommandUpdate {
  project: string;
  build?: string;
  test?: string;
  /** Relative to the config root. */
  testResults?: string;
}

/** Set the build and test commands of `projects:` entries in place, keeping the file's comments and layout. */
function updateConfig(configFile: string | undefined, root: string, updates: CommandUpdate[]): ScopeStep {
  const paste = updates
    .map(
      (u) =>
        `${u.project}: build: ${u.build}; test: ${u.test}${u.testResults ? `; testResults: ${u.testResults}` : ""}`,
    )
    .join("; ");
  if (!configFile || configFile.endsWith(".json")) {
    return {
      path: configFile ? relativePath(root, configFile) : "flagrm.config.yaml",
      status: "skipped",
      note: `set ${paste}`,
    };
  }
  const text = fs.readFileSync(configFile, "utf8");
  const doc = YAML.parseDocument(text);
  const list = doc.get("projects");
  const missing: string[] = [];
  for (const u of updates) {
    const index = YAML.isSeq(list)
      ? list.items.findIndex((item) => YAML.isMap(item) && item.get("name") === u.project)
      : -1;
    if (index === -1) {
      missing.push(u.project);
      continue;
    }
    if (u.build) doc.setIn(["projects", index, "build"], u.build);
    if (u.test) doc.setIn(["projects", index, "test"], u.test);
    if (u.testResults) doc.setIn(["projects", index, "testResults"], u.testResults);
  }
  // lineWidth 0: never fold a long command over two lines.
  const next = doc.toString({ lineWidth: 0 });
  if (next !== text) fs.writeFileSync(configFile, next, "utf8");
  const note = missing.length
    ? `not in projects: (${missing.join(", ")}): set ${paste}`
    : updates.map((u) => `${u.project}: \`${u.build}\`, \`${u.test}\``).join("; ");
  return { path: relativePath(root, configFile), status: next === text ? "unchanged" : "updated", note };
}
