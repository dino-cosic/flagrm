/**
 * Tell a machine setup problem apart from broken code in a failed build or
 * test log: a missing .NET SDK, a tool a build step calls that isn't
 * installed, Docker not running for Testcontainers. Each becomes one line
 * that says what to fix.
 */

import fs from "node:fs";
import path from "node:path";
import { relativePath } from "./util.js";

/**
 * The setup problems a log shows, as one actionable line, or undefined when
 * it shows none. `root` is the project root: paths are reported relative to it.
 */
export function environmentProblem(log: string, root: string): string | undefined {
  const problems = [missingSdk(log, root), ...missingCommands(log, root), dockerUnavailable(log)].filter(Boolean);
  return problems.length ? problems.join("; ") : undefined;
}

/**
 * `dotnet` exits 155 with "A compatible .NET SDK was not found" when no
 * installed SDK satisfies global.json. It prints the requested version and the
 * global.json path; the installed SDKs (`10.0.101 [/usr/local/share/dotnet/sdk]`)
 * go to stdout, so in a combined log they may come after the message.
 */
function missingSdk(log: string, root: string): string | undefined {
  if (!/A compatible \.NET SDK was not found/.test(log)) return undefined;
  const requested = /^Requested SDK version:\s*(\S+)/m.exec(log)?.[1];
  const globalJson = /^global\.json file:\s*(.+?)\s*$/m.exec(log)?.[1];
  const installed = [...new Set([...log.matchAll(/^(\d+\.\d+\.\d+\S*) \[[^\]]*sdk\]\s*$/gm)].map((m) => m[1]))];
  const rollForward = globalJson ? readRollForward(globalJson) : undefined;
  const wanted = [requested ?? "the version", rollForward && `rollForward: ${rollForward}`].filter(Boolean).join(", ");
  const where = globalJson ? relativePath(root, globalJson) : "global.json";
  return (
    `.NET SDK not found: ${where} requests ${wanted}; installed: ${installed.join(", ") || "none"}. ` +
    `Install that SDK or change ${where}`
  );
}

function readRollForward(file: string): string | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"))?.sdk?.rollForward;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Commands the shell couldn't find (exit 127; `9009` and "is not recognized"
 * on Windows), with the MSBuild project whose `Exec` ran them when the log
 * names it (`RustSdk.csproj(12,5): error MSB3073: The command "cargo build" exited with code 127`).
 */
function missingCommands(log: string, root: string): string[] {
  const commands = new Map<string, Set<string>>();
  const add = (command: string, project?: string) => {
    const name = path.basename(command);
    const projects = commands.get(name) ?? new Set<string>();
    if (project) projects.add(relativePath(root, path.resolve(root, project.trim())));
    commands.set(name, projects);
  };
  for (const m of log.matchAll(/\b(?:ba|z|da)?sh: (?:line \d+: |\d+: )?([^\s:]+): (?:command )?not found/g)) add(m[1]);
  for (const m of log.matchAll(/\bcommand not found: (\S+)/g)) add(m[1]);
  for (const m of log.matchAll(/'([^']+)' is not recognized as an internal or external command/g)) add(m[1]);
  for (const m of log.matchAll(
    /^\s*(.+?\.\w*proj)\(\d+,\d+\): error MSB3073: The command "([^\s"]+)[^"]*" exited with code (?:127|9009)\b/gm,
  )) {
    add(m[2].replace(/^["']|["']$/g, ""), m[1]);
  }
  return [...commands].map(([command, projects]) => {
    const neededBy = projects.size ? ` (needed by ${[...projects].sort().join(", ")})` : "";
    return `\`${command}\` is not installed or not on PATH${neededBy}`;
  });
}

/** Testcontainers throws `DockerUnavailableException`; the docker CLI says it can't reach the daemon. */
function dockerUnavailable(log: string): string | undefined {
  const docker =
    /DockerUnavailableException|Docker is either not running or misconfigured|Cannot connect to the Docker daemon/i;
  if (!docker.test(log)) return undefined;
  return "Docker is not running (Testcontainers tests need it): start Docker or leave those tests out of `test`";
}
