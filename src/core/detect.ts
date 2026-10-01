/**
 * Which projects a repository has, for `flagrm init` to seed flagrm.config.yaml:
 * Angular workspaces (`angular.json`) and .NET solutions (`.sln`, `.slnx`),
 * or `.csproj` files when there is no solution. Shallow on purpose: it only
 * saves the user from editing a template, and they check the result.
 */

import path from "node:path";
import fg from "fast-glob";

export interface DetectedProject {
  name: string;
  adapter: "angular" | "dotnet";
  /** Project directory relative to the repository, `.` for the root. */
  path: string;
  /** The file that marked the project, relative to the repository. */
  marker: string;
  /** Whether the project has a Jest config (Angular workspaces often test with Jest instead of Karma). */
  jest?: boolean;
}

const IGNORE = ["**/node_modules/**", "**/.git/**", "**/bin/**", "**/obj/**", "**/dist/**"];

const depth = (file: string) => file.split("/").length;

/** Markers whose directory isn't inside another marker's directory, one per directory. */
function topmost(markers: string[]): string[] {
  const kept: string[] = [];
  for (const marker of [...markers].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))) {
    const dir = path.posix.dirname(marker);
    const covered = kept.some((k) => {
      const parent = path.posix.dirname(k);
      return parent === "." || dir === parent || dir.startsWith(`${parent}/`);
    });
    if (!covered) kept.push(marker);
  }
  return kept;
}

/** The deepest directory containing every file. */
function commonDir(files: string[]): string {
  const parts = files.map((f) => path.posix.dirname(f).split("/"));
  const common: string[] = [];
  for (let i = 0; parts.every((p) => i < p.length && p[i] === parts[0][i]); i++) common.push(parts[0][i]);
  return common.join("/") || ".";
}

export function detectProjects(cwd: string): DetectedProject[] {
  const find = (pattern: string) => fg.sync(pattern, { cwd, deep: 4, ignore: IGNORE });
  const found: Array<Omit<DetectedProject, "name">> = [];

  for (const marker of topmost(find("**/angular.json"))) {
    const dir = path.posix.dirname(marker);
    const jest = fg.sync("jest.config.{js,ts,mjs,cjs}", { cwd: path.join(cwd, dir) }).length > 0;
    found.push({ adapter: "angular", path: dir, marker, jest });
  }

  const solutions = topmost(find("**/*.{sln,slnx}"));
  if (solutions.length) {
    for (const marker of solutions) found.push({ adapter: "dotnet", path: path.posix.dirname(marker), marker });
  } else {
    const projects = find("**/*.csproj").sort();
    if (projects.length) found.push({ adapter: "dotnet", path: commonDir(projects), marker: projects[0] });
  }

  const names = new Set<string>();
  return found.map((p) => {
    const base = projectName(path.basename(p.path === "." ? cwd : p.path)) || p.adapter;
    let name = names.has(base) ? `${base}-${p.adapter}` : base;
    for (let i = 2; names.has(name); i++) name = `${base}-${p.adapter}-${i}`;
    names.add(name);
    return { name, ...p };
  });
}

/** A directory name as a valid project name (see PROJECT_NAME in config.ts): `my app` → `my-app`, `_legacy` → `legacy`. */
function projectName(dir: string): string {
  return dir.replace(/[^\w.-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "");
}
