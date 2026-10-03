/**
 * What `flagrm init` and `flagrm update` write into a repository: the config
 * template and the `.flagrm/` gitignore entry, then per AI coding tool its
 * files: for Claude Code the skills and the Stop hook, for GitHub Copilot the
 * skills and `/flagrm-*` prompt files, for Codex the skills and the AGENTS.md
 * pointer. Every step reports what it did; nothing the user wrote is
 * overwritten, and nothing is deleted.
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
  TOOL_IDS,
  type ToolId,
} from "./config.js";
import { type DetectedProject, detectProjects } from "./detect.js";
import { packageRoot, packageVersion } from "./package.js";
import { saveTools } from "./tools.js";
import { relativePath } from "./util.js";

export const SKILLS = ["flagrm-remove", "flagrm-verify"] as const;

/** Where each supported tool discovers repository skills. */
export const TOOL_SKILL_DIRS: Record<ToolId, string> = {
  "claude-code": ".claude/skills",
  copilot: ".github/skills",
  codex: ".agents/skills",
};

/** Every tool's skills directory: Claude Code, GitHub Copilot, Codex. */
export const AGENT_SKILL_DIRS = TOOL_IDS.map((t) => TOOL_SKILL_DIRS[t]);

/** GitHub Copilot prompt files: `/flagrm-remove` and `/flagrm-verify` in Copilot Chat, each pointing at its skill. */
export const PROMPT_FILES: Record<(typeof SKILLS)[number], string> = {
  "flagrm-remove": [
    "---",
    "description: Remove a feature flag with flagrm's guardrails (keep the ON path, verify until it passes)",
    "argument-hint: <flag>",
    "agent: agent",
    "---",
    "",
    "Follow `.github/skills/flagrm-remove/SKILL.md` to remove the feature flag named after this command.",
    "",
  ].join("\n"),
  "flagrm-verify": [
    "---",
    "description: Check a feature flag removal with flagrm and propose its commit message",
    "argument-hint: <flag>",
    "agent: agent",
    "---",
    "",
    "Follow `.github/skills/flagrm-verify/SKILL.md` for the feature flag named after this command.",
    "",
  ].join("\n"),
};

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

export function configTemplate(projects: DetectedProject[], tools?: readonly ToolId[]): string {
  const listed = projects.length ? projects : EXAMPLE_PROJECTS;
  const [comment1, comment2, projectsKey] = CONFIG_HEADER;
  const toolLines = tools
    ? ["# The AI coding tools `flagrm init` and `flagrm update` set up.", `tools: [${tools.join(", ")}]`]
    : [];
  return [comment1, comment2, ...toolLines, projectsKey, ...listed.flatMap(projectLines), ...CONFIG_FOOTER].join("\n");
}

/** Write `flagrm.config.yaml` for the projects found in `cwd` (an example when none are) unless a config file exists. */
export function writeConfigTemplate(cwd: string, tools?: readonly ToolId[]): StepResult {
  const existing = findDefaultConfigFile(cwd);
  if (existing) return { path: relativePath(cwd, existing), status: "skipped" };
  const file = path.join(cwd, "flagrm.config.yaml");
  const projects = detectProjects(cwd);
  fs.writeFileSync(file, configTemplate(projects, tools), "utf8");
  const note = projects.length
    ? `detected ${projects.map((p) => `${p.adapter} (${p.marker})`).join(", ")}`
    : "no Angular or .NET project found: edit the example projects";
  return { path: relativePath(cwd, file), status: "created", note };
}

/** Copy each skill into each tool's skills directory and stamp it with the flagrm version. */
export function installSkills(
  cwd: string,
  mode: InstallMode,
  version = packageVersion(),
  source = path.join(packageRoot(), "skills"),
  tools: readonly ToolId[] = TOOL_IDS,
): StepResult[] {
  const results: StepResult[] = [];
  for (const dir of tools.map((t) => TOOL_SKILL_DIRS[t])) {
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

/** GitHub Copilot's `/flagrm-remove` and `/flagrm-verify` prompt files in `.github/prompts/`. */
export function installPrompts(cwd: string, mode: InstallMode): StepResult[] {
  const results: StepResult[] = [];
  for (const skill of SKILLS) {
    const file = path.join(cwd, ".github", "prompts", `${skill}.prompt.md`);
    const step = relativePath(cwd, file);
    const exists = fs.existsSync(file);
    if (mode === "init" && exists) {
      results.push({ path: step, status: "skipped" });
      continue;
    }
    if (mode === "update" && !exists) continue;
    const before = exists ? fs.readFileSync(file, "utf8") : undefined;
    if (before === PROMPT_FILES[skill]) {
      results.push({ path: step, status: "unchanged" });
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, PROMPT_FILES[skill], "utf8");
    results.push({ path: step, status: exists ? "updated" : "created" });
  }
  return results;
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

/** The files `init` installs for one tool. */
function toolSteps(root: string, tool: ToolId, mode: InstallMode): StepResult[] {
  const skills = installSkills(root, mode, undefined, undefined, [tool]);
  if (tool === "claude-code") return [...skills, installStopHook(root, mode)];
  if (tool === "copilot") return [...skills, ...installPrompts(root, mode)];
  return [...skills, installAgentsBlock(root, mode)];
}

/**
 * flagrm's files for tools `tools` leaves out, when they are installed: never
 * deleted, no longer updated, and named so the user can delete them.
 */
function deselectedSteps(root: string, tools: readonly ToolId[]): StepResult[] {
  const files: Record<ToolId, string[]> = {
    "claude-code": [
      ...SKILLS.map((s) => `${TOOL_SKILL_DIRS["claude-code"]}/${s}`),
      stopHookState(root) === "missing" ? "" : ".claude/settings.json",
    ],
    copilot: [
      ...SKILLS.map((s) => `${TOOL_SKILL_DIRS.copilot}/${s}`),
      ...SKILLS.map((s) => `.github/prompts/${s}.prompt.md`),
    ],
    codex: [...SKILLS.map((s) => `${TOOL_SKILL_DIRS.codex}/${s}`), hasAgentsBlock(root) ? "AGENTS.md" : ""],
  };
  return TOOL_IDS.filter((t) => !tools.includes(t)).flatMap((tool) =>
    files[tool]
      .filter((rel) => rel && fs.existsSync(path.join(root, rel)))
      .map(
        (rel): StepResult => ({
          path: rel,
          status: "skipped",
          note: `${tool} isn't in tools: no longer updated${rel.endsWith(".json") || rel === "AGENTS.md" ? " (flagrm's entry)" : ""}; delete it if you don't use it`,
        }),
      ),
  );
}

function hasAgentsBlock(root: string): boolean {
  try {
    return fs.readFileSync(path.join(root, "AGENTS.md"), "utf8").includes(AGENTS_START);
  } catch {
    return false;
  }
}

/**
 * `flagrm init`: everything the agent needs in `root` (see {@link installRoot})
 * for `tools`, added where missing, and the choice saved as the config's `tools:`.
 */
export function initProject(root: string, tools: readonly ToolId[] = TOOL_IDS): StepResult[] {
  const config = writeConfigTemplate(root, tools);
  const saved = config.status === "skipped" ? saveTools(root, [...tools]) : undefined;
  return [
    config,
    ...(saved && saved.status !== "unchanged" ? [saved] : []),
    ...tools.flatMap((t) => toolSteps(root, t, "init")),
    ensureGitignore(root),
    ...deselectedSteps(root, tools),
  ];
}

/** `flagrm update`: refresh what `init` installed in `root` for `tools` from this flagrm version; adds nothing new. */
export function updateProject(root: string, tools: readonly ToolId[] = TOOL_IDS): StepResult[] {
  return [...tools.flatMap((t) => toolSteps(root, t, "update")), ...deselectedSteps(root, tools)];
}
