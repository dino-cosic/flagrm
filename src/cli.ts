#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command, CommanderError } from "commander";
import pc from "picocolors";
import { realProbes } from "./adapters/dotnet/setup.js";
import type { Workspace } from "./core/adapter.js";
import { baselineSummary, takeBaseline } from "./core/baseline.js";
import { type CliPathOptions, loadConfig, parseTools, TOOL_IDS, type ToolId } from "./core/config.js";
import { UsageError } from "./core/errors.js";
import { hookRoot, parseHookInput, stopDecision } from "./core/hook.js";
import { initProject, installRoot, updateProject } from "./core/install.js";
import { buildInventory } from "./core/inventory.js";
import { staleMarkdown, verifyMarkdown } from "./core/markdown.js";
import { packageVersion } from "./core/package.js";
import {
  printBaseline,
  printDoctor,
  printInventory,
  printScope,
  printStale,
  printSteps,
  printVerifyReport,
} from "./core/report.js";
import { setupReport, writeScope } from "./core/scope.js";
import { LaunchDarklySource } from "./core/sources/launchdarkly.js";
import { SourceError } from "./core/sources/types.js";
import { evaluateStale, needsHistory } from "./core/stale.js";
import { askTools, detectTools, savedTools, TOOL_LABELS } from "./core/tools.js";
import { CHECK_IDS, type StaleReport } from "./core/types.js";
import { onPath, relativePath } from "./core/util.js";
import { parseSkip, verifyFlag } from "./core/verify/index.js";

interface CommonOptions extends CliPathOptions {
  json?: boolean;
}

const program = new Command();

program
  .name("flagrm")
  .description(
    "Guardrails for removing feature flags with an AI coding agent: set up the skills and hook (init, update, " +
      "doctor), find flags (list) and those LaunchDarkly says are ready to remove (stale), record the state before a " +
      "removal (baseline) and gate the result (verify).",
  )
  .version(packageVersion())
  // Throw instead of exiting, so a usage error commander finds (unknown option, missing argument) exits 2 too.
  .exitOverride();

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
      .option(
        "--config <path>",
        "path to a config file (default: the nearest flagrm.config.yaml up to the git repository root)",
      )
      .option("--json", "machine-readable JSON output"),
  );
}

/** End the command with `message` and exit code 2. */
function usage(message: string): never {
  throw new UsageError(message);
}

/**
 * The adapter registry, loaded on first use: the Angular adapter pulls in the
 * TypeScript compiler (over 100 ms to load), which commands that never touch an
 * adapter, the Stop hook above all, should not pay for. `doctor` reaches the
 * registry too, so it is loaded the same way.
 */
const registry = () => import("./core/registry.js");
const doctor = async (...args: Parameters<typeof import("./core/doctor.js").runDoctor>) =>
  (await import("./core/doctor.js")).runDoctor(...args);

/** Load the config and pair every project with its adapter; a config error exits 2. */
async function loadWorkspace(opts: CliPathOptions): Promise<{ root: string; projects: Workspace }> {
  const config = loadConfig(opts);
  return { root: config.root, projects: (await registry()).resolveProjects(config) };
}

// --- baseline ------------------------------------------------------------------

addCommonOptions(
  program
    .command("baseline <flag>")
    .description(
      "record the state before removing a flag: the git commit, each project's build, test and lint results, and the " +
        "flag's names for the leftovers check; writes .flagrm/<flag>/baseline.json for verify. With --name on an " +
        "existing baseline, only adds names",
    ),
)
  .option("--no-checks", "record only the git state, without running build, test and lint commands")
  .option(
    "--no-reuse",
    "run build, tests and lint even when a passing verify on the same tree and commands saved their results",
  )
  .option("--name <name>", "add a name the flag is read through (repeatable)", collect, [])
  .option(
    "--kind <kind>",
    "how --name entries are matched: alias (qualified constant) or wrapper (identifier, calls included); default alias, wrapper with --file",
  )
  .option(
    "--file <path>",
    "check the --name entries only in these files and the files sharing their scope, such as a component's template " +
      "(repeatable; a local, parameter or field; implies --kind wrapper)",
    collect,
    [],
  )
  .option("--force", "start over: replace the baseline, only while the code is unedited since it")
  .option(
    "--accept <what>",
    "acknowledge without starting over, also mid-removal: config (verify stops warning about changes to the flagrm " +
      "config so far), failures (the baseline's failing tests); comma-separated",
  )
  .action(
    async (
      flag: string,
      opts: CommonOptions & {
        checks: boolean;
        reuse: boolean;
        name: string[];
        kind?: string;
        file: string[];
        force?: boolean;
        accept?: string;
      },
    ) => {
      const { root, projects } = await loadWorkspace(opts);
      const { baseline, file } = await takeBaseline(root, projects, flag, {
        checks: opts.checks,
        reuse: opts.reuse,
        names: opts.name,
        kind: opts.kind,
        files: opts.file,
        force: opts.force,
        accept: opts.accept,
      });
      if (opts.json) console.log(JSON.stringify(baselineSummary(baseline, file), null, 2));
      else printBaseline(baseline, file);
    },
  );

// --- verify ------------------------------------------------------------------

addCommonOptions(
  program
    .command("verify <flag>")
    .description(
      "gate a flag removal against its baseline (`flagrm baseline <flag>`): leftovers, new unused code, build, tests, lint and coverage; " +
        "writes .flagrm/<flag>/verify.json; exit 0 pass, 1 fail, 2 usage error",
    ),
)
  .option("--skip <checks>", `comma-separated checks to skip (${CHECK_IDS.join(", ")})`)
  .option("--strict", "treat warnings as failures")
  .option("--md", "print a markdown overview (for the user or a PR) instead of text")
  .option(
    "--no-reuse",
    "run build, tests and lint even when a passing verify on the same tree and commands saved their results",
  )
  .action(
    async (flag: string, opts: CommonOptions & { skip?: string; strict?: boolean; md?: boolean; reuse: boolean }) => {
      if (opts.md && opts.json) usage("--md and --json can't be combined.");
      const { root, projects } = await loadWorkspace(opts);
      const result = await verifyFlag(root, projects, flag, {
        skip: parseSkip(opts.skip),
        strict: opts.strict,
        reuse: opts.reuse,
      });
      if (opts.json) {
        console.log(JSON.stringify({ ...result.report, verifyFile: result.file }, null, 2));
      } else if (opts.md) {
        process.stdout.write(verifyMarkdown(result.report, root));
      } else {
        printVerifyReport(result.report, result.file);
      }
      // exitCode, not exit(): exit() can cut off stdout still being flushed to a pipe.
      process.exitCode = result.report.status === "pass" ? 0 : 1;
    },
  );

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
  const report = await buildInventory((await loadWorkspace(opts)).projects);
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printInventory(report);
  }
});

// --- stale -------------------------------------------------------------------

addCommonOptions(
  program
    .command("stale [flags...]")
    .description(
      "ask LaunchDarkly (the config's launchdarkly: section, read-only) which flags are ready to remove from code: " +
        "remove (meets the conditions, in this repository's code), unreferenced (not in this repository) or keep " +
        "(with reasons); flags are LaunchDarkly keys or code names, default all; " +
        "exit 0 evaluated, 2 usage error, 3 LaunchDarkly unreachable or refused the request (token, access, project key)",
    ),
)
  .option("--md", "print a markdown summary (for a pull request or pipeline summary) instead of text")
  .action(async (flags: string[], opts: CommonOptions & { md?: boolean }) => {
    if (opts.md && opts.json) usage("--md and --json can't be combined.");
    const config = loadConfig(opts);
    const projects = (await registry()).resolveProjects(config);
    const ld = config.launchdarkly;
    if (!ld) {
      usage(
        `No launchdarkly: section in ${config.file ?? "the config"}. Add one with your LaunchDarkly project key:\n` +
          "  launchdarkly:\n    project: <project key>\n" +
          "and set LD_API_TOKEN to an API token (reader role is enough). See the README's LaunchDarkly section.",
      );
    }
    // Checked before any request: nothing goes out without a token.
    const token = process.env[ld.tokenEnv]?.trim();
    if (!token) usage(`${ld.tokenEnv} is not set: set it to a LaunchDarkly API token (reader role is enough).`);
    const codeNames = (await buildInventory(projects)).flags.map((f) => f.flag);
    let report: StaleReport;
    try {
      const read = await new LaunchDarklySource(ld, { token }).read((f) => needsHistory(f, ld, codeNames));
      report = evaluateStale({ project: ld.project, read, codeNames, config: ld, now: new Date(), only: flags });
    } catch (err) {
      if (!(err instanceof SourceError)) throw err;
      console.error(pc.red(err.message));
      process.exitCode = 3;
      return;
    }
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else if (opts.md) process.stdout.write(`${staleMarkdown(report)}\n`);
    else printStale(report);
    process.exitCode = 0;
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
    "set up flagrm in this repository: flagrm.config.yaml, the .flagrm/ gitignore entry, and for each AI coding " +
      "tool its files (Claude Code: skills and Stop hook; GitHub Copilot: skills and prompt files; Codex: skills " +
      "and the AGENTS.md block); asks which tools on a terminal and saves the choice as `tools:`; never overwrites",
  )
  .option("--tool <tools>", `comma-separated tools to set up, without asking: ${TOOL_IDS.join(", ")}`)
  .action(async (opts: { tool?: string }) => {
    const root = installRoot(process.cwd());
    printInstallRoot(root);
    const tools = await chooseTools(root, opts.tool);
    printSteps(initProject(root, tools));
    console.log(pc.bold("\nflagrm doctor"));
    printDoctor(await doctor(root));
    console.log(pc.dim("\nNext: fill in flagrm.config.yaml, then ask your agent: /flagrm-remove <FlagName>"));
  });

/**
 * The tools `init` sets up: `--tool`, else the config's saved `tools:`, else
 * the user's answer with the tools the repository already uses pre-selected.
 * Without a terminal to ask on: those detected tools, or all when there are none.
 */
async function chooseTools(root: string, flag: string | undefined): Promise<ToolId[]> {
  if (flag !== undefined) {
    const tools = parseTools(flag, "--tool") ?? [];
    if (tools.length === 0) usage(`--tool needs at least one of ${TOOL_IDS.join(", ")}.`);
    return tools;
  }
  const saved = savedTools(root);
  if (saved?.length) {
    console.log(
      pc.dim(`Tools: ${saved.map((t) => TOOL_LABELS[t]).join(", ")} (from tools: in the config; --tool changes it)`),
    );
    return saved;
  }
  const detected = detectTools(root);
  if (process.stdin.isTTY && process.stdout.isTTY) return askTools(detected);
  return detected.length ? detected : [...TOOL_IDS];
}

// --- update ------------------------------------------------------------------

program
  .command("update")
  .description(
    "refresh the installed skills, prompt files, AGENTS.md block and Stop hook from this flagrm version " +
      "(only where flagrm init installed them, and only for the config's tools: when it lists them)",
  )
  .action(() => {
    const root = installRoot(process.cwd());
    printInstallRoot(root);
    printSteps(updateProject(root, savedTools(root)));
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
    "check that this repository is ready for flag removal: config, build/test/lint commands, git, .gitignore, " +
      "installed skills and Stop hook, abandoned baselines; exit 0 ok, 1 problems",
  )
  .option(
    "--config <path>",
    "path to a config file (default: the nearest flagrm.config.yaml up to the git repository root)",
  )
  .option("--run", "also run each build, test and lint command")
  .option("--json", "machine-readable JSON output")
  .action(async (opts: { config?: string; run?: boolean; json?: boolean }) => {
    const report = await doctor(process.cwd(), { config: opts.config, run: opts.run });
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else printDoctor(report);
    process.exitCode = report.status === "ok" ? 0 : 1;
  });

// --- scope -------------------------------------------------------------------

addCommonOptions(
  program
    .command("scope")
    .description(
      "check that this machine can build and test each .NET project (the SDK global.json asks for, `cargo`, " +
        "Docker for Testcontainers) and show which projects a solution filter (flagrm.slnf) would leave out; " +
        "exit 0 nothing missing, 1 something missing",
    ),
)
  .option("--write", "create flagrm.slnf, keep it out of git and point the config's build and test at it")
  .action(async (opts: CommonOptions & { write?: boolean }) => {
    const { root, projects } = await loadWorkspace(opts);
    const setups = setupReport(
      projects,
      root,
      realProbes((exe) => onPath(exe, root)),
    );
    const steps = opts.write ? writeScope(setups, projects, root, projects[0]?.ctx.config.file) : [];
    if (opts.json) console.log(JSON.stringify({ projects: setups, ...(opts.write ? { steps } : {}) }, null, 2));
    else {
      printScope(setups, root, Boolean(opts.write));
      printSteps(steps);
    }
    const missing = setups.some((s) => s.sdk || s.setup?.problems.length);
    process.exitCode = missing ? 1 : 0;
  });

// exitCode, not exit(): exit() can cut off output still being flushed to a pipe.
try {
  await program.parseAsync();
} catch (err) {
  if (err instanceof CommanderError) {
    // Commander printed the message already; --help and --version end with 0.
    process.exitCode = err.exitCode === 0 ? 0 : 2;
  } else if (err instanceof UsageError) {
    console.error(pc.red(err.message));
    process.exitCode = 2;
  } else {
    // Not the user's to fix: keep the stack, and a code an agent won't read as "called it wrong".
    console.error(
      pc.red(
        `flagrm ${packageVersion()}: unexpected error. This is likely a bug in flagrm; please report it with the output below.`,
      ),
    );
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 4;
  }
}
