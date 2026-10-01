# flagrm

Remove feature flags with your AI coding agent, safely. flagrm gives Claude Code,
GitHub Copilot and Codex a flag-removal skill and the guardrails to check the
result: a baseline taken before the edit, and a `verify` gate that fails while
the flag is still referenced, the build breaks, a test regresses, or the
removal left unused code behind.

The agent does the reasoning and the edits (finding the flag, its aliases and
wrappers, removing the OFF path, refactoring methods the flag was passed
into). flagrm decides when it's done.

Works with Angular and .NET projects out of the box, and any other stack
through the generic adapter.

In a [benchmark on bitwarden/server and bitwarden/clients](docs/BENCHMARK.md),
Claude Code removed a live flag from each repository, including the dead OFF
paths and the tests that covered only them, in under 5 minutes and for about
$1.50 per flag, with `flagrm verify` passing on an independent rerun.

## Requirements

- Node.js 22 or later
- git: `baseline` and `verify` compare against the commit the removal started from
- An AI coding agent that reads skills: Claude Code, GitHub Copilot or Codex
  (the Stop hook is Claude Code only)

On Windows, the Stop hook runs in Git Bash, or in PowerShell when Git Bash
isn't installed. In PowerShell, `npx` needs an execution policy that allows
scripts (`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`); otherwise the
hook fails and doesn't guard the removal. `flagrm verify` still works.

## Quick start

```sh
npm install -D flagrm        # or run everything with npx flagrm
npx flagrm init              # config, skills, Stop hook, .gitignore entry
```

Fill in the project paths and build/test commands in `flagrm.config.yaml`, check
the setup with `npx flagrm doctor`, then ask your agent:

```
/flagrm-remove NewCheckout
```

When it reports back:

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

A warning is not a failure: here the agent deleted the OFF path's tests on
purpose, and says so in its notes.

## How it works

1. **`flagrm init`** writes `flagrm.config.yaml` for the Angular and .NET projects
   it finds, installs the `flagrm-remove` and `flagrm-verify` skills into
   `.claude/skills/`, `.github/skills/` and `.agents/skills/`, adds a pointer to
   `AGENTS.md` for Codex, adds a Claude Code Stop hook to
   `.claude/settings.json` and `.flagrm/` to `.gitignore`.
2. **`/flagrm-remove <flag>`**: the agent checks the tree is clean, runs
   `flagrm baseline <flag>` (git commit, build and test results, the flag's
   names), finds every usage with its own search, records wrappers and
   aliases with `flagrm baseline <flag> --name`, removes the flag, and loops
   `flagrm verify <flag>` until it passes.
3. **The Stop hook** (Claude Code) keeps the agent from finishing while a
   removal is in progress (uncommitted on top of its baseline commit) and not
   verified.
4. **`/flagrm-verify <flag>`** runs `flagrm verify <flag> --md` and adds notes and a
   commit message.

## Commands

| Command | What it does | Exit codes |
|---|---|---|
| `init` | Set up the config, skills, `AGENTS.md` block, Stop hook and `.gitignore` entry. Never overwrites | 0 |
| `doctor` | Check config, build/test commands (`--run` runs them), git, `.gitignore`, installed skills and hook, abandoned baselines | 0 ok, 1 problems |
| `update` | Refresh installed skills, the `AGENTS.md` block and the hook from this flagrm version | 0 |
| `list` | Every feature flag in the project: definitions, configured state per environment, reference counts | 0 |
| `baseline <flag>` | Before any edit: record the git commit, build and test results and the flag's names in `.flagrm/<flag>/baseline.json`. `--name X --kind alias\|wrapper` adds names to an existing baseline; `--force` starts over; `--no-checks` skips build and tests | 0, 2 usage error |
| `verify <flag>` | Gate the removal: `leftovers`, `dead-code`, `build`, `tests`. Writes `.flagrm/<flag>/verify.json`. `--md` prints the overview, `--json` the full result, `--skip` skips checks, `--strict` fails on warnings | 0 pass, 1 fail, 2 usage error |
| `hook stop` | The Claude Code Stop hook installed by `init` | always 0 |

`list`, `baseline` and `verify` take `--json`, `--config <path>`, and
`--include`/`--exclude <glob>`.

## What verify checks

| Check | Fails when |
|---|---|
| `leftovers` | A recorded name (the flag literal, its constants, wrappers the agent recorded) is still in code or config. A mention in a comment is a warning |
| `dead-code` | The compiler reports new unused code (locals, imports, private members) in changed files |
| `build` | A project's build command fails |
| `tests` | A test that passed at the baseline fails. Tests that no longer run, and changed test files none of whose tests ran, are warnings for the agent to account for |

In typed code, deleting the flag's definition makes every missed reference a
compile error, so the build does most of the work. `leftovers` covers what the
compiler can't see: config files, templates, comments and wrappers.

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
path. Without `build`/`test`, the adapter's defaults are used (`dotnet build
--no-incremental`, `npx ng build`, ...). `testResults` (JUnit XML or TRX) lets
`verify` compare individual tests against the baseline. `timeout` (seconds)
fails a project's build or test command that runs longer, such as a test
runner left in watch mode.

For .NET, keep `--no-incremental` in `build`: an incremental build skips
up-to-date projects and prints none of their warnings, so the dead-code check
would have no baseline warnings to compare against.

## Development

```sh
npm install
npm run ci      # typecheck, lint, build, tests
npm run dev -- list --config test/fixtures/realistic/before/flagrm.config.yaml
```

`test/fixtures/realistic` holds a before/after pair of a real removal (Angular
and .NET) that the `verify` tests run against.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to report a bug or send a pull
request, and [CHANGELOG.md](CHANGELOG.md) for what changed between versions.

## License

[MIT](LICENSE)
