#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import type { Workspace } from "./core/adapter.js";
import {
  addNames,
  assertNoEditsSinceBaseline,
  baselinePath,
  discoverFlag,
  flagDir,
  mergeNames,
  runChecks,
  validateAgentNames,
  writeBaseline,
} from "./core/baseline.js";
import { type CliPathOptions, loadConfig } from "./core/config.js";
import { runDoctor } from "./core/doctor.js";
import { gitState } from "./core/git.js";
import { hookRoot, parseHookInput, stopDecision } from "./core/hook.js";
import { initProject, installRoot, updateProject } from "./core/install.js";
import { buildInventory } from "./core/inventory.js";
import { verifyMarkdown } from "./core/markdown.js";
import { packageVersion } from "./core/package.js";
import { resolveProjects } from "./core/registry.js";
import { printBaseline, printDoctor, printInventory, printSteps, printVerifyReport } from "./core/report.js";
import { CHECK_IDS, type RecordedName } from "./core/types.js";
import { relativePath } from "./core/util.js";
import { parseSkip, verifyFlag } from "./core/verify/index.js";

interface CommonOptions extends CliPathOptions {
  json?: boolean;
}

const program = new Command();

program
  .name("flagrm")
  .description(
    "Guardrails for removing feature flags with an AI coding agent: set up the skills and hook (init, update, " +
      "doctor), find flags (list), record the state before a removal (baseline) and gate the result (verify).",
  )
  .version(packageVersion());

/** Accumulate repeatable options (`--exclude a --exclude b`) into an array. */
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

function addGlobOptions(cmd: Command): Command {
  return cmd
    .option("--exclude <glob>", "additional glob to exclude from scanning (repeatable)", collect, [])
    .option("--include <glob>", "additional glob to include when scanning (repeatable)", collect, []);
}

function addCommonOptions(cmd: Command): Command {
  return addGlobOptions(
    cmd
      .option("--frontend <path>", "path to an Angular project (adds or replaces the project named 'frontend')")
      .option("--backend <path>", "path to a .NET project (adds or replaces the project named 'backend')")
      .option(
        "--config <path>",
        "path to a config file (default: the nearest flagrm.config.yaml up to the git repository root)",
      )
      .option("--json", "machine-readable JSON output"),
  );
}

/** Print a usage or config error and end the command with exit code 2. */
class CliError extends Error {}

function fail(err: unknown): never {
  throw new CliError(err instanceof Error ? err.message : String(err));
}

/** Load the config and pair every project with its adapter, exiting with code 2 on any config error. */
function loadWorkspace(opts: CliPathOptions): { root: string; projects: Workspace } {
  try {
    const config = loadConfig(opts);
    return { root: config.root, projects: resolveProjects(config) };
  } catch (err) {
    fail(err);
  }
}

// --- baseline ------------------------------------------------------------------

addCommonOptions(
  program
    .command("baseline <flag>")
    .description(
      "record the state before removing a flag: the git commit, each project's build and test results, and the " +
        "flag's names for the leftovers check; writes .flagrm/<flag>/baseline.json for verify. With --name on an " +
        "existing baseline, only adds names",
    ),
)
  .option("--no-checks", "record only the git state, without running build and test commands")
  .option("--name <name>", "add a name the flag is read through (repeatable)", collect, [])
  .option(
    "--kind <kind>",
    "how --name entries are matched: alias (qualified constant) or wrapper (identifier, calls included)",
    "alias",
  )
  .option("--file <path>", "check the --name entries only in this file (a local, parameter or field)")
  .option("--force", "start over: replace the baseline, only while the code is unedited since it")
  .action(
    async (
      flag: string,
      opts: CommonOptions & { checks: boolean; name: string[]; kind: string; file?: string; force?: boolean },
    ) => {
      const { root, projects } = loadWorkspace(opts);
      if (opts.kind !== "alias" && opts.kind !== "wrapper") {
        fail(new Error(`--kind must be alias or wrapper, not "${opts.kind}".`));
      }
      if (opts.file && opts.name.length === 0) fail(new Error("--file scopes --name entries; pass --name too."));
      const scope = opts.file && relativePath(root, path.resolve(opts.file));
      if (scope?.startsWith("..")) fail(new Error(`--file ${opts.file} is outside ${root}.`));
      const added: RecordedName[] = opts.name.map((name) => ({
        name,
        kind: opts.kind as RecordedName["kind"],
        source: "agent",
        ...(scope ? { file: scope } : {}),
      }));
      let result: ReturnType<typeof writeBaseline>;
      try {
        validateAgentNames(projects, added);
        const exists = fs.existsSync(baselinePath(root, flag));
        if (exists && opts.force) assertNoEditsSinceBaseline(root, flag);
        if (exists && !opts.force) {
          if (added.length === 0) {
            throw new Error(`Baseline for ${flag} already exists; pass --name to add names, or --force to start over.`);
          }
          result = addNames(root, flag, added);
        } else {
          const git = gitState(root);
          const checks = opts.checks ? await runChecks(projects, flagDir(root, flag)) : undefined;
          const { names, ...flow } = await discoverFlag(projects, flag);
          result = writeBaseline(root, flag, projects, git, checks, mergeNames(names, added), flow);
        }
      } catch (err) {
        fail(err);
      }
      if (opts.json) {
        console.log(JSON.stringify({ ...result.baseline, baselineFile: result.file }, null, 2));
      } else {
        printBaseline(result.baseline, result.file);
      }
    },
  );

// --- verify ------------------------------------------------------------------

addCommonOptions(
  program
    .command("verify <flag>")
    .description(
      "gate a flag removal against its baseline (`flagrm baseline <flag>`): build, tests and new unused code; " +
        "writes .flagrm/<flag>/verify.json; exit 0 pass, 1 fail, 2 usage error",
    ),
)
  .option("--skip <checks>", `comma-separated checks to skip (${CHECK_IDS.join(", ")})`)
  .option("--strict", "treat warnings as failures")
  .option("--md", "print a markdown overview (for the user or a PR) instead of text")
  .action(async (flag: string, opts: CommonOptions & { skip?: string; strict?: boolean; md?: boolean }) => {
    if (opts.md && opts.json) fail(new Error("--md and --json can't be combined."));
    const { root, projects } = loadWorkspace(opts);
    let result: Awaited<ReturnType<typeof verifyFlag>>;
    try {
      result = await verifyFlag(root, projects, flag, { skip: parseSkip(opts.skip), strict: opts.strict });
    } catch (err) {
      fail(err);
    }
    if (opts.json) {
      console.log(JSON.stringify({ ...result.report, verifyFile: result.file }, null, 2));
    } else if (opts.md) {
      process.stdout.write(verifyMarkdown(result.report, root));
    } else {
      printVerifyReport(result.report, result.file);
    }
    // exitCode, not exit(): exit() can cut off stdout still being flushed to a pipe.
    process.exitCode = result.report.status === "pass" ? 0 : 1;
  });

// --- list ----------------------------------------------------------------

addCommonOptions(
  program
    .command("list")
    .description(
      "inventory the workspace's feature flags: definitions (constants, enums, flags objects), " +
        "type and configured state per environment file (appsettings, environment.ts), " +
        "direct reference counts and the projects involved",
    ),
).action(async (opts: CommonOptions) => {
  const report = await buildInventory(loadWorkspace(opts).projects);
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printInventory(report);
  }
});

// --- hook --------------------------------------------------------------------

const hook = program.command("hook").description("entry points for agent hooks (installed by flagrm init)");

hook
  .command("stop")
  .description("Claude Code Stop hook: block stopping while a flag removal is not verified; always exits 0")
  .action(() => {
    // Anything unexpected allows the stop: a broken hook must never trap the user.
    try {
      const input = process.stdin.isTTY ? {} : parseHookInput(fs.readFileSync(0, "utf8"));
      const decision = stopDecision(hookRoot(input.cwd ?? process.cwd()), input);
      if (decision.block) console.log(JSON.stringify({ decision: "block", reason: decision.reason }));
    } catch {
      // Allow the stop.
    }
  });

// --- init --------------------------------------------------------------------

program
  .command("init")
  .description(
    "set up flagrm in this repository: flagrm.config.yaml, the flagrm-remove and flagrm-verify skills for Claude Code, " +
      "GitHub Copilot and Codex, the Claude Code Stop hook and the .flagrm/ gitignore entry; never overwrites",
  )
  .action(async () => {
    const root = installRoot(process.cwd());
    printInstallRoot(root);
    printSteps(initProject(root));
    console.log(pc.bold("\nflagrm doctor"));
    printDoctor(await runDoctor(root));
    console.log(pc.dim("\nNext: fill in flagrm.config.yaml, then ask your agent: /flagrm-remove <FlagName>"));
  });

// --- update ------------------------------------------------------------------

program
  .command("update")
  .description(
    "refresh the installed skills, the AGENTS.md block and the Stop hook from this flagrm version " +
      "(only where flagrm init installed them)",
  )
  .action(() => {
    const root = installRoot(process.cwd());
    printInstallRoot(root);
    printSteps(updateProject(root));
  });

/** Say where init/update install when it isn't the working directory. */
function printInstallRoot(root: string): void {
  if (path.resolve(root) !== path.resolve(process.cwd())) {
    console.log(pc.dim(`Installing in ${relativePath(process.cwd(), root)}`));
  }
}

// --- doctor ------------------------------------------------------------------

program
  .command("doctor")
  .description(
    "check that this repository is ready for flag removal: config, build/test commands, git, .gitignore, " +
      "installed skills and Stop hook, abandoned baselines; exit 0 ok, 1 problems",
  )
  .option(
    "--config <path>",
    "path to a config file (default: the nearest flagrm.config.yaml up to the git repository root)",
  )
  .option("--run", "also run each build and test command")
  .option("--json", "machine-readable JSON output")
  .action(async (opts: { config?: string; run?: boolean; json?: boolean }) => {
    const report = await runDoctor(process.cwd(), { config: opts.config, run: opts.run });
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else printDoctor(report);
    process.exitCode = report.status === "ok" ? 0 : 1;
  });

// exitCode, not exit(): exit() can cut off output still being flushed to a pipe.
program.parseAsync().catch((err: unknown) => {
  if (!(err instanceof CliError)) throw err;
  console.error(pc.red(err.message));
  process.exitCode = 2;
});
