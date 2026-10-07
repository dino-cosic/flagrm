/**
 * What is not part of a flag removal: flagrm's own setup files (`init`,
 * `update` and `scope --write` write them, often while a removal starts) and
 * the config's `exclude` globs (generated output such as `graphify-out/`).
 * verify's changed files, `baseline --force`, the Stop hook and the tree
 * fingerprint all use this one filter, so verify and the hook agree.
 */

import picomatch from "picomatch";
import { CONFIG_FILENAMES, loadConfig, type ToolConfig } from "./config.js";
import { AGENT_SKILL_DIRS, SKILLS } from "./install.js";
import { relativePath } from "./util.js";

/** True for a path (relative to the config root, `/`-separated) that is not part of a removal. */
export type ChangeFilter = (rel: string) => boolean;

/** The files `flagrm init`, `update` and `scope --write` write, relative to the config root. */
export const SETUP_PATTERNS: readonly string[] = [
  ...CONFIG_FILENAMES,
  ".gitignore",
  ".claude/settings.json",
  ...AGENT_SKILL_DIRS.flatMap((dir) => SKILLS.map((skill) => `${dir}/${skill}/**`)),
  ".github/prompts/flagrm-*.prompt.md",
  "AGENTS.md",
  "**/flagrm.slnf",
];

const isSetup = picomatch([...SETUP_PATTERNS], { dot: true });

/**
 * The filter for a config: setup files, and paths matching an `exclude` glob
 * relative to the config root or to the path of the project they are in
 * (`exclude` is also read per project when scanning). Without a config, only
 * setup files.
 */
export function changeFilter(config?: Pick<ToolConfig, "root" | "exclude" | "projects">): ChangeFilter {
  const exclude = config?.exclude.length ? excludeMatcher(config.exclude) : undefined;
  const projectDirs = config
    ? config.projects.map((p) => relativePath(config.root, p.path)).filter((dir) => dir && !dir.startsWith(".."))
    : [];
  return (rel) => {
    if (isSetup(rel)) return true;
    if (!exclude) return false;
    if (exclude(rel)) return true;
    return projectDirs.some((dir) => rel.startsWith(`${dir}/`) && exclude(rel.slice(dir.length + 1)));
  };
}

/**
 * Matches `exclude` the way scanning's fast-glob `ignore` does: a pattern
 * that matches a directory (`graphify-out`, `graphify-out/`) excludes
 * everything under it, so test the path and each of its parent directories.
 */
function excludeMatcher(patterns: readonly string[]): (rel: string) => boolean {
  const isMatch = picomatch(
    patterns.map((p) => p.replace(/\/+$/, "")),
    { dot: true },
  );
  return (rel) => {
    for (let end = rel.length; end > 0; end = rel.lastIndexOf("/", end - 1)) {
      if (isMatch(rel.slice(0, end))) return true;
    }
    return false;
  };
}

/** {@link changeFilter} for the config at `root`; only setup files when it can't be loaded. Never throws. */
export function changeFilterAt(root: string): ChangeFilter {
  try {
    return changeFilter(loadConfig({ quiet: true }, root));
  } catch {
    return changeFilter();
  }
}
