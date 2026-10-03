# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/). Before 1.0, a minor version may
contain breaking changes.

## [Unreleased]

### Changed

- `verify` no longer fails the `tests` check when every failing test already
  failed at the baseline: those are reported as known failures and only warn.
  Only new failures fail it, and they are listed. Test names are compared
  without xUnit data-row arguments. Needs `testResults`.
- `baseline --force` refuses to replace a baseline once the code has changed
  since its commit (`.flagrm/` and `flagrm.config.yaml` don't count), so a
  rerun after fixing the setup can't record a half-done removal. The error
  says how to set uncommitted edits aside with `git stash`.

### Added

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
