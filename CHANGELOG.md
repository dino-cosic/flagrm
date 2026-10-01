# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/). Before 1.0, a minor version may
contain breaking changes.

## [0.1.0] - Unreleased

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

[0.1.0]: https://github.com/dino-cosic/flagrm/releases/tag/v0.1.0
