# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/). Before 1.0, a minor version may
contain breaking changes.

## [Unreleased]

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
  since its commit (`.flagrm/` and `flagrm.config.yaml` don't count), so a
  rerun after fixing the setup can't record a half-done removal. The error
  says how to set uncommitted edits aside with `git stash`.
- Tests that no longer run are sorted by why (`tests[]` in `verify --json`):
  `deleted` (gone from a changed test file, or a data row dropped from one),
  `renamed` (the same test without the flag's words in its name, matched to
  the new test), `excludedByConfig` (the test command or its files changed
  since the baseline) and `unexplained`. Only `unexplained` tests warn; the
  summary counts the others, and `--md` lists each group.

### Added

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
- `baseline --name X --file <path>` checks the name only in that file.
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

[0.1.1]: https://github.com/dino-cosic/flagrm/releases/tag/v0.1.1
[0.1.0]: https://github.com/dino-cosic/flagrm/releases/tag/v0.1.0
