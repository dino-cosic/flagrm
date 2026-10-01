/**
 * What `flagrm init` and `flagrm update` write into a repository: the config
 * template, the agent skills, the AGENTS.md pointer for Codex, the Claude
 * Code Stop hook and the `.flagrm/` gitignore entry. Every step reports what
 * it did; nothing the user wrote is overwritten.
 */

import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_BACKEND_ATTRIBUTES,
  DEFAULT_BACKEND_METHODS,
  DEFAULT_FRONTEND_METHODS,
  findConfigRoot,
  findDefaultConfigFile,
  repositoryRoot,
} from "./config.js";
import { type DetectedProject, detectProjects } from "./detect.js";
import { packageRoot, packageVersion } from "./package.js";
import { relativePath } from "./util.js";

export const SKILLS = ["flagrm-remove", "flagrm-verify"] as const;

/** Where each supported agent discovers repository skills: Claude Code, GitHub Copilot, Codex. */
export const AGENT_SKILL_DIRS = [".claude/skills", ".github/skills", ".agents/skills"] as const;

/**
 * The Stop hook command. npx runs the project's own flagrm (a dev dependency)
 * and falls back to a global install. `--no-install` matters: the `flagrm` name
 * on npm belongs to an unrelated package, and a hook must never download code.
 * No redirects or `||`: Claude Code runs hooks in PowerShell on Windows
 * without Git Bash, so the command must parse in both shells.
 */
export const HOOK_COMMAND = "npx --no-install flagrm hook stop";

/** Matches any flagrm Stop hook command, including older or version-pinned ones (`npx flagrm@0.1.0 hook stop`). */
const OUR_HOOK = /\bflagrm(@\S+)? hook stop\b/;

const AGENTS_START = "<!-- flagrm:start -->";
const AGENTS_END = "<!-- flagrm:end -->";

export const AGENTS_BLOCK = [
  AGENTS_START,
  "## Feature flag removal (flagrm)",
  "",
  "To remove a feature flag, follow `.agents/skills/flagrm-remove/SKILL.md`. To check a removal and get its",
  "commit message, follow `.agents/skills/flagrm-verify/SKILL.md`.",
  AGENTS_END,
].join("\n");

export type StepStatus = "created" | "updated" | "unchanged" | "skipped";

export interface StepResult {
  /** Path relative to the repository, with `/` separators. */
  path: string;
  status: StepStatus;
  note?: string;
}

/** `init` adds what is missing and never replaces; `update` refreshes only what `init` installed. */
export type InstallMode = "init" | "update";

const CONFIG_HEADER = [
  "# flagrm configuration, used by the flagrm agent skills (Claude Code, GitHub Copilot, Codex).",
  "# Paths are relative to this file. build/test commands run inside each project's path.",
  "projects:",
];

const CONFIG_FOOTER = [
  "  # Any other stack: the generic adapter",
  "  # - name: service",
  "  #   adapter: generic",
  "  #   path: ./service",
  "  #   globs: ['**/*.go', 'config/**/*.yaml']",
  "  #   methods: [IsEnabled]",
  "",
  "# Optional: extra globs, unioned with the built-in ignore list / language globs",
  "# exclude: ['**/Migrations/**', '**/*.g.cs']",
  "# include: ['**/*.razor.cs']",
  "",
];

/** Used when nothing is detected: one project per supported stack, for the user to adjust. */
const EXAMPLE_PROJECTS: DetectedProject[] = [
  { name: "frontend", adapter: "angular", path: "frontend", marker: "frontend/angular.json" },
  { name: "backend", adapter: "dotnet", path: "backend", marker: "backend/Backend.sln" },
];

/** The config lines for one project, with commented-out commands that fit it. */
function projectLines(p: DetectedProject): string[] {
  const dir = p.path === "." ? "." : `./${p.path}`;
  const inDir = (rel: string) => (p.path === "." ? `./${rel}` : `${dir}/${rel}`);
  const lines = [`  - name: ${p.name}`, `    adapter: ${p.adapter}`, `    path: ${dir}`];
  if (p.adapter === "angular") {
    lines.push(
      "    # build: npx ng build",
      p.jest
        ? "    # test: JEST_JUNIT_OUTPUT_DIR=test-results npx jest --ci --reporters=default --reporters=jest-junit"
        : "    # test: npx ng test --watch=false",
      `    # testResults: ${inDir("test-results/junit.xml")}   # JUnit XML, so verify can count tests`,
      `    # methods: [${DEFAULT_FRONTEND_METHODS.join(", ")}]   # flag evaluation methods (defaults shown)`,
    );
  } else {
    const solution = /\.slnx?$/.test(p.marker) ? ` ${path.posix.basename(p.marker)}` : "";
    lines.push(
      `    # build: dotnet build${solution} --no-incremental`,
      `    # test: dotnet test${solution} --logger trx`,
      `    # testResults: ${inDir("**/TestResults/*.trx")}`,
      `    # methods: [${DEFAULT_BACKEND_METHODS.join(", ")}]`,
      `    # attributes: [${DEFAULT_BACKEND_ATTRIBUTES.join(", ")}]`,
    );
  }
  return lines;
}

export function configTemplate(projects: DetectedProject[]): string {
  const listed = projects.length ? projects : EXAMPLE_PROJECTS;
  return [...CONFIG_HEADER, ...listed.flatMap(projectLines), ...CONFIG_FOOTER].join("\n");
}

/** Write `flagrm.config.yaml` for the projects found in `cwd` (an example when none are) unless a config file exists. */
export function writeConfigTemplate(cwd: string): StepResult {
  const existing = findDefaultConfigFile(cwd);
  if (existing) return { path: relativePath(cwd, existing), status: "skipped" };
  const file = path.join(cwd, "flagrm.config.yaml");
  const projects = detectProjects(cwd);
  fs.writeFileSync(file, configTemplate(projects), "utf8");
  const note = projects.length
    ? `detected ${projects.map((p) => `${p.adapter} (${p.marker})`).join(", ")}`
    : "no Angular or .NET project found: edit the example projects";
  return { path: relativePath(cwd, file), status: "created", note };
}

/** Copy each skill into each agent's skills directory and stamp it with the flagrm version. */
export function installSkills(
  cwd: string,
  mode: InstallMode,
  version = packageVersion(),
  source = path.join(packageRoot(), "skills"),
): StepResult[] {
  const results: StepResult[] = [];
  for (const dir of AGENT_SKILL_DIRS) {
    for (const skill of SKILLS) {
      const target = path.join(cwd, dir, skill);
      const exists = fs.existsSync(target);
      if (mode === "init" && exists) {
        results.push({ path: relativePath(cwd, target), status: "skipped" });
        continue;
      }
      if (mode === "update" && !exists) continue;
      const before = exists ? snapshot(target) : undefined;
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(path.join(source, skill), target, { recursive: true });
      stampSkill(path.join(target, "SKILL.md"), version);
      const status = !exists ? "created" : before === snapshot(target) ? "unchanged" : "updated";
      results.push({ path: relativePath(cwd, target), status });
    }
  }
  return results;
}

/** Every file under `dir` with its content, for telling an update from a no-op. */
function snapshot(dir: string): string {
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => fs.statSync(path.join(dir, f)).isFile())
    .sort()
    .map((f) => `${f}\0${fs.readFileSync(path.join(dir, f), "utf8")}`)
    .join("\0");
}

/** Record the flagrm version in a SKILL.md's frontmatter (`metadata.flagrm-version`), replacing an earlier stamp. */
export function stampSkill(file: string, version: string): void {
  const text = fs.readFileSync(file, "utf8");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lf = text.replace(/\r\n/g, "\n").replace(/\nmetadata:\n {2}flagrm-version: .*(?=\n)/, "");
  const end = lf.indexOf("\n---", 3);
  if (!lf.startsWith("---\n") || end === -1) throw new Error(`${file} has no frontmatter.`);
  const stamped = `${lf.slice(0, end)}\nmetadata:\n  flagrm-version: "${version}"${lf.slice(end)}`;
  fs.writeFileSync(file, stamped.replace(/\n/g, eol), "utf8");
}

/** The flagrm version an installed skill was stamped with, or undefined when it isn't installed. */
export function installedSkillVersion(skillDir: string): string | undefined {
  try {
    const text = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
    return /^ {2}flagrm-version: "?([^"\r\n]+)"?/m.exec(text)?.[1];
  } catch {
    return undefined;
  }
}

/** The marked flagrm block in AGENTS.md, which Codex reads. */
export function installAgentsBlock(cwd: string, mode: InstallMode): StepResult {
  const file = path.join(cwd, "AGENTS.md");
  const exists = fs.existsSync(file);
  const text = exists ? fs.readFileSync(file, "utf8") : "";
  const start = text.indexOf(AGENTS_START);
  const end = text.indexOf(AGENTS_END);
  if (start !== -1 && end > start) {
    if (mode === "init") return { path: "AGENTS.md", status: "skipped" };
    const next = text.slice(0, start) + AGENTS_BLOCK + text.slice(end + AGENTS_END.length);
    if (next === text) return { path: "AGENTS.md", status: "unchanged" };
    fs.writeFileSync(file, next, "utf8");
    return { path: "AGENTS.md", status: "updated" };
  }
  if (mode === "update") return { path: "AGENTS.md", status: "skipped" };
  if (!exists) {
    fs.writeFileSync(file, `${AGENTS_BLOCK}\n`, "utf8");
    return { path: "AGENTS.md", status: "created" };
  }
  fs.writeFileSync(file, `${text}${text.endsWith("\n") ? "\n" : "\n\n"}${AGENTS_BLOCK}\n`, "utf8");
  return { path: "AGENTS.md", status: "updated" };
}

interface HookGroup {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string }>;
}

type Settings = { hooks?: Record<string, HookGroup[]> } & Record<string, unknown>;

function ourStopHooks(settings: Settings): Array<{ type?: string; command?: string }> {
  return (settings.hooks?.Stop ?? []).flatMap((g) => g.hooks ?? []).filter((h) => OUR_HOOK.test(h.command ?? ""));
}

/** Whether `.claude/settings.json` has flagrm's Stop hook, and whether it runs this version's command. */
export function stopHookState(cwd: string): "missing" | "outdated" | "current" {
  let settings: Settings;
  try {
    settings = JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8"));
  } catch {
    return "missing";
  }
  const ours = ourStopHooks(settings);
  if (ours.length === 0) return "missing";
  return ours.every((h) => h.command === HOOK_COMMAND) ? "current" : "outdated";
}

/** The Claude Code Stop hook in `.claude/settings.json`, merged with whatever else is there. */
export function installStopHook(cwd: string, mode: InstallMode): StepResult {
  const file = path.join(cwd, ".claude", "settings.json");
  const step = relativePath(cwd, file);
  const exists = fs.existsSync(file);
  let settings: Settings = {};
  if (exists) {
    try {
      settings = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return {
        path: step,
        status: "skipped",
        note: `not valid JSON; add a Stop hook running \`${HOOK_COMMAND}\` by hand`,
      };
    }
  }
  const stop = settings.hooks?.Stop ?? [];
  const ours = ourStopHooks(settings);
  if (mode === "update") {
    if (ours.length === 0) return { path: step, status: "skipped" };
    if (ours.every((h) => h.command === HOOK_COMMAND)) return { path: step, status: "unchanged" };
    for (const h of ours) h.command = HOOK_COMMAND;
  } else {
    if (ours.length) return { path: step, status: "skipped" };
    settings.hooks = { ...settings.hooks, Stop: [...stop, { hooks: [{ type: "command", command: HOOK_COMMAND }] }] };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return { path: step, status: exists ? "updated" : "created" };
}

/** Add `.flagrm/` to `.gitignore` unless it's already listed. */
export function ensureGitignore(cwd: string): StepResult {
  const file = path.join(cwd, ".gitignore");
  const exists = fs.existsSync(file);
  const text = exists ? fs.readFileSync(file, "utf8") : "";
  if (/^\/?\.flagrm\/?\s*$/m.test(text)) return { path: ".gitignore", status: "skipped" };
  fs.writeFileSync(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}.flagrm/\n`, "utf8");
  return { path: ".gitignore", status: exists ? "updated" : "created" };
}

/**
 * Where `init` and `update` install: next to the nearest config up to the git
 * repository root, which every other command also uses; without one, at the
 * repository root, where Claude Code loads the Stop hook from (or `cwd`
 * outside a repository). Installing in a subdirectory would add a second
 * config that shadows it there.
 */
export function installRoot(cwd: string): string {
  return findConfigRoot(cwd) ?? repositoryRoot(cwd) ?? cwd;
}

/** `flagrm init`: everything the agent needs in `root` (see {@link installRoot}), added where missing. */
export function initProject(root: string): StepResult[] {
  return [
    writeConfigTemplate(root),
    ...installSkills(root, "init"),
    installAgentsBlock(root, "init"),
    installStopHook(root, "init"),
    ensureGitignore(root),
  ];
}

/** `flagrm update`: refresh what `init` installed in `root` from this flagrm version; adds nothing new. */
export function updateProject(root: string): StepResult[] {
  return [...installSkills(root, "update"), installAgentsBlock(root, "update"), installStopHook(root, "update")];
}
