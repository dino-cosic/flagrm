# Security policy

Please report security issues privately through
[GitHub security advisories](https://github.com/dino-cosic/flagrm/security/advisories/new),
not in a public issue. You should get a reply within a week.

## Before you run flagrm

flagrm runs the build, test and lint commands from `flagrm.config.yaml` in
your shell, the same way `npm run` runs a package's scripts. `flagrm init`
installs a Claude Code Stop hook that runs `flagrm hook stop`. Review both
before using flagrm in a repository you don't trust.

## What flagrm guarantees

- It never edits your source code. It writes only its config, the agent
  files `init` and `update` install, `flagrm.slnf` (`scope --write`) and
  `.flagrm/`.
- The Stop hook never downloads code (`npx --no-install`) and never runs
  builds or tests. When anything goes wrong it allows the stop, so a broken
  hook can't trap you.
- `verify` decides deterministically: the same tree, baseline and command
  results give the same verdict.

## What it doesn't guarantee

The Stop hook keeps an agent from finishing a removal *by accident* without
a passing verify. It is not a boundary against an agent that works around
it, which no tool inside the same repository can enforce:

- It blocks once per stop: Claude Code marks the next attempt with
  `stop_hook_active` to avoid an endless loop, and the hook lets it through.
- It stops guarding a removal once HEAD moves (a commit, a branch switch).
- `.flagrm/` holds plain JSON files that anything with write access to the
  repository can change. The skills tell the agent never to edit them.
- `verify` warns about, but doesn't fail on, a config change since the
  baseline (a wider `exclude`, a narrower test command), unless you run it
  with `--strict`.

So review the diff and the whole verify report, warnings included, not
only its exit code.
