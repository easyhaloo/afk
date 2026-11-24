---
name: afk-qa
disable-model-invocation: true
description: >-
  Use when a backlog item is in verification and needs independent
  Acceptance Criteria checks before the QA runner publishes its PR/MR.
disallowed-tools: >-
  Bash(git reset --hard*) Bash(git branch -D*)
---

# QA

**Goal:** independently verify a `verification` backlog item against its
Acceptance Criteria. On PASS, the QA runner publishes the provider PR/MR;
root backlog changes await human merge, while child changes may auto-merge.
**Mode:** AFK verification; FAIL routes to rework or canonical `blocked`
with `executionMode: hitl`.

**Architecture:** the provider maps each backlog ID to its implementation
branch. The QA runner integrates the latest baseline, verifies AC, then
commits and pushes the QA branch before creating the PR/MR. The QA agent
must not open or merge a change itself.

## Two merge gates

| Gate | Who | What | When |
|------|-----|------|------|
| AFK gate | QA runner | Create the provider PR/MR; merge child changes | After QA PASS |
| Human gate | Human | Merge a root backlog PR/MR | After QA PASS |

## Preconditions

- Backlog is in `verification` with a pushed implementation branch and
  Acceptance Criteria. The PR/MR does not need to exist yet.
- The configured target branch must be safe to integrate; if it is a
  protected release branch, STOP.

## Merge-order gate

Backlog dependencies define merge order. Before approving:
- **All `dependsOn` backlogs are `done`** → proceed to QA.
- **Any dependency incomplete** → do not publish; leave the item in
  `verification` and report the dependency.

## Signal vs. noise

- **Flaky checks:** fail on retry with no code change → note as flaky,
  move on. MUST NOT silently retry until green.
- **Non-functional AC:** "P95 < 200ms" without tooling → fail, not pass.
- **Local-only evidence:** a passing local grep or unit test proves nothing about
  the deployed artifact → it does not open the environment verification gate.
- **Self-report bias:** implementing agent's checklist is a hypothesis,
  not a substitute for independent re-run.

## Steps

### Step 1 — Read implementation branch + AC

Read the implementation branch and the backlog's AC — the checklist,
not code-review taste. Confirm its `dependsOn` entries and `verification`
state through `afk backlog show --id <id>`.

### Step 2 — Run AC checks fresh

Re-run every AC command/check independently. Do not trust the
implementing agent's self-report. Use CI evidence when available, but verify
the AC independently in the QA worktree.

### Step 3 — Record per-line results

Report the evidence in separated fields; the runner renders each one into its
own section of the change request.

- `summary` — one sentence stating the verdict. Do not repeat the individual
  test results there; they belong in `requiredChecks`.
- `observations` — one entry per behavioural acceptance criterion, each with
  the claim and how it was observed.
- `requiredChecks` — one entry per acceptance criterion you re-ran, with the
  command, what it was expected to show, and what it actually showed. The
  actual outcome belongs next to the expectation, not in the summary.
- `notes` — environment facts, tooling caveats, and anything that is not
  acceptance evidence. A reviewer must be able to tell a caveat from a
  result without reading around it.

If binary evidence was generated, write paths to `.afk/artifacts.txt`
(one absolute path per line). The runner uploads every listed file to the
provider and links it from the change request; a run without that manifest
publishes no attachments and says so in the runtime record.

### Environment verification gate (环境验证门禁)

This gate runs before Step 4 and is fail-closed: without environment evidence,
the change request does not exist.

**Trigger.** The implementation branch carries a deployable artifact (image tag
or artifact version) — the change affects a deployable service. A change that
declares itself non-deployable (library, documentation, config-only) skips this
gate and says so in `notes`.

**Evidence needed — every element:**

- environment identity — which test environment (测试环境), and its address;
- the artifact tag / version observed in that environment;
- the assertion that was run — endpoint, page, log, or probe;
- the raw observed output — response body, log excerpt, probe result;
- the repository path that stores that output.

**Decision:**

- All elements present and observed on test → PASS may proceed to Step 4.
- Any element missing → **do not create the PR/MR**. Return a structured FAIL
  result naming the missing element; the runner creates a rework record, or
  routes the item to `blocked` with `executionMode: hitl` and the retry
  condition stated — which environment, which artifact, what has to return.
  (缺证据 ⇒ 不创建 PR/MR ⇒ blocked/rework)

**MUST NOT:**

- accept a local grep, unit test, or local run as environment verification — it
  proves the code runs on one machine, not that it runs when deployed;
- accept evidence that lives outside the repository (scratch file, local log
  path) — ask for it to be stored in the repository and registered;
- collect evidence from pre-production or production. **Test only.** Reaching
  those environments is a human action (manual CI console, manual deploy) and an
  agent MUST NOT trigger it by any route.

Environment evidence travels through the existing artifacts channel: list the
stored evidence files in `.afk/artifacts.txt`, and the runner attaches them to
the `## Verification Evidence` section it appends to the change request. The
agent does not write that section and does not open a second evidence channel.

### Step 4 — Publish on PASS

1. Return an explicit `goal_complete` payload with `kind: qa, result: PASS`.
2. The QA runner commits and pushes the QA branch, then creates the PR/MR.
   Its body starts with exactly two lines; do not copy the PRD or write a
   long summary:

   ```text
   QA: PASS
   Closes #<backlog-id>
   ```

   The runner appends a `## Verification Evidence` section below those two
   lines with the per-AC results and the uploaded artifacts. The agent does
   not write that section, and does not put evidence into the two lines.

3. The runner transitions the backlog to `merge_ready`. A root backlog moves
   to `executionMode: hitl` for human merge; a child change is merged by the
   runner and transitions to `done`.

### Step 5 — Conflict during merge

Report the conflict from QA baseline integration or child merge. Do not
publish a PR/MR if baseline integration fails. If a child merge fails after
publication, report the existing PR/MR. The runner routes the backlog to
`blocked` with `executionMode: hitl`.

### Step 6 — Any AC fail

Do not publish or merge. Return a structured FAIL result with evidence;
the runner creates a rework record, or routes execution failures to
`blocked` with `executionMode: hitl`.

## Final human gate

After QA PASS on a root backlog, a human reviews and merges its PR/MR.
Always HITL — no automation bypasses this merge gate.

## Caveats

- MUST NOT publish a PR/MR on "looks reasonable" — every AC line needs evidence.
- MUST NOT publish a PR/MR for a deployable change without test-environment
  evidence — the environment verification gate above is fail-closed.
- MUST NOT merge a root change or one targeting a protected release branch directly.
- MUST NOT merge if any `dependsOn` backlog is incomplete.
- MUST NOT copy the backlog/PRD body into the PR/MR description.
- MUST NOT skip the final human gate.
