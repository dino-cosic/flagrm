/**
 * Whether this machine can build and test a .NET solution: an installed SDK
 * that satisfies global.json, `cargo` for projects whose build runs it, Docker
 * for test projects that use Testcontainers. And which projects a solution
 * filter has to leave out when one of the last two is missing.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** What the machine has; injectable so the checks can be tested anywhere. */
export interface SetupProbes {
  /** `dotnet --list-sdks` versions, or undefined when `dotnet` isn't installed. */
  installedSdks(): string[] | undefined;
  onPath(exe: string): boolean;
  dockerRunning(): boolean;
}

// --- SDK -------------------------------------------------------------------------

/** global.json's SDK request, from the nearest global.json at or above `dir` (where `dotnet` looks). */
export function sdkRequest(dir: string): { file: string; version: string; rollForward: string } | undefined {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const file = path.join(d, "global.json");
    if (fs.existsSync(file)) {
      try {
        const sdk = JSON.parse(fs.readFileSync(file, "utf8"))?.sdk;
        if (typeof sdk?.version !== "string") return undefined;
        const rollForward = typeof sdk.rollForward === "string" ? sdk.rollForward : "latestPatch";
        return { file, version: sdk.version, rollForward };
      } catch {
        return undefined;
      }
    }
    if (path.dirname(d) === d) return undefined;
  }
}

/** `8.0.403` → [8, 0, 4, 3]: major, minor, feature band, patch. Undefined for anything else. */
function sdkParts(version: string): number[] | undefined {
  const m = /^(\d+)\.(\d+)\.(\d)(\d\d)(?:-|$)/.exec(version);
  return m ? m.slice(1).map(Number) : undefined;
}

/**
 * Whether an installed SDK satisfies the request under its rollForward policy:
 * how many leading version parts must match the requested ones (`patch`: the
 * feature band, `feature`: the minor, `minor`: the major, `major`: none), and
 * the version must be at least the requested one. `disable` needs it exactly.
 * The `latest*` policies accept the same SDKs as their plain forms; they only
 * prefer a newer one.
 */
export function satisfiesSdk(installed: string, requested: string, rollForward: string): boolean {
  const have = sdkParts(installed);
  const want = sdkParts(requested);
  if (!have || !want) return installed === requested;
  const policy = rollForward.replace(/^latest/, "").toLowerCase();
  if (policy === "disable") return installed === requested;
  const fixed = { patch: 3, feature: 2, minor: 1, major: 0 }[policy] ?? 3;
  for (let i = 0; i < fixed; i++) if (have[i] !== want[i]) return false;
  for (let i = 0; i < 4; i++) if (have[i] !== want[i]) return have[i] > want[i];
  return true;
}

/** Why `dir` can't build with the installed SDKs, or undefined when it can (or no global.json pins one). */
export function sdkProblem(dir: string, probes: SetupProbes, root: string): string | undefined {
  const request = sdkRequest(dir);
  if (!request) return undefined;
  const installed = probes.installedSdks();
  const where = path.relative(root, request.file) || "global.json";
  if (!installed) return `\`dotnet\` is not installed; ${where} requests SDK ${request.version}`;
  if (installed.some((v) => satisfiesSdk(v, request.version, request.rollForward))) return undefined;
  return (
    `${where} requests .NET SDK ${request.version} (rollForward: ${request.rollForward}); ` +
    `installed: ${installed.join(", ") || "none"}. Install a matching SDK or change ${where}`
  );
}

// --- solutions and projects ------------------------------------------------------

/** A solution's project entries, as written in it (`src\\Api\\Api.csproj`), with their absolute paths. */
export interface SolutionProject {
  entry: string;
  file: string;
}

/** The projects of a `.sln` (`Project(...) = "Name", "path", ...`) or `.slnx` (`<Project Path="..."/>`). */
export function solutionProjects(solution: string): SolutionProject[] {
  const text = fs.readFileSync(solution, "utf8");
  const entries = solution.endsWith(".slnx")
    ? [...text.matchAll(/<Project\b[^>]*\bPath\s*=\s*"([^"]+)"/g)].map((m) => m[1])
    : [...text.matchAll(/^Project\("[^"]*"\)\s*=\s*"[^"]*",\s*"([^"]+)"/gm)].map((m) => m[1]);
  const dir = path.dirname(solution);
  return entries
    .filter((entry) => /\.\w*proj$/i.test(entry))
    .map((entry) => ({ entry, file: path.resolve(dir, entry.replace(/\\/g, "/")) }));
}

interface ProjectInfo {
  references: string[];
  cargo: boolean;
  testcontainers: boolean;
}

function projectInfo(file: string): ProjectInfo {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    // A project the solution lists but that's missing: nothing to learn from it.
  }
  const dir = path.dirname(file);
  return {
    references: [...text.matchAll(/<ProjectReference\b[^>]*\bInclude\s*=\s*"([^"]+)"/g)].map((m) =>
      path.resolve(dir, m[1].replace(/\\/g, "/")),
    ),
    cargo: /<Exec\b[^>]*\bCommand\s*=\s*"[^"]*\bcargo\b/i.test(text),
    testcontainers: /<PackageReference\b[^>]*\bInclude\s*=\s*"Testcontainers\b/i.test(text),
  };
}

/** A solution project a filter leaves out, and why. */
export interface LeftOut {
  entry: string;
  reason: string;
}

/** What a solution needs that the machine lacks, and which of its projects that rules out. */
export interface SolutionSetup {
  solution: string;
  problems: string[];
  /** Empty when nothing has to be left out. */
  leaveOut: LeftOut[];
  projects: SolutionProject[];
}

/**
 * Check a solution's projects against the machine: a project whose build
 * runs `cargo` needs it on PATH, one using Testcontainers needs Docker. Each
 * such project is left out, and so is every project that references one,
 * directly or not (it can't build, or can't run, without it). With `only`
 * (the project files a solution filter keeps), the other projects aren't built
 * and so aren't checked or kept.
 */
export function solutionSetup(
  solution: string,
  probes: SetupProbes,
  root: string,
  only?: readonly string[],
): SolutionSetup {
  const kept = only && new Set(only);
  const projects = solutionProjects(solution).filter((p) => !kept || kept.has(p.file));
  const info = new Map(projects.map((p) => [p.file, projectInfo(p.file)]));
  const rel = (file: string) => path.relative(root, file).split(path.sep).join("/");
  const problems: string[] = [];
  const reasons = new Map<string, string>();

  const cargo = projects.filter((p) => info.get(p.file)?.cargo);
  if (cargo.length && !probes.onPath("cargo")) {
    problems.push(
      `\`cargo\` is not installed, and ${cargo.map((p) => rel(p.file)).join(", ")} ${cargo.length === 1 ? "runs" : "run"} it to build`,
    );
    for (const p of cargo) reasons.set(p.file, "runs `cargo`, which is not installed");
  }
  const docker = projects.filter((p) => info.get(p.file)?.testcontainers);
  if (docker.length && !probes.dockerRunning()) {
    problems.push(
      `Docker is not running, and ${docker.map((p) => rel(p.file)).join(", ")} ${docker.length === 1 ? "uses" : "use"} Testcontainers`,
    );
    for (const p of docker) reasons.set(p.file, "uses Testcontainers, and Docker is not running");
  }

  // Everything that references a left-out project, transitively.
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of projects) {
      if (reasons.has(p.file)) continue;
      const blocked = info.get(p.file)?.references.find((r) => reasons.has(r));
      if (blocked) {
        reasons.set(p.file, `references ${path.basename(blocked)}`);
        changed = true;
      }
    }
  }
  const leaveOut = projects
    .filter((p) => reasons.has(p.file))
    .map((p) => ({ entry: p.entry, reason: reasons.get(p.file) ?? "" }));
  return { solution, problems, leaveOut, projects };
}

// --- probes ----------------------------------------------------------------------

export function realProbes(onPath: (exe: string) => boolean): SetupProbes {
  return {
    installedSdks() {
      // From a temp directory, so no global.json gets in the way of listing.
      const r = spawnSync("dotnet", ["--list-sdks"], { cwd: os.tmpdir(), encoding: "utf8", timeout: 30_000 });
      if (r.error || r.status !== 0) return undefined;
      return [...r.stdout.matchAll(/^(\S+)\s+\[/gm)].map((m) => m[1]);
    },
    onPath,
    dockerRunning() {
      const r = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 20_000 });
      return !r.error && r.status === 0;
    },
  };
}
