# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/). Before 1.0, a minor version may
contain breaking changes.

## [Unreleased]

### Added

- `flagrm stale [flags...]` and the `launchdarkly:` config section: reads a
  LaunchDarkly project (read-only, token from `LD_API_TOKEN`) and says which
  flags are ready to remove from code (`remove`), not in this repository
  (`unreferenced`) or should stay (`keep`, with reasons), with `--json` and
  `--md`. Exit 3 when LaunchDarkly can't be reached or refuses the request
  (rejected token, no access to the project, unknown project key).
  The `flagrm-remove` skill uses it instead of asking whether a flag set in
  LaunchDarkly is ON everywhere; `examples/ci/` has scheduled GitHub Actions
  and Azure Pipelines workflows that open a removal PR per ready flag, with
  an advisory `/flagrm-review` by a second, read-only agent in the PR body.
- `flagrm doctor` warns while an old `flagrm-verify` skill is still installed.

### Changed

- **Breaking:** the `/flagrm-verify` skill is replaced by `/flagrm-review`.
  Optional, in a new session: it runs `flagrm verify`, stops on a failure, and
  on a pass reviews the diff since the baseline (the ON path kept, deleted
  tests OFF-path only, nothing unrelated changed, no lost side effects). It
  reports findings, edits nothing and writes no commit message; that stays
  with `/flagrm-remove`, which now points to the review. Run `flagrm update`:
  it deletes the `flagrm-verify` skills and Copilot prompt file that flagrm
  installed (edits made to them are lost) and installs `flagrm-review`.
  `flagrm verify` itself is unchanged.
- README: how to install without a `package.json` (globally or with `npx`),
  and what to do when the UI and the backend are in separate repositories.

## [0.4.1] - 2026-10-12

### Security

- Replaced `fast-glob` with `tinyglobby`, which drops the vulnerable `braces`
  dependency (GHSA-vfj7-8cjw-p6xm) from installs.
- The Stop hook no longer lets a removal finish unverified when the config's
  `exclude` (or anything else it scans) changed since the baseline: widening
  `exclude` used to hide the removal's edits from the hook.
- A `git.sha` in `baseline.json` that isn't a commit id is refused, and no
  revision starting with `-` reaches git, where `--output=<file>` would have
  written a file.
- SECURITY.md says what flagrm guarantees and what the Stop hook doesn't:
  it guards against finishing a removal by accident, not an agent working
  around it.

## [0.4.0] - 2026-10-11

### Added

- `testResults` reads Jest JSON (`jest --json`, Vitest's `json` reporter); a
  result file that doesn't parse, or an XML file that isn't complete, is skipped.
- Without `testResults`, `verify` reads the changed test files to list
  deleted and renamed tests, and warns when the log's test count dropped by
  more than the diff deletes.
- Without `testResults`, `verify` reads failing test names and counts from
  the test command's log (Karma, Jest, Vitest, `dotnet test`; Go and pytest
  names), so a test that already failed at the baseline is a known failure
  there too.
- `doctor`'s warning about a test command without `testResults` says how
  to get results for the detected runner (Vitest, Jest, Karma, `dotnet test`).
- An optional per-project `lint` command (lint or type-check), run by
  `baseline`, `verify` and `doctor --run`. `verify`'s new `lint` check fails
  on lint errors the removal caused; a lint that already failed at the
  baseline only warns, unless its log has error lines the baseline's didn't
  (line and column numbers ignored).
- `verify`'s new `coverage` check warns about changed files that no build,
  test or lint command checks; a project's optional `covers` globs say which
  files its commands check (default: everything under its path). Files
  already dirty at the baseline and unchanged since don't count, nor do
  documentation and deleted files outside every project. With
  `--strict`, such a file now fails verify.
- `/flagrm-remove` takes several flags (`/flagrm-remove A B C`): it asks
  once whether they are all ON and whether to commit each one, then removes
  them one after another, one commit per flag.
- `/flagrm-remove` ends with the verify overview and a proposed commit
  message, so `/flagrm-verify` is only needed to check a removal later. The
  commit message takes the ticket from the branch name and wraps its body.
- A passing full verify saves its build and test results; `baseline` and
  `verify` on the same tree with the same commands reuse them instead of
  running them again, and say so. Removing flags one after another, each
  next baseline takes seconds, and so does `/flagrm-verify` after a
  removal. `--no-reuse` runs them anyway.
- Angular: a renamed import of a flag registry
  (`import { FeatureFlags as AppFeatureFlags }`) is followed, so
  `AppFeatureFlags.X` is recorded and checked like `FeatureFlags.X`.
- Angular: a name checked only in a component's `.ts` file is checked in
  its `templateUrl` template too, whether discovery or `--file` scoped it.
- Angular: `list` and `baseline` follow a flag's value through the fields,
  getters, parameterless methods and locals holding an evaluation of it
  (`isPaginationEnabled = this.ff.isFeatureFlagEnabled(…)`), names derived
  from those, and one hop into the child component input a template binds
  one of them to. Names that mention the flag are recorded; generic ones are
  listed as `suggestedNames`.
- `baseline --file` repeats: `--name x --file a.ts --file b.ts` records the
  name for every file in one call.
- `baseline --name` refuses a name whose code reads only other flags (a
  helper named like this flag that evaluates a different one), since
  `verify` would then ask to delete the other flag's code.

### Changed

- **Breaking:** JSON schema version 8: `--json`, `baseline.json` and `verify.json` gain
  the `lint` and `coverage` checks, `lint` runs and `git.dirtyHashes`.
  Version 6 and 7 baselines are still read.
- The Angular adapter's default test command now writes test results when
  the workspace's runner can without setup: JUnit for Angular's Vitest
  builder (`ng test --reporters=junit --output-file`) and plain Vitest, Jest
  JSON for Jest, and JUnit for Karma once karma.conf configures
  `karma-junit-reporter`. Results go to `.flagrm/test-results/<project>/`.
  A baseline taken before upgrading reports the test command as changed
  once; `flagrm baseline <flag> --accept config` or a new baseline clears it.

### Fixed

- A failed test run without test results showed only "exited with 1":
  `verify` now lists the log's error lines, as for a failed build.
- A lint, build or test command that fails because its package script
  (`npm run lint` without a `lint` script) or ESLint config is missing is a
  setup problem: `verify` and `doctor --run` fail on it instead of treating
  it as lint debt.
- Deleting a committed file that matches `exclude` (say, a generator removing
  `graphify-out/graph.html`) no longer invalidates a passing verify: the
  Stop hook's tree fingerprint now leaves out deletions under `exclude`, as
  it already did for edits and new files.
- `/flagrm-remove` tells the agent not to run code generators or formatters
  after the passing verify, or to verify again if it must.

## [0.3.0] - 2026-10-07

### Changed

- **Breaking:** `build` and `test` each fall back to the adapter's default on
  their own. Setting only `test` no longer drops the default build, so the
  dead-code check has a build log to read. `build: false` / `test: false`
  turn one off. The default .NET test command writes TRX to
  `.flagrm/test-results/<project>/` and sets `testResults`, so tests are
  compared by name and tests that already failed before the removal only
  warn. `flagrm scope --write` writes that `testResults` out along with the
  test command, and no longer folds long commands over two lines.
- flagrm's own setup files (`flagrm.config.yaml`, `.gitignore`,
  `.claude/settings.json`, the installed `flagrm-*` skills and prompt files,
  `AGENTS.md`, `flagrm.slnf`) and paths matching `exclude` no longer count as
  part of a removal: verify's changed files, `baseline --force` and the Stop
  hook ignore them, so generated output such as `graphify-out/` no longer
  invalidates a passing verify. An `exclude` entry that names a directory
  covers everything under it, as it already did for scanning.
- `flagrm doctor` and the `/flagrm-remove` precondition accept a tree whose
  only uncommitted files are flagrm's setup files or paths matching `exclude`,
  so a freshly run `flagrm init` no longer blocks the first removal.

### Added

- `flagrm doctor` marks the build and test commands that are adapter
  defaults, and warns about a test command without `testResults`. With
  `--run` it fails when the test command writes no results matching
  `testResults`, so a broken setup shows up before a removal instead of
  halfway through, and only warns when tests already fail: the baseline
  records those as known failures.
- `flagrm baseline <flag> --accept config,failures` acknowledges a change to
  the flagrm config or the baseline's failing tests, also mid-removal, when
  `--force` is no longer allowed. verify stops warning about the accepted
  config (tests it leaves out still count as excluded by config) and lists
  accepted known failures as info, so `--strict` can pass. A changed `tools:`
  no longer warns at all.
- The `dead-code` check warns about a method, property, field or type the
  removal left referenced only where it is declared. Compilers don't report
  that for public or internal members. The check is text-based: strings,
  templates, Razor views and config files count as references, comments
  don't, and language keywords and the flag's recorded names are left out.

## [0.2.1] - 2026-10-04

### Fixed

- `flagrm scope` on Windows: `--json` printed the solution path with forward
  slashes, and `--write` showed a wrong `.git/info/exclude` path (and could
  write a wrong line to it) when the path held a short name such as
  `RUNNER~1`.

## [0.2.0] - 2026-10-04

### Changed

- **Breaking:** JSON schema version 7. `baseline --json` prints a summary of
  `baseline.json` instead of the whole file: each test run's results as
  counts with at most 20 short failed test names (`failedTests`,
  `moreFailedTests`), and no `config` snapshot. On a large suite the full
  output was megabytes. `baseline.json` is unchanged, and version 6 files are
  still read.
- The Stop hook only blocks once the removal has edited a file git tracks
  (other than `flagrm.config.yaml`), or the last verify used `--skip`. A
  removal paused on a question to the user, a config fix or an untracked
  file such as a stray test result no longer blocks.
- `verify`'s `tests[]` reports `failed` and the short names of `newFailures`
  and `knownFailures` per project.
- `verify` no longer fails the `tests` check when every failing test already
  failed at the baseline: those are reported as known failures and only warn.
  Only new failures fail it, and they are listed. Test names are compared
  without xUnit data-row arguments. Needs `testResults`.
- `baseline --force` refuses to replace a baseline once the code has changed
  since its commit (`.flagrm/`, `flagrm.config.yaml` and files matching
  `testResults` don't count), so a
  rerun after fixing the setup can't record a half-done removal. The error
  says how to set uncommitted edits aside with `git stash`.
- Tests that no longer run are sorted by why (`tests[]` in `verify --json`):
  `deleted` (gone from a changed test file, or a data row dropped from one),
  `renamed` (the same test without the flag's words in its name, matched to
  the new test), `excludedByConfig` (the test command or its files changed
  since the baseline) and `unexplained`. Only `unexplained` tests warn; the
  summary counts the others, and `--md` lists each group.

### Added

- `flagrm init` asks which AI coding tools to set up (Claude Code, GitHub
  Copilot, Codex), pre-selecting the ones the repository already uses
  (`.claude/`, `.github/copilot-instructions.md` or skills, `AGENTS.md`), and
  installs only their files. `--tool claude-code,codex` chooses without
  asking; without a terminal, the detected tools (all when none) are set up.
  The choice is saved as `tools:` in `flagrm.config.yaml`, which a later
  `init` and `update` follow; files of a tool dropped from it are left in
  place and named. Copilot also gets `/flagrm-remove` and `/flagrm-verify`
  prompt files in `.github/prompts/`. `doctor` checks only those tools.
- `flagrm scope`: for each .NET project, checks the machine (the SDK
  `global.json` asks for, with `rollForward`; `cargo` where a project's build
  runs it; Docker where a test project uses Testcontainers) and shows which
  projects a solution filter would leave out: those and every project that
  references them. `--write` creates `flagrm.slnf`, adds it to
  `.git/info/exclude` and points the project's build and test at it, editing
  `flagrm.config.yaml` in place. When the commands already name a solution
  filter, `flagrm.slnf` keeps only its projects; a command that names a
  project file is left alone. `doctor` (and so `init`) reports the same
  problems: a missing SDK fails, a missing `cargo` or Docker warns.
- README: leave a locale-dependent test out with `--filter` rather than
  forcing `LC_ALL` for the whole run.
- `verify` warns in `leftovers` about tests of the OFF path that never name
  the flag: a test that still checks a string literal the removal deleted
  from the code (and that no other code still has). When a test checked the
  deleted text but none checks the text kept on the same line, it warns
  that the ON path lost its test coverage.
- .NET discovery follows a flag's value: bool locals, fields and properties
  assigned `IsEnabled(<flag>)`, methods that only return it (or a ternary on
  it; static ones as `Class.Method`), and the bool parameters it is passed
  to. `flagrm list` shows them as `flow`; `baseline` records as wrappers the
  ones that clearly name the flag and lists the rest as `suggestedNames`. A
  local, parameter or field (recorded with `file`) is only checked in its own
  file; a method or property must contain the flag's whole name, or a flag
  word with a digit. A parameter of one of several same-named methods, or a
  method whose name another method shares, is only suggested. Test calls
  passing `true`/`false` for such a parameter are listed as
  `parameterizedTests`.
- `baseline --name X --file <path>` records `X` as a wrapper checked only in
  that file.
- The baseline records its configuration (`config` in `baseline.json`): each
  project's resolved build and test commands with a hash of the files they
  name (`.slnf`, `.runsettings`, filter lists; not `.sln`/`.csproj`),
  `testResults`, and the text of `flagrm.config.yaml`. `verify` warns when
  they changed since: a command or named file in `build`/`tests`, any other
  config change in `leftovers` with the changed lines.
- A failed build or test run whose log shows a machine setup problem gets
  `failure: { kind: "environment", message }` in `baseline.json` and the
  `verify`/`doctor` output: a .NET SDK that doesn't match `global.json`
  (requested vs installed versions), a command a build step couldn't find
  (and the project that runs it), or Docker not running for Testcontainers.

### Fixed

- Two projects whose `testResults` patterns overlap (`./**/TestResults/*.trx`)
  no longer count each other's result files when their test runs follow each
  other. Result files from earlier runs were already ignored.

## [0.1.1] - 2026-10-01

### Changed

- The license is now the Apache License 2.0, with attribution in `NOTICE`.
  Version 0.1.0 was published under the MIT License and stays available under
  it.
- The README no longer cites benchmark results, and its wording is tightened.

## [0.1.0] - 2026-10-01

Initial release.

flagrm is agent-first: an AI coding agent (Claude Code, GitHub Copilot, Codex)
removes the flag through the `flagrm-remove` skill, and flagrm checks the result.

### Added

- `init`: writes `flagrm.config.yaml` for the Angular workspaces and .NET
  solutions it detects, installs the `flagrm-remove` and `flagrm-verify` skills for
  Claude Code, Copilot and Codex, adds an `AGENTS.md` block, the Claude Code
  Stop hook and the `.flagrm/` `.gitignore` entry. Never overwrites.
- `doctor`: checks the config, build and test commands (`--run`), git,
  `.gitignore`, installed skills and hook, and abandoned baselines.
- `update`: refreshes the installed skills, `AGENTS.md` block and hook.
- `list`: inventories every feature flag, its configured state per environment
  and its reference counts.
- `baseline <flag>`: records the git commit, build and test results and the
  flag's names before the removal. `--name` adds wrappers and aliases.
- `verify <flag>`: `leftovers`, `dead-code`, `build` and `tests` checks against
  the baseline, with `--json` and `--md` output.
- `hook stop`: keeps Claude Code from finishing while a removal is in progress
  and not verified.
- Angular and .NET adapters, and a generic adapter for other stacks.
- Per-project `timeout` (seconds) for build and test commands.
- The .NET adapter builds with `dotnet build --no-incremental` by default, and
  `doctor` warns about an incremental `dotnet build`, which hides existing
  warnings from the dead-code comparison.

[0.4.1]: https://github.com/dino-cosic/flagrm/releases/tag/v0.4.1
[0.4.0]: https://github.com/dino-cosic/flagrm/releases/tag/v0.4.0
[0.3.0]: https://github.com/dino-cosic/flagrm/releases/tag/v0.3.0
[0.2.1]: https://github.com/dino-cosic/flagrm/releases/tag/v0.2.1
[0.2.0]: https://github.com/dino-cosic/flagrm/releases/tag/v0.2.0
[0.1.1]: https://github.com/dino-cosic/flagrm/releases/tag/v0.1.1
[0.1.0]: https://github.com/dino-cosic/flagrm/releases/tag/v0.1.0
