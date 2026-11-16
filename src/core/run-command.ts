/**
 * Running a project's build, test and lint commands: each streams to its own
 * log, is killed with its whole process tree on timeout, and reports progress
 * on stderr.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ProjectContext, Workspace } from "./adapter.js";
import { projectCommands } from "./config-snapshot.js";
import { environmentProblem } from "./environment.js";
import { formatDuration, progress } from "./progress.js";
import type { CheckRun } from "./types.js";
import { parseTestLog } from "./verify/log-results.js";
import { type ClaimedResults, collectTestResults } from "./verify/test-results.js";

/**
 * Run one shell command inside a project, streaming its output to `logFile`
 * (no buffer limit, stdout and stderr interleaved as printed). A command that
 * can't start, is killed or outlives the project's `timeout` fails with the
 * reason at the end of the log. A test run also reads the `testResults`
 * files (absolute path or glob) written during it, or without any, what its
 * log says (`log-results.ts`).
 */
export async function runCheck(
  ctx: ProjectContext,
  check: CheckRun["check"],
  command: string,
  logFile: string,
  claimed?: ClaimedResults,
  testResults?: string,
): Promise<CheckRun> {
  const started = Date.now();
  progress.write(`${ctx.name} ${check}: \`${command}\` …`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, `$ ${command}\n`, "utf8");
  const fd = fs.openSync(logFile, "a");
  let exit: CommandExit;
  try {
    exit = await runCommand(command, ctx.root, fd, ctx.project.timeout);
  } finally {
    fs.closeSync(fd);
  }
  const reason = failureReason(exit, ctx.project.timeout);
  if (reason) fs.appendFileSync(logFile, `\nflagrm: error: ${reason}\n`, "utf8");
  const run: CheckRun = {
    project: ctx.name,
    check,
    command,
    exitCode: exit.status ?? 1,
    durationMs: Date.now() - started,
    log: logFile,
  };
  if (reason) run.interrupted = reason;
  progress.write(
    `${ctx.name} ${check}: ${reason ?? (run.exitCode === 0 ? "passed" : `failed (exit ${run.exitCode})`)} ` +
      `in ${formatDuration(run.durationMs)}`,
  );
  if (run.exitCode !== 0) {
    const problem = environmentProblem(fs.readFileSync(logFile, "utf8"), ctx.root);
    if (problem) run.failure = { kind: "environment", message: problem };
  }
  let results = check === "test" && testResults ? collectTestResults(testResults, started, claimed) : undefined;
  // No result files: the runner's log still names failing tests and prints counts.
  if (check === "test" && !results) results = parseTestLog(fs.readFileSync(logFile, "utf8"));
  if (results) run.results = results;
  return run;
}

interface CommandExit {
  status: number | null;
  signal: NodeJS.Signals | null;
  timedOut?: boolean;
  error?: Error;
}

const isWindows = process.platform === "win32";

/**
 * Run `command` in a shell with its output on `fd`. On timeout the whole
 * process tree is killed: killing only the shell (`sh`, `cmd.exe`) would leave
 * the real command (`dotnet test`, a watch-mode test runner) running. On POSIX
 * the shell leads its own process group so the group can be killed at once;
 * that group no longer gets the terminal's Ctrl-C, so SIGINT and SIGTERM sent
 * to flagrm are passed on to it.
 */
function runCommand(command: string, cwd: string, fd: number, timeout: number | undefined): Promise<CommandExit> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
      detached: !isWindows,
    });
    let timedOut = false;
    const timer = timeout
      ? setTimeout(() => {
          timedOut = true;
          killTree(child.pid, () => child.kill("SIGKILL"));
        }, timeout * 1000)
      : undefined;
    const forward = (signal: NodeJS.Signals) => {
      killTree(child.pid, () => child.kill(signal), signal);
      stopForwarding();
      // Without a listener left, re-raising gives flagrm the signal's default behavior.
      process.kill(process.pid, signal);
    };
    const stopForwarding = () => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
    };
    if (!isWindows) {
      process.once("SIGINT", forward);
      process.once("SIGTERM", forward);
    }
    child.on("error", (error) => {
      clearTimeout(timer);
      stopForwarding();
      resolve({ status: null, signal: null, error });
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      stopForwarding();
      resolve({ status, signal, timedOut });
    });
  });
}

function killTree(pid: number | undefined, fallback: () => void, signal: NodeJS.Signals = "SIGKILL"): void {
  if (pid !== undefined) {
    if (isWindows) {
      const r = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      if (r.status === 0) return;
    } else {
      try {
        // A negative pid signals the whole process group the detached shell leads.
        process.kill(-pid, signal);
        return;
      } catch {
        // The group is already gone, or was never created: fall back to the shell alone.
      }
    }
  }
  fallback();
}

/** Why a command ended without an exit code, or undefined when it exited normally. */
function failureReason(exit: CommandExit, timeout: number | undefined): string | undefined {
  if (exit.timedOut) return `timed out after ${timeout}s (timeout in flagrm.config.yaml)`;
  if (exit.error) return `could not run the command: ${exit.error.message}`;
  if (exit.status === null) return `killed by ${exit.signal ?? "a signal"}`;
  return undefined;
}
/**
 * Build, test, then lint every project, each command resolved on its own
 * (see `projectCommands`): the configured one, none for `false`, else the
 * adapter's default (`dotnet build --no-incremental`, `npx ng test`, ...;
 * lint has none).
 */
export async function runChecks(
  projects: Workspace,
  logDir: string,
  only: ReadonlyArray<CheckRun["check"]> = ["build", "test", "lint"],
): Promise<CheckRun[]> {
  const runs: CheckRun[] = [];
  // Projects whose `testResults` patterns overlap must not count each other's result files.
  const claimed: ClaimedResults = new Map();
  for (const { adapter, ctx } of projects) {
    const commands = projectCommands(adapter, ctx);
    for (const check of only) {
      const command = commands[check];
      if (!command) continue;
      const log = path.join(logDir, `${ctx.name}.${check}.log`);
      runs.push(await runCheck(ctx, check, command, log, claimed, commands.testResults));
    }
  }
  return runs;
}
