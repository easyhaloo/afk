# Hard Checks

Non-negotiable rules. Violating any of these is grounds for stopping
and reporting to the user immediately.

---

## HC-1: Diagnose before treating

Do not propose or write any fix before the root cause is identified.

**Rule:** Run Step 1 (Reproduce) and Step 2 (Hypothesize) completely.
Identify which specific file:line produces the failure and why before
writing any code.

---

## HC-2: Original trigger is the only valid proof

The only proof that a bug is fixed is the original trigger passing.

**Rule:** If `curl ...` or `<command>` still returns the same error
after the fix, the bug is not fixed. Do not close the session as
resolved. Return to Step 2.

---

## HC-3: No destructive commands without warning

Destructive commands (`rm -rf`, `docker rm -f`, `git reset --hard`,
`chmod -R`, etc.) must be stated explicitly and confirmed by the user
before execution.

**Rule:** If a destructive command is needed, stop, describe exactly
what it will do, wait for confirmation.

---

## HC-4: Stay within the repo context

Do not execute code or modify files outside the current repository
working tree without announcing it first.

**Rule:** If the investigation requires calling external services,
hitting network endpoints, or modifying system state, call it out
before doing it.
