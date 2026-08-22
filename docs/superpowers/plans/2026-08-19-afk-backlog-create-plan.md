# AFK Backlog Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single-item `afk backlog create` command that creates a provider-backed backlog item and records optional parent and dependency relationships, then update the PRD and issue skills to use it.

**Architecture:** Reuse the existing `TrackerProvider.createIssue`, `updateIssue`, `getIssue`, and `linkIssues` seams. The CLI will encode AFK lifecycle metadata, parent, dependency, and business tags as labels because the existing backlog adapter already parses those labels. Dependency links will also be sent through the provider link seam when requested. Skills remain HITL-gated: PRD approval creates one root backlog; issue approval creates children one at a time using the returned IDs and URLs. Created descriptions include clickable parent/dependency URLs and are updated with the new item's own URL after creation.

**Tech Stack:** TypeScript, Commander, Vitest, GitHub/GitLab tracker adapters, Markdown skills.

---

### Task 1: Define the backlog-create contract with failing tests

**Files:**
- Modify: `src/commands/backlog.test.ts`
- Modify: `src/lib/backlog/commands.test.ts` (create if absent)

- [ ] **Step 1: Add command registration and validation tests**

Cover the `create` subcommand, required title, description input, `--parent`, repeatable `--depends-on`, `--mode`, and `--tag` options. Assert invalid mode/tag/id input fails before provider mutation.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `npm test -- src/commands/backlog.test.ts src/lib/backlog/commands.test.ts`

Expected: FAIL because no create command/helper exists.

### Task 2: Implement provider-backed single backlog creation

**Files:**
- Modify: `src/lib/core/backlog/index.ts`
- Modify: `src/lib/core/backlog/management-provider.ts`
- Modify: `src/lib/backlog/commands.ts`
- Modify: `src/commands/backlog.ts`

- [ ] **Step 1: Add the creation input and management-provider operation**

Add a `BacklogCreateInput` containing title, description, execution mode, business tags, parent ID, and dependency IDs. Add `create` to the management interface/facade and implement it through the underlying tracker provider.

- [ ] **Step 2: Encode AFK metadata, relationships, and traceable links**

Create the issue with the ready state label, selected execution mode label, validated business tags, `parent::<id>`, and `depends-on::<id>` labels. Validate parent/dependency IDs as positive provider IDs and reject self-dependencies. Resolve parent/dependency URLs before creation and append them to a `Backlog Links` section in the description. For each dependency, call `linkIssues(newId, dependencyId, 'blocked_by')` after creation. Re-read the new item, append its own returned `webUrl` to the description with `updateIssue`, then return the created item and URL.

- [ ] **Step 3: Add the Commander command**

Add `afk backlog create <title>` with `--description-file <path>` or stdin, repeatable `--depends-on <id>`, optional `--parent <id>`, `--mode <afk|hitl>`, repeatable `--tag <tag>`, and `--project <project>`. Print the canonical ID and concrete `webUrl`, plus relationship metadata. Route errors through existing CLI utilities.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `npm test -- src/commands/backlog.test.ts src/lib/backlog/commands.test.ts src/lib/core/backlog/provider.test.ts`

Expected: PASS.

### Task 3: Add relationship and provider regression coverage

**Files:**
- Modify: `src/lib/core/backlog/provider.test.ts`
- Modify: `src/commands/backlog.test.ts`

- [ ] **Step 1: Test parent/dependency parsing after creation**

Use the in-memory/provider seam to assert the created item exposes `parentId`, `dependsOn`, `ready`, and the requested execution mode.

- [ ] **Step 2: Test dependency link calls**

Use a tracker fake to assert each `--depends-on` ID results in one `blocked_by` link, parent/dependency URLs are present in the body, the created item's own URL is written back, and a failed link reports an actionable error.

- [ ] **Step 3: Test CLI description handling**

Cover file input, stdin input, and empty description rejection without making a provider call.

- [ ] **Step 4: Run the focused suite**

Run: `npm test -- src/commands/backlog.test.ts src/lib/backlog/commands.test.ts src/lib/core/backlog/provider.test.ts`

Expected: PASS.

### Task 4: Update the PRD skill to create the root backlog

**Files:**
- Modify: `skills/afk-to-prd/SKILL.md`
- Modify: `skills/README.md`
- Modify: `README.md`
- Modify: `README_zh.md`

- [ ] **Step 1: Replace the provider-neutral end state**

Keep drafting and explicit approval, then require `afk backlog create` with the approved PRD as description input. Record and return both the root backlog ID and its concrete `webUrl`; state that both values are the parent reference for downstream issue items.

- [ ] **Step 2: Document the exact CLI contract**

Show a safe command pattern using `--description-file`, `--mode hitl`, and a business tag such as `prd`. State that creation must happen only after approval, that the returned ID and URL must be recorded, and that the skill must not call provider APIs directly.

### Task 5: Update the issues skill to create child backlogs

**Files:**
- Modify: `skills/afk-to-issues/SKILL.md`
- Modify: `skills/afk-to-issues/references/issue-template.md`

- [ ] **Step 1: Replace manifest-only handoff language**

Retain decomposition, evidence inference, DAG validation, and HITL approval, but require one `afk backlog create` invocation per approved item.

- [ ] **Step 2: Define ID resolution and creation order**

Create parent/root-independent items first, record returned IDs and URLs by stable task reference, then create dependent children with `--parent` and `--depends-on` using canonical IDs. Ensure each child description embeds the PRD URL, parent URL, and dependency URLs. Stop and report partial creation if a command fails; never invent IDs or bypass AFK.

- [ ] **Step 3: Preserve acceptance criteria in descriptions**

Specify the exact Markdown body passed via a temporary file, including PRD reference URL, context, acceptance criteria, out-of-scope, dependency notes, and the concrete links returned by AFK.

### Task 6: Verify the complete change

**Files:**
- None beyond the files above.

- [ ] **Step 1: Run typecheck and the full test suite**

Run: `npm run typecheck`

Run: `npm test`

Expected: both commands exit 0.

- [ ] **Step 2: Review the diff and skill contracts**

Confirm no skill still says the external provider creates records, no command example uses an unregistered `afk issue create`, and the CLI output exposes the canonical ID needed by the next agent step.
