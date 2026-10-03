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

You get a short overview (checks, changed files, tests that no longer run) and
a proposed commit message. The agent never commits for you. The overview looks
like this (abridged):

```md
### flagrm verify: NewCheckout ✅ pass

| Check | Status | Summary |
|---|---|---|
| leftovers | ✅ pass | no recorded name left in code or config |
| dead-code | ✅ pass | no new unused-code diagnostics |
| build | ✅ pass | web, api built successfully |
| tests | ⚠️ warn | tests passed (web 24 → 21, api 18 → 16) |

**Files changed since baseline (26):** `backend/src/Shop.Api/Services/CheckoutService.cs`, ...

**Tests that no longer run (5):** `LegacyPricingCalculatorTests.AppliesBulkDiscount`, ...
```

A warning is not a failure. Here the agent deleted the tests that covered only
the OFF path, on purpose, and explains that in its notes.

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
   removal is in progress (uncommitted changes on top of its baseline commit)
   and not verified.
4. **`/flagrm-verify <flag>`** runs `flagrm verify <flag> --md` and adds notes
   and a commit message.

## Commands

| Command | What it does | Exit codes |
|---|---|---|
| `init` | Set up the config, skills, `AGENTS.md` block, Stop hook and `.gitignore` entry. Never overwrites | 0 |
| `doctor` | Check the config, build and test commands (`--run` runs them), git, `.gitignore`, installed skills and hook, and abandoned baselines | 0 ok, 1 problems |
| `update` | Refresh the installed skills, the `AGENTS.md` block and the hook from this flagrm version | 0 |
| `list` | List every feature flag in the project: definitions, configured state per environment, reference counts | 0 |
| `baseline <flag>` | Before any edit, record the git commit, build and test results and the flag's names in `.flagrm/<flag>/baseline.json`. `--name X --kind alias\|wrapper` adds names to an existing baseline; `--force` starts over, but only while the code is unedited since the baseline commit (changes to `flagrm.config.yaml` are fine); `--no-checks` skips build and tests | 0, 2 usage error |
| `verify <flag>` | Gate the removal with `leftovers`, `dead-code`, `build` and `tests`. Writes `.flagrm/<flag>/verify.json`. `--md` prints the overview, `--json` the full result, `--skip` skips checks, `--strict` fails on warnings | 0 pass, 1 fail, 2 usage error |
| `hook stop` | The Claude Code Stop hook installed by `init` | always 0 |

`list`, `baseline` and `verify` accept `--json`, `--config <path>`, and
`--include` / `--exclude <glob>`.

## What `verify` checks

| Check | Fails when |
|---|---|
| `leftovers` | A recorded name (the flag literal, its constants, wrappers the agent recorded) is still in code or config. A mention in a comment is a warning |
| `dead-code` | The compiler reports new unused code (locals, imports, private members) in changed files |
| `build` | A project's build command fails |
| `tests` | A test that passed at the baseline fails. With `testResults`, tests that already failed at the baseline are known failures and only warn. Tests that no longer run, and changed test files none of whose tests ran, are warnings for the agent to account for |

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
lets `verify` compare individual tests against the baseline. `timeout`
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
