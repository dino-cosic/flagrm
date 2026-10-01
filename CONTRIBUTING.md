# Contributing

Thanks for helping. Bug reports, flag patterns flagrm misses and pull requests
are all welcome.

## Reporting a bug

Open an issue with:

- the flagrm version (`flagrm --version`), Node.js version and OS
- the agent you used (Claude Code, Copilot, Codex) and its version
- the command and its output (`--json` output helps most)
- a minimal code sample of the flag usage, if the problem is about finding or
  checking a flag

Please don't paste proprietary code. A reduced example is enough.

## Development

```sh
npm install
npm run ci      # typecheck, lint, build, tests
npm run dev -- list --config test/fixtures/realistic/before/flagrm.config.yaml
```

- `src/cli.ts` is the command-line entry point, `src/core/` holds the commands
  and the `verify` checks, and `src/adapters/` the Angular, .NET and generic
  adapters.
- `skills/` holds the skills `flagrm init` installs. `test/skills.test.ts`
  checks that they only use real commands and options.
- `test/fixtures/realistic` is a before/after pair of a real removal (Angular
  and .NET) that the `verify` tests run against.

## Pull requests

- Keep a pull request to one change, and add or update tests for it.
- `npm run ci` must pass. `npm run lint:fix` fixes formatting.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit
  messages (`feat:`, `fix:`, `docs:`, ...).
- Add a line to `CHANGELOG.md` under "Unreleased" for user-facing changes.

flagrm stays small on purpose: the agent reasons and edits, and flagrm provides
deterministic checks of the result. A new command or check should be something
an agent can't cheaply and reliably do itself.
