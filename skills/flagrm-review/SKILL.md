---
name: flagrm-review
description: >
  Use when a feature flag removal needs an independent review, when the user asks
  whether a flag removal kept the right behavior, or runs /flagrm-review <flag>,
  in a repository with a flagrm.config.yaml.
---

# Review a flag removal

`flagrm verify` decides whether the removal is done. You judge what it can't: whether
the code still behaves as it did with the flag ON. You report; you never edit, and your
findings never change the verify result. Run flagrm as `npx --no-install flagrm`.

## 1. Fresh session only

If you made this removal earlier in this conversation, don't review it: you would only
check your own reasoning. Tell the user to run `/flagrm-review <flag>` in a new session, and stop.

## 2. Verify

`flagrm verify <flag> --json`

- Exit 0: go to step 3.
- Exit 1: list each check with `status: "fail"` and its findings, then stop. Don't review, don't fix.
- Exit 2: show the message and stop. A missing baseline has to come from the code before
  the removal: never create one on the edited code. Tell the user to start over with
  `/flagrm-remove` from the pre-removal commit.

## 3. Review the diff

The removal is every file in `changedFiles`, compared with the baseline commit:
`git diff <baseline.git.sha> -- <file>` (it may already be committed, so not `HEAD`).
Check each change:

1. **ON path kept**: where the flag was read, the code that stays is what ran with the flag ON.
2. **Deleted tests**: each one tested only the OFF path or the flag switch, never ON behavior.
3. **Nothing lifted**: no code from the OFF path moved into live code.
4. **Nothing unrelated**: no edits beyond the flag and the code only the OFF path used.
5. **No lost side effects**: unwrapping a check kept every `await`, log, return value and call.

## 4. Report

1. One line: `flagrm verify <flag>: pass`, with the warning count if any.
2. **Review**: one bullet per finding: `file:line`, what is wrong, and why. No findings:
   "No problems found."

With findings, ask the user whether to fix them; edit nothing before they answer.
When nobody can answer (a headless run), only report.
