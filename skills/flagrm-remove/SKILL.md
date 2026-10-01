---
name: flagrm-remove
description: >
  Use when the user asks to remove, retire, deprecate or clean up a feature flag
  or feature toggle, says a flag is fully rolled out, or runs /flagrm-remove <flag>,
  in a repository with a flagrm.config.yaml. Works for Angular, .NET and other
  stacks: IFeatureManager, [FeatureGate], appsettings FeatureManagement,
  LaunchDarkly-style calls, flags objects, enums, signals, *ngIf/@if templates.
---

# Remove a feature flag

**The flag is permanently ON.** Keep the ON path, delete the OFF path and
everything only it used. Behavior with the flag ON must not change.

You find and edit the code. `flagrm` records the state before you start and
decides when you are done: **done means `flagrm verify <flag> --json` exited 0.**
Run it as `npx --no-install flagrm`, one command per call, no `||` (plain `npx flagrm` is another package).

## 1. Preconditions

- `git status --porcelain` must print nothing. Otherwise ask the user to commit or stash.
- No `flagrm.config.yaml`: run `flagrm init` and fill in project paths and build/test commands with the user.
- `flagrm list --json`: find the flag in `flags[]`. Not there: show the closest names and ask.
- `state` is `off`, `mixed` or `conditional`: name the environments in `config[]` that change and get a yes, or stop.
  `unconfigured` (set in a flag service): ask if it is ON everywhere. The removal request is not that answer.
- Read `CLAUDE.md` or `AGENTS.md` if present, for conventions and build commands.

## 2. Baseline

`flagrm baseline <flag> --json` records the git commit, build and test results and the flag's
`names[]`. A `checks[]` entry with a non-zero `exitCode` means the code is already broken: stop.

## 3. Find every usage

- Grep for each name in `names[]`: code, templates, config and tests.
- Follow how the value travels: a method or property returning the flag, a field
  or local holding it, a parameter it's passed as, a DI-registered bool. Record
  each so `verify` checks it too, then grep for it:
  `flagrm baseline <flag> --name IsNewCheckoutEnabledAsync --kind wrapper`
  (`--kind alias` for a qualified constant like `Flags.NewCheckout`).

## 4. Remove

Read `patterns.md` in this skill's directory when a case is unclear.

- Condition: keep the ON branch, delete the OFF branch, drop the check.
  `a && flag` → `a`, `a || !flag` → `a`. Never touch other flags.
- Wrapper: replace each call with `true` and simplify, then delete the wrapper, its interface member and DI registration.
- Passed as a parameter: pass `true` and simplify the callee. Once no caller
  passes anything else, remove the parameter and the argument at every caller.
- Code only the OFF path used (methods, classes, fields, constructor parameters,
  DI registrations, imports/usings, files): delete it. Keep what anything else uses.
- Definition and config: remove the constant, enum member or flags-object key,
  and the key in every environment's config file. Remove a section left empty.
  Keep a key the service sends to other apps (a known-flags list behind a config endpoint): they'd read OFF.
- Tests: delete tests of the OFF path. In the others, remove the flag setup
  (mocks, spies, overrides) and drop the flag from the test name. A test
  parameterized over ON/OFF keeps only the ON case.
- Keep the flag system itself (the flag service or client and its generic methods), public API
  of a library package, and anything that also defines other flags. Mention them in your report.

## 5. Verify until it passes

`flagrm verify <flag> --json`. Fix every check with `status: "fail"`, run it again.

| Check | Fix |
|---|---|
| `leftovers` | Remove each reference listed. A comment is a warning: reword or delete it |
| `dead-code` | Delete what the removal left unused |
| `build` | Fix the error your edit caused; don't touch unrelated code. `tsc` skips templates: grep `.html` for each member you removed or renamed |
| `tests` | A failure means ON behavior changed: fix the edit, not the test. Tests that no longer run must be ones you deleted on purpose. A changed test file whose tests didn't run: run them yourself and report it |

Exit 2 is a usage or config error: read the message. `--skip build,tests` is fine for a quick check
in between; only a full run counts, and the Stop hook won't let you finish on one with `--skip`. After three failed attempts on one check, show the user the findings.

## 6. Report

In 3–5 lines: what was removed, what you kept on purpose, and each remaining warning with its
reason. If `state` wasn't `on` and nobody confirmed ON, start with "Assumed ON everywhere".
Suggest `/flagrm-verify <flag>` for the overview and commit message. Don't commit.

## Rules

- Never lift code out of the OFF path into live code.
- Match the file's formatting; don't refactor unrelated code.
- Never edit `.flagrm/`. Never run `flagrm baseline <flag>` again without `--name`.
- Never `--skip` a failing check, and never change a test's expected value to pass.
