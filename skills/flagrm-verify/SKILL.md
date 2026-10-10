---
name: flagrm-verify
description: >
  Use when a feature flag removal needs checking, when the user asks whether a
  flag is fully removed or wants the summary or commit message for a flag
  removal, or runs /flagrm-verify <flag>, in a repository with a flagrm.config.yaml.
---

# Verify a flag removal

`flagrm verify` decides whether the removal passed. You show its overview, add what the CLI
can't know, and propose a commit message. Run it as `npx --no-install flagrm`.

## 1. Verify

`flagrm verify <flag> --md`

- Exit 0: go to step 2.
- Exit 1: show the failing checks. If you are in the middle of `/flagrm-remove`,
  fix them with its rules and verify again; otherwise ask the user whether to fix them now.
- Exit 2: read the message. A missing baseline has to come from the code before
  the removal. Never create one on the edited code: that compares the removal
  with itself. Tell the user to start over with `/flagrm-remove` from the
  pre-removal commit.

## 2. Hand back

Output, in this order:

1. The markdown from `flagrm verify` exactly as printed. Don't reword it, change
   its numbers or drop rows.
2. **Notes** (skip when empty), with no counts of your own:
   - why each remaining warning is acceptable;
   - projects whose tests didn't run because the config has no `test` command;
   - follow-ups outside the repo: archive the flag in the flag service
     (LaunchDarkly, Azure App Configuration, ...), remove keys from deployment
     settings and secret stores.
3. The commit message:

<!-- commit-message:start -->
**Proposed commit message**, in a code block:

```
chore: remove <flag> feature flag

<one or two sentences: which path stays and what was deleted>
```

- Follow the repository's convention instead when `git log --oneline -10` shows a different one.
- A ticket in the branch name (`feature/feat-24586`): add it the way the log does (`#24586`, `FEAT-24586`), else `(#24586)` after the subject.
- Wrap the body at 72 columns.
<!-- commit-message:end -->

Never commit, push or open a PR unless asked. Write a PR description only on request, from the same output.
