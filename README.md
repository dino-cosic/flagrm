# flagrm

[![CI](https://github.com/dino-cosic/flagrm/actions/workflows/ci.yml/badge.svg)](https://github.com/dino-cosic/flagrm/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/flagrm)](https://www.npmjs.com/package/flagrm)

Remove feature flags with your AI coding agent, safely.

flagrm gives Claude Code, GitHub Copilot and Codex a flag-removal skill and the
guardrails to check the result. It records a baseline before the edit, then
gates the removal with `flagrm verify`, which fails while the flag is still
referenced, the build breaks, a test regresses, or the removal leaves unused
code behind.

The agent does the reasoning and the edits: finding the flag, its aliases and
wrappers, removing the OFF path, and refactoring methods the flag was passed
into. flagrm decides when the work is done.

Angular and .NET projects work out of the box. Any other stack works through the
generic adapter.

> **Status:** flagrm is at version 0.1. Until 1.0, a minor release may contain
> breaking changes.

## Requirements

- Node.js 22 or later
- git: `baseline` and `verify` compare against the commit the removal started from
- An AI coding agent that reads skills: Claude Code, GitHub Copilot or Codex
  (the Stop hook is Claude Code only)

On Windows, the Stop hook runs in Git Bash, or in PowerShell when Git Bash is
not installed. In PowerShell, `npx` needs an execution policy that allows
scripts (`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`). Otherwise the
hook fails and does not guard the removal. `flagrm verify` still works.

## Quick start

```sh
npm install -D flagrm        # or run everything with npx flagrm
npx flagrm init              # config, skills, Stop hook, .gitignore entry
```

Fill in the project paths and the build and test commands in
`flagrm.config.yaml`, check the setup with `npx flagrm doctor`, then ask your
agent:

```
/flagrm-remove NewCheckout
```

When the agent reports back, review the result:

```
/flagrm-verify NewCheckout
```

You get a short overview (checks, changed files, tests deleted or renamed) and
a proposed commit message. The agent never commits for you. The overview looks
like this (abridged):

```md
### flagrm verify: NewCheckout ✅ pass

| Check | Status | Summary |
|---|---|---|
| leftovers | ✅ pass | no recorded name left in code or config |
| dead-code | ✅ pass | no new unused-code diagnostics |
| build | ✅ pass | web, api built successfully |
| tests | ✅ pass | tests passed (web 24 → 22: 2 deleted, 1 renamed; api 18 → 16: 2 deleted) |

**Files changed since baseline (26):** `backend/src/Shop.Api/Services/CheckoutService.cs`, ...

**Tests deleted (4):** `LegacyPricingCalculatorTests.AppliesBulkDiscount`, ...

**Tests renamed (1):** `CheckoutComponent › places the order when NewCheckout is on` → `CheckoutComponent › places the order`
```

Tests that no longer run are sorted by why: deleted in the diff (the OFF
path's tests), renamed without the flag in the name, or left out by a test
command changed since the baseline. Only a test that no longer runs for none
of these reasons is a warning, for the agent to explain in its notes.

## How it works

1. **`flagrm init`** writes `flagrm.config.yaml` for the Angular and .NET
   projects it finds. It installs the `flagrm-remove` and `flagrm-verify`
   skills into `.claude/skills/`, `.github/skills/` and `.agents/skills/`, adds
   a pointer to `AGENTS.md` for Codex, adds a Claude Code Stop hook to
   `.claude/settings.json`, and adds `.flagrm/` to `.gitignore`.
2. **`/flagrm-remove <flag>`**: the agent checks that the tree is clean and runs
   `flagrm baseline <flag>`, which records the git commit, the build and test
   results, and the flag's names. It finds every usage with its own search,
   records wrappers and aliases with `flagrm baseline <flag> --name`, removes
   the flag, and repeats `flagrm verify <flag>` until it passes.
3. **The Stop hook** (Claude Code) keeps the agent from finishing while a
   removal is in progress and not verified. In progress means a file git
   tracks changed on top of the baseline commit (changes to
   `flagrm.config.yaml` and untracked files don't count, so a removal paused
   on a question to the user doesn't block), or the last verify used `--skip`.
4. **`/flagrm-verify <flag>`** runs `flagrm verify <flag> --md` and adds notes
   and a commit message.

## Commands

| Command | What it does | Exit codes |
|---|---|---|
| `init` | Set up the config, skills, `AGENTS.md` block, Stop hook and `.gitignore` entry. Never overwrites | 0 |
| `doctor` | Check the config, build and test commands (`--run` runs them), git, `.gitignore`, installed skills and hook, and abandoned baselines | 0 ok, 1 problems |
| `update` | Refresh the installed skills, the `AGENTS.md` block and the hook from this flagrm version | 0 |
| `list` | List every feature flag in the project: definitions, configured state per environment, reference counts | 0 |
| `baseline <flag>` | Before any edit, record the git commit, build and test results and the flag's names in `.flagrm/<flag>/baseline.json`. In .NET code the names include the locals, fields, parameters and methods the flag's value travels through when they name the flag (a local, parameter or field is checked only in its own file); generic or ambiguous ones are listed as `suggestedNames`, with `parameterizedTests` that pass the value as a literal. `--file` limits `--name` entries to one file. `--name X --kind alias\|wrapper` adds names to an existing baseline; `--json` prints a summary (test counts, at most 20 failed test names; the file keeps everything); `--force` starts over, but only while the code is unedited since the baseline commit (changes to `flagrm.config.yaml` are fine); `--no-checks` skips build and tests | 0, 2 usage error |
| `verify <flag>` | Gate the removal with `leftovers`, `dead-code`, `build` and `tests`. Writes `.flagrm/<flag>/verify.json`. `--md` prints the overview, `--json` the full result, `--skip` skips checks, `--strict` fails on warnings | 0 pass, 1 fail, 2 usage error |
| `hook stop` | The Claude Code Stop hook installed by `init` | always 0 |

`list`, `baseline` and `verify` accept `--json`, `--config <path>`, and
`--include` / `--exclude <glob>`.

## What `verify` checks

| Check | Fails when |
|---|---|
| `leftovers` | A recorded name (the flag literal, its constants, wrappers the agent recorded) is still in code or config. A mention in a comment is a warning, and so is a test that checks text the removal deleted from the code (a test of the OFF path that never names the flag), or deleted text whose replacement on the same line no test checks (lost ON coverage) |
| `dead-code` | The compiler reports new unused code (locals, imports, private members) in changed files |
| `build` | A project's build command fails |
| `tests` | A test that passed at the baseline fails. With `testResults`, tests that already failed at the baseline are known failures and only warn. A test that no longer runs though the diff neither deletes nor renames it and the test config is unchanged, and a changed test file none of whose tests ran, are warnings for the agent to account for |

The baseline also records the configuration it was taken with: each project's
resolved build and test commands, the files they name (a `.slnf`, a
`.runsettings`, a filter list) and the text of `flagrm.config.yaml`. When any
of it changed since, the check it affects warns and shows the difference: a
narrower test command makes "no new failures" mean less.

In typed code, deleting the flag's definition turns every missed reference into
a compile error, so the build does most of the work. `leftovers` covers what the
compiler cannot see: config files, templates, comments and wrappers.

## Configuration

```yaml
projects:
  - name: web
    adapter: angular
    path: ./frontend
    build: npm run build
    test: npx ng test --watch=false
    testResults: ./frontend/test-results/junit.xml
    methods: [isEnabled, watch]          # flag evaluation methods
  - name: api
    adapter: dotnet
    path: ./backend
    build: dotnet build --no-incremental
    test: dotnet test --logger trx --results-directory TestResults
    testResults: ./backend/TestResults/*.trx
  - name: service
    adapter: generic                     # any other stack
    path: ./service
    globs: ['**/*.go', 'config/**/*.yaml']
    methods: [IsEnabled]
exclude: ['**/Migrations/**']
```

Paths are relative to the config file, and commands run inside each project's
path. Without `build` or `test`, the adapter's defaults are used (`dotnet build
--no-incremental`, `npx ng build`, and so on). `testResults` (JUnit XML or TRX)
lets `verify` compare individual tests against the baseline. Only files written during the run are read, so result files left by earlier runs don't count, and projects whose patterns overlap don't count each other's files. `timeout`
(seconds) fails a project's build or test command that runs longer, for example
a test runner left in watch mode.

For .NET, keep `--no-incremental` in `build`. An incremental build skips
up-to-date projects and prints none of their warnings, so the dead-code check
would have no baseline warnings to compare against.

## Development

```sh
npm install
npm run ci      # typecheck, lint, build, tests
npm run dev -- list --config test/fixtures/realistic/before/flagrm.config.yaml
```

`test/fixtures/realistic` holds a before and after pair from a real removal
(Angular and .NET). The `verify` tests run against it.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to report a bug or send a pull
request, and [CHANGELOG.md](CHANGELOG.md) for what changed between versions.

## License

Licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE) for attribution.
