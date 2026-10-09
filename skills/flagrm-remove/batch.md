# Remove several flags

Run SKILL.md's workflow once per flag, in the order given, one commit per flag.
Each baseline reuses the previous flag's passing verify (seconds) only if the commit leaves the tree as verified.

## Once, before the first flag

1. SKILL.md step 1 preconditions. Find every flag in `flagrm list --json`; for one that's missing, show the closest names and ask.
2. One table: flag, `state`, and for any not `on` the environments in `config[]` that change.
   Ask once: "Remove all of these as ON everywhere?" On a no, drop the flags the user names.
3. Ask once: "Commit each flag once its verify passes?"

## Per flag

Copy this checklist for each flag and tick it as you go:

```
<flag>:
- [ ] baseline (step 2)
- [ ] every usage found (step 3)
- [ ] removed (step 4)
- [ ] verify passes (step 5)
- [ ] handed back (step 6)
- [ ] committed
```

- The ON answer above is step 1's state answer: don't ask again.
- Commit answer yes: commit with the proposed message, then start the next flag. No: show the message,
  stop, and continue once the user says it's committed. The next baseline needs the previous removal committed.
- A flag that needs the user (three failed attempts on one check, an unclear case) pauses the batch.
  Never start a flag while the previous one is uncommitted.
- Optional: if you can start subagents, run each flag in its own, one at a time. A subagent sees no
  conversation history: give it the flag, that it is confirmed ON everywhere, the commit answer, and
  "follow flagrm-remove's SKILL.md steps 2–6".

## At the end

One table: flag, commit, remaining warnings, kept on purpose.
