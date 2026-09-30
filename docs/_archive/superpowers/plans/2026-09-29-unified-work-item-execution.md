# Unified Work Item Execution Implementation Plan

> **For agentic workers:** Implement in order. Use the repository's TDD and verification practices; do not modify existing user changes in the working tree. Checkboxes track progress, not permission to skip acceptance gates.

**Goal:** A managed work item has one user-facing start/retry flow, one execution lifecycle (implementation → independent QA → PR/MR publication or rework), and one correlated run history visible in Work Items, the Run Center, and the project Backlog.

**Architecture:** `BacklogProvider` remains authoritative for business state, dependencies, claiming, and change requests. A shared single-item execution use case orchestrates the existing `WorkflowRunner` and `QARunner`; the loop schedules the same use case, rather than owning a second implementation/QA chain. Durable `RunEvent` streams are the execution audit source. An Electron main-process query/launch façade projects those events into typed DTOs; renderer views never read the filesystem or infer outcomes from a child-process exit code.

**Tech Stack:** TypeScript, AFK CLI, GitHub/GitLab provider adapters, Electron IPC, React, Vitest, Playwright.

---

## Fixed product decisions

1. **One initiation surface:** Work Items detail owns Start and Retry. Project Backlog remains a planning/details view; its Start/Retry controls become links to the same Work Item. Run Center observes, stops, and links to the Work Item for retry. The sidebar's current “新建运行” opens Work Item selection; it must not spawn another runner.
2. **One identity:** `workItemId` is the canonical provider-qualified ID (for example, `github:easyhaloo/afk#158`), never the bare issue number. `BacklogItem.workItemId` is the join key; `providerRef`, project, and issue number are validated before executing. A managed item absent from the global inventory must report a diagnostic, not silently run using a guessed ID.
3. **One execution attempt:** each user start/retry gets a durable `executionId`; every implementation, QA, PR, and terminal event carries or is durably correlated with that attempt. An implementation `runId` is not automatically the execution ID. The desktop must not report “completed” solely because `afk run` exited with code 0: implementation success is followed by QA; QA PASS then publishes a PR/MR, root items await human merge, child items follow existing merge rules.
4. **One writer for state:** provider backlog/claim and the shared use case govern transitions. The desktop legacy `backlog-runs.json` and `work-item-runs.json` remain read-only during migration and are not a new source of business truth. The event store supplies verified new-run history; a small launch receipt/index may store `executionId`, child PID, workspace, and lifecycle reconciliation metadata, but cannot independently declare QA or PR success. Old records without matching audit evidence appear as clearly marked legacy records, not fabricated `RunEvent`s.
5. **One PR policy:** QA runner, not the implementer or UI, publishes after independent PASS; body stays two lines (`QA: PASS`, `Closes #<issue-number>`), with the exact provider issue reference resolved from the target repository. Store PR URL/ID in the provider change request and show it on both relevant projections. Do not copy the PRD into the PR.
6. **Compatibility:** CLI `afk run` is currently an implementation-level command, while `afk loop` schedules implementation plus QA. Do not silently change `afk run`'s published behavior. Add an explicit single-item orchestration entry (`afk execute --work-item-id ...` or an equivalently named command), then have desktop and loop call the *same use case*. Keep the old CLI command as an explicitly documented lower-level compatibility command until consumers migrate.

## Target interaction and statuses

```
Backlog: create / edit / dependencies / ready
    → Work Items: choose managed item, repository, branch, template; Start
    → executionId allocated; claim and launch receipt durably recorded
    → Run Center: queued → implementing → verifying → publishing
    → QA FAIL: rework / blocked; Work Item Retry creates a new executionId
    → QA PASS: PR/MR published, URL persisted, root awaits human merge
    → human merge confirmed: done
```

The status model distinguishes execution-attempt status (`queued | implementing | verifying | publishing | awaiting_merge | rework | blocked | failed | done`) from provider backlog state (`ready | in_progress | verification | merge_ready | rework | blocked | done`). Never overwrite historical attempts when the backlog state advances. Stop requests and crash recovery are separate transitions; no guessed “done” from a dead PID. If a stream fails integrity validation, show `unknown / audit error`, disable unsafe actions, and retain the last verified state.

## File ownership map

| Boundary | Existing files to change | New focused unit |
| --- | --- | --- |
| Shared lifecycle | `src/application/modules/loop-runner.ts`, `src/application/workflows/run-cmd.ts`, `src/cli/commands/run.ts`, `src/cli/command-registry.ts` | `src/application/workflows/execute-work-item.ts`, `src/cli/commands/execute.ts` |
| Audit / correlation | `src/application/workflow-engine.ts`, `src/core/events.ts`, `src/observability/query-service.ts`, `src/cli/commands/observe.ts` | `src/observability/work-item-execution-projection.ts` |
| Desktop typed boundary | `desktop-client/shared/backlog-contract.ts`, `desktop-client/shared/ipc-contract.ts`, `desktop-client/electron/preload.ts`, `desktop-client/electron/ipc/register-handlers.ts` | `desktop-client/electron/services/work-item-execution-query-service.ts` |
| Desktop launcher / migration | `desktop-client/electron/services/work-item-execution-service.ts`, `desktop-client/electron/services/backlog-execution-service.ts`, `desktop-client/electron/services/work-item-run-history-service.ts`, `desktop-client/electron/services/desktop-service.ts` | `desktop-client/electron/services/legacy-run-import-service.ts` |
| UI | `desktop-client/src/features/work-items/WorkItemsPage.tsx`, `desktop-client/src/features/backlog/BacklogPage.tsx`, `desktop-client/src/features/backlog/BacklogDetailDrawer.tsx`, `desktop-client/src/main.tsx` | A pure run presentation selector under `desktop-client/src/features/run-center/` |

Only add the new units if they keep a single responsibility. Keep bootstrap in `electron/main.ts`, IPC validation in `ipc/`, filesystem/process access in `services/` or `adapters/`, and shared DTOs free of Electron/Node/DOM imports. Use existing provider/Backlog semantics instead of putting GitHub-specific rules in React.

## Phase 0 — Freeze behavior and add characterization tests

### Task 1: Capture the current split without changing behavior

**Tests:** `desktop-client/tests/electron/work-item-execution-service.test.ts`, `desktop-client/tests/electron/backlog-execution-service.test.ts`, `desktop-client/tests/run-center-presentation.test.ts`, `src/cli/commands/run.test.ts`.

- [ ] Add tests demonstrating: Work Item start builds `afk run --backlog-id <workItemId>` with an execution manifest; Backlog start builds `afk loop --backlog-id <backlogId> --max-iterations 1`; the desktop snapshot includes work-item runs but not backlog-run summaries; zero exit from `afk run` is *not* sufficient evidence of QA PASS/PR creation.
- [ ] Run `pnpm --dir desktop-client test -- tests/electron/work-item-execution-service.test.ts tests/electron/backlog-execution-service.test.ts tests/run-center-presentation.test.ts` and `pnpm exec vitest run src/cli/commands/run.test.ts`. Expect PASS for characterization tests.
- [ ] Record a small fixture with one provider-qualified Issue, two repository selections, an old Backlog run, an old Work Item run, and a pre-existing PR. Use this fixture in subsequent tests; never test against the live provider or real Git remotes.

**Gate:** the legacy behavior is measurable before deleting a path.

## Phase 1 — Canonical execution contract

### Task 2: Define identity, attempt, and read-model contracts

**Files:** `desktop-client/shared/backlog-contract.ts`, `desktop-client/shared/ipc-contract.ts`, `src/core/events.ts`, `src/observability/work-item-execution-projection.ts`.
**Tests:** `desktop-client/tests/shared/backlog-contract.test.ts`, a new `src/observability/work-item-execution-projection.test.ts`.

- [ ] First add failing parsing and projection tests for a canonical ID, incomplete/foreign repository identity, duplicate launch, QA rework, QA PASS with PR URL, root awaiting merge, child done, and invalid event hash. Explicitly test that `#158` in a different repository is *not* the same work item.
- [ ] Define a typed read model analogous to:

  ```ts
  type ExecutionSummary = {
    executionId: string;
    workItemId: WorkItemId;
    project: ProviderProjectRef;
    status: 'queued' | 'implementing' | 'verifying' | 'publishing'
      | 'awaiting_merge' | 'rework' | 'blocked' | 'failed' | 'done' | 'unknown';
    startedAt: string;
    updatedAt: string;
    workspacePath?: string;
    pr?: { id: string; url: string; state: 'open' | 'merged' | 'closed' };
    diagnostic?: string;
  };
  ```

- [ ] Make the CLI/event correlation explicit (`executionId` on the event context or a versioned correlation mapping). Define how an implementation `runId`, a QA run, and publication share this ID. If changing event serialization, add a backward-compatible reader for version-1 events; do not rewrite signed/hash-chained historical records.
- [ ] Verify the audit mode is enabled for this flow; the current workflow observer can log and continue after a recording failure. Make failure before claim/publish/merge fail closed, then test the failed-write path. Do not promise an authoritative history while observation is disabled.
- [ ] Make the pure projection deterministic: timestamp and event ordering, terminal-state precedence, unknown-event handling, integrity-failure behavior. Run focused unit tests; expect PASS.

**Gate:** Work Item detail, Backlog detail, and Run Center can all consume the *same* typed summary without joining by title or bare issue number.

## Phase 2 — Single-item orchestration shared with the loop

### Task 3: Extract implement → QA → publication into one use case

**Files:** new `src/application/workflows/execute-work-item.ts`; modify `src/application/modules/loop-runner.ts`, `src/application/workflows/run-cmd.ts`, `src/cli/commands/execute.ts`, `src/cli/command-registry.ts`.
**Tests:** new `src/application/workflows/execute-work-item.test.ts`, `src/application/modules/loop-runner.test.ts`, a new `src/cli/commands/execute.test.ts`.

- [ ] Start with failing unit tests for `executeWorkItem({ workItemId, executionId, manifestPath, template, project })`: reject unmanaged/HITL/not-ready items or unmet dependencies *before* preparing an execution workspace; claim exactly once; run implementation once; enqueue independent QA only after implementation success; let existing QA runner publish only on PASS; keep root PR open for a human; preserve child merge policy; route FAIL to rework/blocked. A second concurrent start must reuse/reject the active attempt, not spawn a second process.
- [ ] Extract only lifecycle sequencing and claim ownership from the loop into the use case. The loop remains a scheduler (polling, concurrency, queues, shutdown); `afk run` remains a documented lower-level compatibility command. Use the new orchestration entry for desktop single-item runs. Avoid a `loop --max-iterations 1` shortcut: that flag counts successful completions and does not define one attempt's terminal state.
- [ ] Persist intent and each externally visible transition before side effects; if audit persistence fails, stop before publishing or merging. Record the provider's change-request ID/URL after QA PASS; an existing PR matching the same work item/branch must be reused or reported, never silently duplicated.
- [ ] Run `pnpm exec vitest run src/application/workflows/execute-work-item.test.ts src/application/modules/loop-runner.test.ts src/cli/commands/execute.test.ts src/cli/commands/run.test.ts`. Expect PASS, including independent QA and PR-publication fakes.

**Gate:** the desktop and scheduler exercise one implementation/QA sequence; execution status does not become “done” at implementation exit.

### Task 4: Expose auditable run queries

**Files:** `src/observability/query-service.ts`, `src/cli/commands/observe.ts`, `src/observability/work-item-execution-projection.ts`.
**Tests:** new focused query/CLI tests next to these files.

- [ ] Add a query filtered by canonical `workItemId`, with pagination/limit and optional `since` cursor; return execution summaries plus a selected attempt's verified timeline. Do not make Electron scan every historical JSONL file on each refresh.
- [ ] Test restart and partial-write scenarios: missing stream, corrupt hash, launch receipt before first event, implementation success while QA pending, stale process after app restart, and unavailable provider. Preserve a verified partial timeline with an explicit diagnostic; never infer QA PASS from PID or process exit.
- [ ] Run focused `src/observability` and CLI observe tests; expect PASS.

**Gate:** querying the same `executionId` twice after restart yields the same status and timeline.

## Phase 3 — Desktop integration without a second writer

### Task 5: Replace launch APIs with one validated IPC façade

**Files:** `desktop-client/shared/ipc-contract.ts`, `desktop-client/electron/preload.ts`, `desktop-client/electron/ipc/register-handlers.ts`, `desktop-client/electron/services/work-item-execution-service.ts`, new `desktop-client/electron/services/work-item-execution-query-service.ts`.
**Tests:** `desktop-client/tests/electron/work-item-execution-service.test.ts`, `desktop-client/tests/electron/work-item-execution-service.integration.test.ts`, new focused IPC/query tests.

- [ ] Add failing tests for `workItems.start`, `workItems.retry`, `workItems.runs`, `workItems.timeline`, `workItems.stop` with validated canonical IDs, repository selections, sender origin, argument size, and immutable execution ID. Test two windows, two clicks, app restart, subprocess spawn failure, and permission denial.
- [ ] Keep workspace allocation and execution-manifest validation in the existing service, behind a durable cross-process launch reservation keyed by `workItemId`. Launch the new single-item orchestration entry, not `afk run` or `afk loop` directly; the provider claim remains the ultimate execution lock. Persist a launch receipt before reporting success; return `executionId`, not a synthetic child-process “completed” status. A rejected claim must release the reservation without executing workspace work.
- [ ] Route stop/retry through explicit semantics: stop only an active attempt and record cancellation; retry only after terminal rework/blocked/failed and through provider-approved transitions. Preserve prior attempts and PR links. Renderer must never kill a raw PID.
- [ ] Expose a query DTO through the typed preload whitelist. Run `pnpm --dir desktop-client test -- tests/electron/work-item-execution-service.test.ts tests/electron/work-item-execution-service.integration.test.ts` and `pnpm --dir desktop-client typecheck`; expect PASS.

**Gate:** no page can start a run through a different Electron handler, even if the old IPC channel is invoked manually.

### Task 6: Import legacy runs safely; turn off the second writer

**Files:** new `desktop-client/electron/services/legacy-run-import-service.ts`; modify `desktop-client/electron/services/backlog-execution-service.ts`, `desktop-client/electron/services/backlog-runtime-service.ts`, `desktop-client/electron/services/work-item-run-history-service.ts`, `desktop-client/electron/services/desktop-service.ts`, `desktop-client/electron/ipc/register-handlers.ts`.
**Tests:** new `desktop-client/tests/electron/legacy-run-import-service.test.ts`, existing backlog and work-item history tests.

- [ ] Test read-only import of both `.afk/backlog-runs.json` and `.afk/work-item-runs.json`. Deduplicate only with a verified event/launch correlation. Ambiguous records remain visible as `legacy / unlinked` with original IDs and paths; they must not become a second active run or be associated by issue number alone. Never synthesize signed audit events from a PID or an old desktop summary.
- [ ] Add a versioned, restart-safe migration marker or deterministic import key; retain original JSON files untouched and readable. Import can be rerun without duplicate history. Reconcile running legacy PIDs only when proven to belong to the recorded attempt; otherwise show `unknown` and require inspection.
- [ ] Remove desktop writes to `backlog-runs.json` and the work-item status writer *after* projection parity is verified. Backlog start/retry IPC must be removed or return a typed `USE_WORK_ITEM_EXECUTION` error while older renderer builds may still call it; never delegate invisibly to a second spawn path.
- [ ] Run `pnpm --dir desktop-client test -- tests/electron/legacy-run-import-service.test.ts tests/electron/backlog-execution-service.test.ts tests/electron/work-item-run-history-service.test.ts`; expect PASS.

**Gate:** a seeded old profile retains its visible history and starts only one new run through Work Items.

## Phase 4 — One UI flow, three consistent projections

### Task 7: Work Items becomes the only start/retry surface

**Files:** `desktop-client/src/features/work-items/WorkItemsPage.tsx`, `desktop-client/src/main.tsx`.
**Tests:** `desktop-client/tests/work-items-page.test.tsx`, `desktop-client/tests/e2e/work-items-global.spec.ts`.

- [ ] Add failing interaction tests for enabled Start only on a managed eligible item, dependency/branch validation, repository selection, double-click protection, immediate “queued” acknowledgement, stage updates, previous-attempt history, retry after permitted failure, and PR URL after QA PASS. Show why an item is ineligible instead of a dead button.
- [ ] On start, navigate to its Run Center entry by `executionId` or keep the Work Item detail open with a run link. Existing “新建运行” must open the Work Item picker; it must not start an empty run. Refresh only the changed item/run, with a bounded polling or subscription lifecycle while active.
- [ ] Run the focused component and E2E tests; expect PASS.

### Task 8: Backlog becomes planning-only; Run Center becomes the execution projection

**Files:** `desktop-client/src/features/backlog/BacklogPage.tsx`, `desktop-client/src/features/backlog/BacklogDetailDrawer.tsx`, `desktop-client/src/main.tsx`, a pure selector in `desktop-client/src/features/run-center/`.
**Tests:** `desktop-client/tests/backlog-page.test.tsx`, `desktop-client/tests/run-center-presentation.test.ts`, `desktop-client/tests/e2e/backlog-execution-loop.spec.ts` (replace its old dual-launch assertion).

- [ ] Backlog tests: show dependencies/state/PR; replace Start/Retry with “在工作项中执行” using canonical `workItemId`; if absent, show a diagnostic and no runnable action. Keep planning operations such as tags, create, and dependency views.
- [ ] Run Center tests: query unified summaries, group by `executionId` and status, show implementation→QA→PR timeline, open PR and source Work Item, stop active run, send retry to Work Item detail. Navigate into Run Center from a just-started Work Item and see that same execution without requiring app restart. Scope by project without hiding a run allocated to a task workspace.
- [ ] Stop deriving business status from raw `.afk/runs/events.jsonl` or mixing unrelated events into run cards. Keep raw events under Activity as diagnostics. Run focused UI and E2E tests; expect PASS.

**Gate:** a single Issue has one active attempt and one history in all three views; a PR URL is identical wherever shown.

## Phase 5 — Provider PR association, verification, release

### Task 9: Verify publication and issue association end to end

**Files:** provider change-request adapter/tests under `src/infrastructure/tracker/changes/`, `skills/afk-qa/SKILL.md` only if the behavior differs from its existing two-line contract, and desktop change-request DTO projections as needed.
**Tests:** provider adapter unit tests, QA runner tests, `desktop-client/tests/e2e/work-items-global.spec.ts` with a fake provider.

- [ ] Test same-repository issue reference, cross-repository/multi-repository PR target, existing open PR, failed publish, QA FAIL, human merge gate, and child auto-merge. Require a provider-confirmed change-request ID and URL before showing “PR 已提交”. Do not infer association from title, branch name, or a locally formatted body alone.
- [ ] Ensure the body stays exactly `QA: PASS\nCloses #<issue-number>` for a same-repository GitHub issue; when cross-repository linking is needed, resolve the provider's valid full issue reference and test it rather than using an ambiguous bare number. The PR body must not contain the PRD.
- [ ] Run `pnpm exec vitest run src/infrastructure/tracker/changes src/application/modules/qa-runner.test.ts`; expect PASS.

### Task 10: CI, documentation, and phased cutover

**Files:** `docs/` user workflow docs, `desktop-client/` test fixtures, `.github/workflows/ci.yml` only if independent desktop jobs are absent.

- [ ] Document the product flow and compatibility note for existing `afk run` users. Update screenshots/help text so no second Start/Retry surface is promised. Record provider-offline and migration diagnostics in the troubleshooting guide.
- [ ] Run in order: focused tests above; `pnpm --dir desktop-client typecheck`; `pnpm --dir desktop-client build`; `pnpm --dir desktop-client test`; root `pnpm typecheck`; root `pnpm exec vitest run`; applicable Playwright tests. Expect all changed paths to pass; report unrelated pre-existing failures separately.
- [ ] Stage rollout behind a single desktop configuration switch if needed: first read-only unified projection with parity checks, then unified launch, then remove old handlers/UI, finally remove obsolete writers after migration coverage. Roll back by disabling new launch and preserving both old files and event streams; never roll back by deleting audit data.
- [ ] Final manual acceptance on a test repository: create/choose a ready managed Issue; launch once; observe implementation and QA; verify exactly one PR with minimal body and correct Issue association; restart during an active run; retry a failed attempt; confirm all three views and old-run import match.

**Release gate:** no duplicate launch, no false QA PASS, no lost legacy history, no unlinked PR displayed as linked, no root auto-merge, and no independent Backlog execution control remain.

## Implementation checkpoint (2026-09-29)

- Implemented: Work Items single-item launch and retry, Backlog navigation instead of a second Start/Retry, canonical execution IDs, required append-only audit, implementation → QA → provider-verified Issue association → PR, conservative attempt locking, and explicit managed single-item loop mode.
- Verified: focused core tests, desktop typecheck/build and full unit suite, root typecheck/build, and the Work Items/Backlog navigation Electron E2E tests. Root full suite still has unrelated configuration-environment expectations and an outdated desktop packaging-script assertion.
- Remaining before release: connect read-only legacy import to a single history projection, paginate Run Center without scanning every audit stream on each refresh, reconcile a root PR after human merge into its audit stream, and perform provider-backed manual acceptance in a test repository. The full `afk loop` polling queue intentionally remains on its legacy path until each item has a trustworthy execution manifest.

### Follow-up checkpoint (2026-09-29)

- Read-only legacy records now appear alongside audited attempts in Work Items and Run Center, with explicit legacy provenance and no inferred QA PASS; ambiguous associations remain unlinked.
- Execution-summary queries use a rebuildable file-metadata index, avoiding full stream verification on every refresh. Root PR reconciliation is explicit via `afk reconcile --work-item-id ... --execution-manifest ... --execution-id ...`: it verifies Provider merge, PR identity and Issue association, then appends a merge audit event. The publication-intent journal plus Provider readback permits recovery from publication and backlog-transition crash windows; missing intent/identity remains a diagnostic, never a guessed PR link.
- Root and desktop typecheck/build, focused tests, desktop unit suite, and selected Electron E2E passed. The root full suite retains eight unrelated pre-existing failures described above. Provider-backed manual acceptance remains **not performed**; do not treat mocked integration tests as release sign-off. The full `afk loop` polling queue remains on its legacy path by design.

## Out of scope

- Rewriting the provider Backlog domain into a desktop-only store.
- Replacing the existing global Work Item inventory or introducing a third issue catalogue.
- Automatically merging root PRs or bypassing independent QA.
- Guessing a mapping for old attempts whose provider/workspace/stream identity cannot be verified.
- Reworking unrelated desktop UI, SSH, agents, or the workflow-template editor.
