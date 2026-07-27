---
name: afk-implement
description: >-
  Use when a GitLab issue with machine-checkable Acceptance Criteria is
  ready for autonomous implementation. Runs in background tmux session.
  Produces an MR against the integration branch.
disable-model-invocation: true
disallowed-tools: >-
  Bash(git push origin main) Bash(git push origin master)
  Bash(git reset --hard*) Bash(git branch -D*)
---

# Implement

**Goal:** autonomously implement one or more issues with AC.
**Mode:** AFK — runs in background tmux session with `/goal` persistence.
**Contract:** issue (AC present, unblocked, labeled `base::prd-<N>` or `base::direct`) →
MR + `stage::done` (pass) or `mode::hitl` (escalation).

## Preconditions (fail-closed)

All checks are mandatory. Stop immediately if any fails.

1. **`## Acceptance Criteria (machine-checkable)` section exists.**
   Missing → issue is not ready, stop.
2. **AC lines are machine-verifiable.** Every AC must be a command or
   observable check. If any cannot be verified from command output, stop.
3. **No open blockers.** Detection via label `blocks-<iid>` on blocker.
   If any open blocker exists, stop.
4. **`base::prd-<N>` or `base::direct` label exists.** Missing → issue was not created
   through the standard pipeline, stop.

## Routing

| File | Read when |
|------|-----------|
| `references/README.md` | Before writing any code |
| `references/tdd-feature.md` | Feature, API, data model, or UI work |
| `references/tdd-refactor.md` | Code-structure improvement |
| `references/hotfix.md` | Live bug fix |
| `references/spike.md` | Feasibility exploration |
| `references/research.md` | Research / information-gathering |
| `references/hard-checks.md` | **Always** — non-negotiable rules |
| `references/ddd.md` | Conditional: complex domain invariants or cross-context flows |
| `references/architecture.md` | Conditional: new module/package or new external dependency |
| `references/adr.md` | Conditional: significant new decision during implementation |

## Development methodology

Every run starts by identifying the task type, then loading the
corresponding reference document.

```
Is this task asking me to:
- ADD new behavior?                    → Feature
- CHANGE structure, not behavior?      → Refactor
- FIND information or decide?          → Research
- FIX a live bug under pressure?       → Hotfix
- PROVE something works first?         → Spike
```

If unsure, default to `references/tdd-feature.md`.

## Progress checkpoints

Git commit is the SSOT. Every WIP commit MUST have this structure:

```bash
mkdir -p .afk
cat > .afk/progress.json <<EOF
{"done": <N>, "total": <M>}
EOF

git add -A && git commit -m "$(cat <<'EOF'
<type>: <short description> #<iid>

Progress:
- [x] <AC line 1> -- <evidence>
- [ ] <AC line 2> -- <status or blocker>

Next: <concrete next action>
EOF
)"
```

**Progress trailer contract:** `Next:` MUST be the last paragraph of
the commit body (git trailer, git 2.32+). Do not add paragraphs after
`Next:` — they silently displace it.

## Steps

### Step 1 — Pre-flight checks

Run Preconditions block against the issue. Fail-fast on any violation.

### Step 2 — Launch

Invoke `afk workflow run --iid <iid>`. The command returns when
goal completes (pass or fail), times out, or exits with error.

### Step 3 — Methodology load (mandatory, before any code)

Before writing any code:
1. Read `references/README.md`
2. Read the corresponding `references/<type>.md`
3. Read `references/hard-checks.md`
4. Conditional reads per the Routing table

### Step 4 — Takeover (human-in-the-loop, optional)

```bash
tmux attach -t afk \; select-window -t <window>
```

Before touching anything: `git log --oneline -5` in the worktree. The
`Next:` line outranks any guess. Then `/goal pause`, manual work,
`/goal resume`, detach (`ctrl-b d`).

### Step 5 — Escalation on repeated failure

After exhausting retries, agent sets label `mode::hitl` and exits.
Attach, read the last `Next:` line, decide:
- **Extend budget** — re-run with higher retry count
- **Correct course** — manually fix and add a fresh WIP commit
- **Escalate** — already done; remove `mode::hitl` only when ready to resume

## Common failure modes

- **Target branch moved:** agent rebases before opening MR.
- **Flaky vs. real failure:** different errors on two consecutive attempts
  → flaky, rerun. Identical failure twice → fix the cause.
- **Self-reported completion is not evidence:** if Progress checklist
  does not show every AC line with evidence, MUST NOT proceed to MR.
- **Secrets discipline:** a secret in a WIP commit is unrecoverable —
  never read credential files beyond `.env.fork`.

## Anti-patterns

- MUST NOT hand-write a `while true; do claude -p ...; done` loop.
- MUST NOT bypass `afk workflow run` and reimplement its steps in bash.
- MUST NOT push directly to a protected branch — MR only.
- MUST NOT treat GitLab comments as the sole progress record — WIP
  commit `Next:` trailer is the real handoff document.
- MUST NOT squash/rewrite WIP commit history before MR.
- MUST NOT skip Step 3 — TDD methodology is not optional.
- MUST NOT delete remote branches — remote history is the audit trail.
- MUST NOT leave a tmux session hanging without idle detection.
- MUST NOT write an empty `Next:` trailer.
