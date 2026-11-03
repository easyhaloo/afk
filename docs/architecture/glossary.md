# AFK Domain Glossary

This glossary defines the terms used by current AFK architecture documentation. Runtime behavior and supported commands are determined by the current source code and tests; this page provides concise shared terminology rather than a substitute for implementation details.

## Work items and identity

- **Work item** — A task created and decomposed by an upstream planning or backlog system. AFK consumes it for execution; it does not own requirements decomposition.
- **Canonical work-item ID** — The provider-qualified identity used across provider records, runtime events, CLI, and Desktop projections, for example `github:acme/api#42`.
- **Execution attempt** — One attempt to execute a work item. `runId` / `executionId` identify an execution record according to the calling workflow; neither replaces the canonical work-item ID.
- **`parentId`** — Organizes work items into a parent-child hierarchy. A parent is a container, not an executable child task.
- **`dependsOn`** — Declares prerequisite work items. Dependencies must reach `done` before the dependent item is eligible.
- **`baseBacklogId`** — References a work item used to select or trace an execution baseline. It is distinct from parent-child and dependency relationships.

## Execution and lifecycle

- **BacklogProvider** — The port through which AFK reads and updates provider-backed work items and their business lifecycle. Provider state is authoritative for backlog status.
- **WorkflowRunner** — Executes the implementation workflow for a claimed work item, coordinating workflow steps and runtime resources. See `packages/runtime/src/application/workflow-engine.ts`.
- **`executeWorkItem`** — The managed work-item path that coordinates eligibility/manifest checks, implementation, independent QA, change-request handling, and the human merge gate. See `packages/runtime/src/application/workflows/execute-work-item.ts`.
- **LoopRunner** — Repeatedly polls and delegates execution for a manifest-bound work item. It is not a global scheduler for arbitrary backlog items. See `packages/runtime/src/application/runners/loop-runner.ts`.
- **QARunner** — Performs independent QA after implementation; an agent's completion claim is not itself QA evidence.
- **Change request** — A provider-hosted pull/merge request used to review the proposed change. Publishing it does not mean the work item is complete.
- **`merge_ready`** — The change is ready for a human merge decision. It is not equivalent to `done`.
- **`done`** — The merge outcome has been confirmed through the provider-backed lifecycle.
- **`blocked + hitl`** — Automated execution cannot safely continue and requires human intervention.
- **Human merge gate** — The explicit boundary where a person decides whether to merge. AFK does not autonomously make the final merge decision.

## Runtime state and evidence

- **Runtime record** — Execution-attempt state such as phase, heartbeat, progress, and diagnostics. It is not the authoritative backlog state.
- **Run event / audit event** — An append-only record of execution facts, used for traceability and diagnosis. Events cannot prove outputs that were never recorded.
- **Evidence reference** — A reference to stored evidence used by QA or diagnosis. Evidence and logs should follow the project's redaction and data-governance rules.
- **Worker launch receipt** — Desktop metadata that records whether a Worker was launched. It does not prove that execution or QA completed.
- **Claim / lease** — The mechanism used to establish and track execution ownership. A local filesystem lease is a single-host mechanism, not distributed multi-host consensus.
- **Fail closed** — When required identity, claim, state, or verification evidence is uncertain or invalid, stop safely rather than assume success or continue with an unsafe side effect.

## Packages

- **`@afk/core`** — Domain models, events, reducers, policies, and ports without Node/Electron application dependencies.
- **`@afk/application`** — Shared use cases and application-level queries built on Core.
- **`@afk/runtime`** — Execution orchestration and infrastructure adapters for providers, Git, agents/sandboxes, and persistence.
- **`@afk/workflow-graph`** — Workflow graph representation, projection, layout, and validation.
