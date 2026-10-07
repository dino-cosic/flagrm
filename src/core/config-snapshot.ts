/**
 * The configuration a baseline was taken with, so `verify` can tell when it
 * changed since: a narrower test command or filter runs fewer tests, and the
 * comparison against the baseline no longer means what it did.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { Adapter, ProjectContext, Workspace } from "./adapter.js";
import type { CheckId, CommandSnapshot, ConfigSnapshot } from "./types.js";
import { relativePath } from "./util.js";

export type CommandKey = "build" | "test" | "testResults";

export interface ResolvedCommands {
  build?: string;
  test?: string;
  /** Absolute path or glob of the result files the test command writes. */
  testResults?: string;
  /** Keys that came from the adapter's defaults rather than the config. */
  defaults: CommandKey[];
}

/**
 * A project's build/test commands, each resolved on its own: the configured
 * one, none for `false`, else the adapter's default. `testResults` defaults
 * only along with the default test command, whose output location it names.
 */
export function projectCommands(adapter: Adapter, ctx: ProjectContext): ResolvedCommands {
  const fallback = adapter.defaultCommands?.(ctx) ?? {};
  const out: ResolvedCommands = { defaults: [] };
  for (const key of ["build", "test"] as const) {
    const configured = ctx.project[key];
    if (configured === false) continue;
    if (configured !== undefined) out[key] = configured;
    else if (fallback[key]) {
      out[key] = fallback[key];
      out.defaults.push(key);
    }
  }
  if (ctx.project.testResults) out.testResults = ctx.project.testResults;
  else if (out.defaults.includes("test") && fallback.testResults) {
    out.testResults = fallback.testResults;
    out.defaults.push("testResults");
  }
  return out;
}

/** Solution and project files: a removal may edit them, so they don't count as a command's configuration. */
const PROJECT_FILE = /\.(sln|slnx|\w*proj)$/i;

/** The resolved build/test commands of every project, the files they name, and the config file's text. */
export function configSnapshot(projects: Workspace): ConfigSnapshot {
  const configFile = projects[0]?.ctx.config.file;
  const root = projects[0]?.ctx.config.root ?? process.cwd();
  const snapshot: ConfigSnapshot = { projects: [] };
  if (configFile) {
    try {
      snapshot.file = { path: relativePath(root, configFile), text: fs.readFileSync(configFile, "utf8") };
    } catch {
      // Unreadable: nothing to compare later.
    }
  }
  for (const { adapter, ctx } of projects) {
    const commands = projectCommands(adapter, ctx);
    const command = (text: string): CommandSnapshot => ({ command: text, files: namedFiles(text, ctx.root, root) });
    const entry: ConfigSnapshot["projects"][number] = { name: ctx.name };
    if (commands.build) entry.build = command(commands.build);
    if (commands.test) entry.test = command(commands.test);
    if (commands.testResults) entry.testResults = relativePath(root, commands.testResults);
    snapshot.projects.push(entry);
  }
  return snapshot;
}

/**
 * Files a command names (`flagrm.slnf`, `--settings ci.runsettings`,
 * `--filter-file=filters.txt`), with a hash of their content. Words are
 * resolved against the directory the command runs in.
 */
function namedFiles(command: string, cwd: string, root: string): CommandSnapshot["files"] {
  const words = command
    .split(/\s+/)
    .flatMap((word) => [word, word.slice(word.indexOf("=") + 1), word.slice(word.indexOf(":") + 1)])
    .map((word) => word.replace(/^["']|["']$/g, ""))
    .filter((word) => word && !word.startsWith("-") && !PROJECT_FILE.test(word));
  const files = new Map<string, string>();
  for (const word of new Set(words)) {
    const file = path.resolve(cwd, word);
    try {
      if (!fs.statSync(file).isFile()) continue;
      files.set(relativePath(root, file), createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
    } catch {
      // Not a file.
    }
  }
  return [...files].sort(([a], [b]) => a.localeCompare(b)).map(([p, sha256]) => ({ path: p, sha256 }));
}

/** A difference between the baseline's configuration and the current one, reported by the check it affects. */
export interface ConfigChange {
  check: Extract<CheckId, "build" | "tests" | "leftovers">;
  project?: string;
  message: string;
  /** For a change to the config file outside the commands: its changed lines (`- old`, `+ new`). */
  details?: string[];
}

/** What changed between the configuration at the baseline and now. None when the baseline predates snapshots. */
export function configChanges(before: ConfigSnapshot | undefined, now: ConfigSnapshot): ConfigChange[] {
  if (!before) return [];
  const changes: ConfigChange[] = [];
  const names = [...new Set([...before.projects, ...now.projects].map((p) => p.name))];
  for (const name of names) {
    const was = before.projects.find((p) => p.name === name);
    const is = now.projects.find((p) => p.name === name);
    for (const [kind, check] of [
      ["build", "build"],
      ["test", "tests"],
    ] as const) {
      const a = was?.[kind];
      const b = is?.[kind];
      if (a?.command !== b?.command) {
        changes.push({
          check,
          project: name,
          message: `${kind} command changed since the baseline: ${quote(a?.command)} → ${quote(b?.command)}`,
        });
      }
      const changed = changedFiles(a?.files ?? [], b?.files ?? []);
      if (changed.length) {
        changes.push({
          check,
          project: name,
          message: `${changed.join(", ")}, named by the ${kind} command, changed since the baseline`,
        });
      }
    }
    if (was?.testResults !== is?.testResults) {
      changes.push({
        check: "tests",
        project: name,
        message: `testResults changed since the baseline: ${quote(was?.testResults)} → ${quote(is?.testResults)}`,
      });
    }
  }
  if (before.file && now.file && withoutCommands(before.file.text) !== withoutCommands(now.file.text)) {
    changes.push({
      check: "leftovers",
      message: `${now.file.path} changed since the baseline, which changes what is scanned`,
      details: lineDiff(before.file.text, now.file.text),
    });
  }
  return changes;
}

const quote = (text: string | undefined) => (text === undefined ? "(none)" : `\`${text}\``);

function changedFiles(a: CommandSnapshot["files"], b: CommandSnapshot["files"]): string[] {
  const hashes = new Map(a.map((f) => [f.path, f.sha256]));
  const out = new Set<string>();
  for (const f of b) if (hashes.get(f.path) !== f.sha256) out.add(f.path);
  for (const f of a) if (!b.some((g) => g.path === f.path)) out.add(f.path);
  return [...out].sort();
}

/** The config without what the command comparison already covers, normalized for comparison. */
function withoutCommands(text: string): string {
  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch {
    return text;
  }
  const strip = (project: unknown) => {
    if (!project || typeof project !== "object") return project;
    const { build: _b, test: _t, testResults: _r, timeout: _o, ...rest } = project as Record<string, unknown>;
    return rest;
  };
  if (parsed && typeof parsed === "object") {
    const config = { ...(parsed as Record<string, unknown>) };
    // Only says which agents `init` sets up; never changes what is scanned.
    delete config.tools;
    if (Array.isArray(config.projects)) config.projects = config.projects.map(strip);
    for (const legacy of ["frontend", "backend"]) {
      if (config[legacy] && typeof config[legacy] === "object") config[legacy] = strip(config[legacy]);
    }
    return JSON.stringify(config);
  }
  return JSON.stringify(parsed);
}

/** Lines removed (`- `) and added (`+ `) from `a` to `b`, by longest common subsequence; at most 20. */
export function lineDiff(a: string, b: string, max = 20): string[] {
  const x = a.split(/\r?\n/);
  const y = b.split(/\r?\n/);
  const lcs = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      i++;
      j++;
    } else if (i < x.length && (j === y.length || lcs[i + 1][j] >= lcs[i][j + 1])) {
      out.push(`- ${x[i++]}`);
    } else {
      out.push(`+ ${y[j++]}`);
    }
  }
  return out.length > max ? [...out.slice(0, max), `… ${out.length - max} more changed lines`] : out;
}
