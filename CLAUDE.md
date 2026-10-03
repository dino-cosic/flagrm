# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm install
npm run ci                 # typecheck + lint + build + tests (what CI and prepublishOnly run)
npm run build              # clean dist/ and compile with tsc
npm test                   # vitest run
npx vitest run test/hook.test.ts            # one test file
npx vitest run test/verify.test.ts -t "build breaks"   # tests whose name matches
npm run lint:fix           # biome check --write (formatting + organize imports)
npm run dev -- list --config test/fixtures/realistic/before/flagrm.config.yaml   # run the CLI from source via tsx
```

`test/cli.test.ts` and `test/skills.test.ts` spawn the **built** `dist/cli.js`, so run `npm run build` before them after changing `src/`. Node >= 22, ESM (`"type": "module"`, NodeNext resolution: relative imports use `.js` extensions).

Biome excludes `dist/`, `examples/`, `skills/` and `test/fixtures/`. Never reformat fixtures; they are verbatim inputs.

## What flagrm is

A CLI that gives AI coding agents (Claude Code, Copilot, Codex) guardrails for removing feature flags. **The agent does the reasoning and edits; flagrm never edits source code.** It only records a baseline and deterministically decides when the removal is done. Per CONTRIBUTING, a new command or check should be something an agent can't cheaply and reliably do itself.

Flow: `init` installs config + skills + Stop hook → agent runs `/flagrm-remove <flag>` (`skills/flagrm-remove/SKILL.md`) → `flagrm baseline <flag>` records git sha, build/test results and flag names in `.flagrm/<flag>/baseline.json` → agent edits, adding wrappers/aliases via `baseline --name X --kind wrapper|alias` → loops `flagrm verify <flag>` until exit 0 → the Stop hook (`flagrm hook stop`) blocks Claude Code from finishing unless `verify.json` passed for the *exact current tree*.

## Architecture

- `src/cli.ts`: commander entry point for every command; output formatting lives in `src/core/report.ts` (and `markdown.ts` for `verify --md`).
- `src/core/types.ts`: the shared vocabulary. `CHECK_IDS` lists the verify checks; **bump `JSON_SCHEMA_VERSION` when a `--json` / `baseline.json` / `verify.json` shape changes incompatibly.**
- `src/core/verify/`: `index.ts` orchestrates four checks against the baseline: `leftovers` (recorded names still in code/config; comment mentions are warnings), `dead-code` (new compiler unused-diagnostics in changed files, delegated to the adapter), `build` and `tests` (`commands.ts`, with per-test comparison from TRX/JUnit via `test-results.ts`). Exit codes: 0 pass, 1 fail, 2 usage error.
- `src/core/hook.ts` + `git.ts`: the Stop hook compares a *tree fingerprint* (git tree id of the working dir as it would be committed, ignoring `.flagrm/`, computed without touching the real index) against the one stored in `verify.json`. The hook always exits 0 and signals blocking via its output.
- Text analysis layer: `scan.ts`, `mentions.ts`, `discover.ts`, `inventory.ts`, `source-text.ts` (lexical masking of strings/comments). Comments mentioning a "scan code path" are remnants of a removed deterministic rewrite engine.
- `src/adapters/{angular,dotnet,generic}`: implement the `Adapter` interface in `core/adapter.ts` (`defaultGlobs`, `discover`, optional `defaultCommands` and `unusedDiagnostics`). A new adapter must be registered in `core/registry.ts` and added to `ADAPTER_IDS` in `core/config.ts`.
- `src/core/install.ts`: what `init`/`update` write: skills copied to `.claude/skills/`, `.github/skills/`, `.agents/skills/` and stamped with `metadata.flagrm-version`, an `AGENTS.md` block, the `.claude/settings.json` Stop hook, `.gitignore` entry. `init` never overwrites.
- `src/core/config.ts`: `flagrm.config.yaml` parsing; adding a key means updating the `KNOWN_*_KEYS` lists and the README.
- `skills/`: the agent-facing product (markdown, shipped in the npm package). `test/skills.test.ts` enforces that skills only reference real CLI commands/options and stay short, so update it alongside CLI changes.

## Tests and fixtures

- `test/fixtures/realistic/{before,after}`: a real Angular + .NET removal of `NewCheckout` (`ExpressShipping` must survive). `after/` is the golden result and may only edit or delete `before/` files (`realistic-fixture.test.ts` enforces this). The verify tests run against it.
- `test/fixtures/generic-go/{before,after}`: the generic adapter fixture.
- `test/support/projects.ts`: `projectContext()` builds a `ProjectContext` the way the CLI does.

## Conventions

- Conventional Commits (`feat:`, `fix:`, `docs:`, ...).
- User-facing changes get a line under "Unreleased" in `CHANGELOG.md`.
- Pre-1.0: minor releases may break things.
