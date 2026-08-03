# Skills In-Depth Guide

This document details the design philosophy, purpose, triggering scenarios, workflows, and design decisions of the AFK Skills system.

## Skills System Overview

Skills are reusable workflow templates for Claude Code. Each skill encapsulates best practices for specific scenarios. AFK Skills focus on automating software development workflows, from requirements analysis to code implementation and testing.

### Design Philosophy

1. **Single Responsibility** — Each skill solves one category of problems, avoiding feature overlap
2. **Explicit Triggers** — `description` is the only trigger carrier. Loaded at startup for skill matching. Body loads only after activation.
3. **Verifiable Workflows** — Quality assurance through Signal mechanisms and AC checks
4. **Methodology Integration** — Built-in best practices like TDD and DDD

### Skills Invocation Relationships

```
User Request
    ↓
/afk-grill-me ────→ Requirements Clarification ────→ CONTEXT.md
    ↑
/afk-grill-me-context ──→ Follow-up Questions Based on Existing Materials
    ↓
/afk-to-prd ───────────→ Synthesize PRD ────→ PRD.md
    ↓
/afk-to-issues ────────→ Break Down into Issues ────→ tracker issues
    ↓
/afk-do ──────────→ Task Analysis
    │
    ├──→ /afk-research ──→ Research Existing Implementation
    │
    ├──→ /afk-prototype ─→ Validate Technical Approach
    │
    ├──→ /afk-implement ─→ TDD Implementation
    │         ↓
    │    Triggers After Completion
    │         ↓
    └──→ /afk-qa ────────→ Verify & Merge

/afk-pipeline ───────→ Stage Routing (navigate to correct skill)
/afk-scheduler ──────→ Multi-issue Dependency-aware Scheduling
/afk-branch-migrate ─→ Cross-branch Code Migration
/md-to-pdf ──────────→ Markdown to PDF
/reasoning-guard ────→ In-session Reasoning Path Guardian
/reasoning-watchdog ──→ Hooks-based Automatic Reasoning Monitor
/afk-skill-craft ────→ Skill Create / Diagnose / Refactor
```

## Core Skills Details

### 1. afk-grill-me

**Purpose:** Clarify requirements through multiple rounds of questioning, establish consensus

**Triggering Scenarios:**
- User's feature/Epic description is vague
- Requirements have multiple interpretations
- Acceptance criteria or constraints are missing

**Workflow:**
1. **Identify Topic** — Clarify the feature/Epic under discussion
2. **Multi-round Interview** — Use AskUserQuestion to gather information:
   - Audience — Who will use it?
   - Success Criteria — How to determine completion?
   - Non-goals — What is not included?
   - Constraints — Performance, security, compliance, budget limits
3. **Draft Summary** — Present CONTEXT.md (not yet saved)
4. **User Confirmation** — Approve / Revise / Follow-up Questions / Add Open Questions
5. **Save Document** — Write to `/tmp/grill-me-context-<timestamp>.md`

**Design Decisions:**

**Why an independent clarification skill?**
- Avoid discovering requirement misunderstandings during implementation, which is costly to rework
- Enforce expectation alignment before coding, reducing "built but not what I wanted" situations
- Produce traceable requirement documents (CONTEXT.md)

**Why use AskUserQuestion?**
- Structured questioning is more efficient than free-form dialogue
- User can answer multiple questions at once
- Ensures critical dimensions (Audience, Success, Non-goals) are not missed

**Why output to /tmp/ instead of the repo?**
- The grill-me phase may produce multiple iterative versions
- Avoid polluting git history
- User decides whether the final version goes into the repo

**Closure Conditions:**
- Each section has at least 1 falsifiable answer
- After 2 rounds of interviews with no new information, draft the document and mark outstanding items as Open Questions
- When conflicts exist, verbatim record them in Open Questions

**Collaboration with Other Skills:**
- **Output** → CONTEXT.md → **afk-prototype** uses as a prerequisite
- **Output** → Clarified requirements → **afk-do** breaks down into tasks

---

### 2. afk-do

**Purpose:** Analyze user requests, select appropriate methodology, orchestrate task execution

**Triggering Scenarios:**
- User provides a clear coding task (e.g., "add login", "fix bug")
- Need to complete a specific feature in the current session

**Workflow:**
1. **Workspace** — Current branch (default) or new worktree
2. **Load Methodology** — Read references/README.md, task type docs, hard-checks.md
3. **Identify Type** — Feature / Refactor / Hotfix / Spike / Research
4. **Make Plan** — Determine files to modify, acceptance criteria, affected tests
5. **Execute** — Follow methodology, commit at checkpoints
6. **Verify** — Run tests, compile, lint
7. **Complete** — Present results

**Design Decisions:**

**Why a task orchestration layer?**
- User descriptions are typically goals ("add login"), need to break down into executable steps
- Different task types have different flows: features need TDD, hotfixes emphasize speed, refactors require behavior preservation
- Unified entry point, avoiding user learning multiple skills

**Why dynamically load methodology documents?**
- Methodologies may evolve, avoid hardcoding flows in skill code
- references/ documents are the Single Source of Truth
- Support project-customized methodologies (override defaults in references/)

**Why distinguish task types?**
Different types have different risk points and flows:
- **Feature** — TDD red-green-refactor cycle, prioritize correctness
- **Refactor** — Fix tests first, then change structure, behavior unchanged
- **Hotfix** — Skip complex flows, prioritize speed, add tests afterward
- **Spike** — Time-boxed validation, code can be discarded
- **Research** — Research only, no implementation, output RESEARCH.md

**Commit Prefix Convention:**
```
feat:    — New feature/API/UI
fix:     — Bug fix
refactor: — Structural adjustment, behavior unchanged
hotfix:  — Production patch
spike:   — Feasibility exploration
wip:     — In-progress checkpoint
```

**Collaboration with Other Skills:**
- **Calls** → **afk-research** — When need to understand existing implementation patterns
- **Calls** → **afk-implement** — Actually execute each subtask
- **Calls** → **afk-prototype** — When technical risk is high, validate approach first
- **Prerequisite** ← **afk-grill-me** — Break down tasks after requirements are clear

---

### 3. afk-implement

**Purpose:** Execute a single well-defined implementation task, following TDD workflow

**Triggering Scenarios:**
- Subtask assigned by afk-do
- User directly specifies a clear implementation goal (less common)

**Workflow:**
1. **Prerequisite Check** — Verify AC exists, base label exists, no blocking dependencies
2. **TDD Cycle** — Red (write failing test) → Green (minimal implementation) → Refactor (optimize code)
3. **Progress Commit** — Commit once per complete cycle (wip: prefix)
4. **Final Verification** — Full test suite + hard-checks.md verification
5. **Signal Complete** — Write `.afk-signal.json`

**Design Decisions:**

**Why enforce TDD?**
- Test-first ensures correct requirement understanding
- Prevents over-engineering (only write code to satisfy tests)
- Refactoring has a safety net (tests unchanged, code optimized)
- Produces high test coverage, maintainable output

**Why use Signal mechanism?**
- Scheduler needs to know task completion status (success/failure/blocked)
- Cross tmux session communication (CLI polls .afk-signal.json)
- Supports async workflows (Scheduler doesn't block waiting)

**Why prerequisite checks?**
- AC doesn't exist → Cannot verify completion criteria
- Missing base label → Don't know target branch (prd/<N> or main)
- Has blocking dependencies → May depend on incomplete features, implementation will fail

**Progress Commit Strategy:**
```
wip: add user model (red)       — Test failing
wip: implement user model (green) — Test passing
wip: extract validation logic    — Refactor
feat(auth): add user model      — Final commit
```

**References Conditional Loading:**
Load different documents based on task type:
- DDD tasks → references/ddd.md
- Architecture changes → references/architecture.md
- Design decisions → references/adr.md

**Collaboration with Other Skills:**
- **Called** ← **afk-do** — Acts as execution engine
- **Output** → Signal → **afk-qa** — Triggers verification flow
- **Input** ← **afk-research** — Reference research results for implementation

---

### 4. afk-research

**Purpose:** Research existing code, systems, or technical approaches, output research report

**Triggering Scenarios:**
- Need to understand existing implementation patterns before coding
- Evaluate feasibility of new technical approaches
- Uncertain how a part of the system architecture works

**Workflow:**
1. **Define Scope** — Clarify: what to know, what not to know, key files
2. **Execute Research** — HITL mode: show findings, ask to continue/pivot. AFK mode: read, commit progress
3. **Synthesize Summary** — Write RESEARCH.md: background, findings, impact, open questions
4. **User Review** — Confirm findings meet requirements
5. **Save Document** — Write to disk, optionally post to issue (stage::research tag)

**Design Decisions:**

**Why distinguish Spike vs Research?**
- **Spike** — Answers "can it be done" (yes/no + evidence), time-boxed, output may be throwaway code
- **Research** — Answers "how it works" (components, relationships, questions), output is documentation, code unchanged

**Why support both HITL and AFK modes?**
- **HITL (Human-in-the-Loop)** — When scope is unknown, ask user after each finding whether to continue/adjust direction
- **AFK (Away From Keyboard)** — When scope is clear, complete autonomously, only commit progress at checkpoints

**Why prohibit product decisions?**
- Research only reports facts ("current implementation uses Redis"), doesn't make recommendations ("we should use Redis")
- Decision-making authority belongs to humans, avoid AI overstepping

**Why not exceed scope?**
- Research easily diverges, time gets out of control
- Clear boundaries ensure completion within budget

**Collaboration with Other Skills:**
- **Called** ← **afk-do** — When task requires understanding existing code
- **Output** → RESEARCH.md → **afk-implement** — Reference implementation patterns
- **Parallel** ↔ **afk-prototype** — Research understands system, Prototype validates approach

---

### 5. afk-qa

**Purpose:** Independently verify autonomous build output, check AC, decide whether to merge to prd/<N>

**Triggering Scenarios:**
- MR/PR marked as `stage::qa`
- Target branch is `prd/<N>` (not main)
- Associated issue contains machine-checkable AC

**Workflow:**
1. **Read MR/PR + AC** — Get acceptance criteria from associated issue
2. **Run Independent Checks** — Re-execute each AC command, don't trust implementer's self-report
3. **Record Results** — Each AC: pass/fail + evidence (command output/response snippet)
4. **Merge Decision** — All pass: approve and merge to prd/<N>; Any failure: don't merge, revert build
5. **Conflict Handling** — Conflict detected: try rebase, semantic conflict escalates to HITL
6. **Check Last One** — If this is the last MR in PRD, notify that final human gate can proceed

**Design Decisions:**

**Why independent verification?**
- Self-report bias: implementer's checklist is assumption, cannot replace independently re-running
- Prevent "looks reasonable" from passing, each AC needs evidence

**Why two merge gates?**
```
afk/issue-<iid> ──→ prd/<N> ──→ main
                  ↑          ↑
                AFK gate   Human gate
```
- **AFK gate (prd/<N>)** — Machine-verifiable AC, automated merge
- **Human gate (main)** — Overall business logic, UX, human review

**Why not directly merge to main?**
- main branch is production code, requires human review
- prd/<N> is integration branch, accumulates all issues for one PRD
- Separate automated verification (AC) from human review (business logic)

**Merge Order Gate:**
MR/PR description contains `## Merge Order` listing all `blocked_by` issues:
- All blockers merged → Continue
- Any blocker unmerged → Don't merge, stay in stage::qa

**Flaky Check Handling:**
- Retry with no code changes but still fails → Mark as flaky, continue (can't silently retry to green)
- Non-functional AC ("P95 < 200ms") but no tool → Fail, cannot pass

**Collaboration with Other Skills:**
- **Triggered** ← **afk-implement** — Triggers after Signal completion
- **Input** ← MR/PR + AC — Verification target
- **Output** → Merge to prd/<N> or revert build
- **Escalate** → HITL — Semantic conflicts or complex failures

---

### 6. afk-prototype

**Purpose:** Time-box validate technical approach, prove the riskiest part is feasible

**Triggering Scenarios:**
- Requirements are clear but technical risk is high
- Uncertain whether a certain tech stack/library can meet requirements
- Need end-to-end validation of architecture feasibility

**Workflow:**
1. **Prerequisite Check** — Confirm CONTEXT.md exists (requirements aligned)
2. **Create Spike Branch** — `git checkout -b spike/<slug>`
3. **Minimal Implementation** — Only implement the thinnest slice passing all layers, skip edge cases, error handling, tests
4. **Create Draft MR/PR** — `afk mr create "Spike: ..." --draft`
5. **Report Findings** — What works, what surprises, impact on PRD
6. **User Decision** — When spike has answered open questions

**Design Decisions:**

**Why a Prototype skill?**
- High technical risk: direct implementation may waste time (if approach infeasible, need to redo)
- Spike validates quickly (hours), compared to full implementation (days) at lower cost
- Produces concrete evidence (code + findings), not speculation

**Spike vs Full Implementation:**
| Dimension | Spike | Full Implementation |
|------|-------|---------|
| Goal | Prove feasibility | Deliver functionality |
| Testing | Minimal verification | Full coverage |
| Error Handling | Skip | Complete |
| Code Quality | Disposable | Production-grade |
| Time | Time-boxed | As needed |

**Why delete spike branch by default?**
- Spike code quality is low, unsuitable as implementation base
- Keeping it tempts "directly modify based on spike", leading to technical debt
- Only retain when PRD needs to reference specific code lines

**Time-box and Stop Signals:**
- Default budget: one working session (a few hours)
- Stop signal: the most dangerous unknown has a concrete answer (feasible/infeasible/needs X), stop immediately

**Duplicate Work Check:**
- Before branching, check existing `spike/*` branches or draft MR/PR
- Avoid validating the same question twice

**Collaboration with Other Skills:**
- **Prerequisite** ← **afk-grill-me** — Needs CONTEXT.md
- **Parallel** ↔ **afk-research** — Prototype validates approach, Research understands system
- **Output** → Findings report → **afk-do** — Impacts task breakdown and implementation strategy

---

### 7. afk-debug

**Purpose:** Quickly diagnose and fix specific, reproducible failures

**Triggering Scenarios:**
- Specific error message, stack trace, or failure steps provided
- Problem is reproducible
- Need quick fix rather than broad research

**Workflow:**
1. **Reproduce Problem** — Run user's failing steps
2. **Locate Root Cause** — Check logs, stack traces, related code
3. **Verify Assumption** — Modify and test, confirm fix is effective
4. **Regression Test** — Ensure fix doesn't break other functionality
5. **Submit Fix** — fix: prefix, clearly describe problem and solution
6. **Document** — Complex bugs record to ADR or comments

**Design Decisions:**

**Why independent from afk-do?**
- Debug is reactive (problem exists), afk-do is constructive (adding features)
- Debug workflow optimized for quick diagnosis, skips planning phase
- Debug allows skipping test-first (urgent fix), add tests afterward

**Why emphasize "reproducible"?**
- Non-reproducible problems are hard to verify fix effectiveness
- Intermittent issues usually require deeper research, not suitable for quick debug flow

**Why regression testing?**
- Fix may introduce new problems (side effects)
- Ensure fix is localized, doesn't affect other parts of the system

**Collaboration with Other Skills:**
- **Independent** — Typically doesn't call other skills
- **Escalate** → **afk-research** — If problem involves unfamiliar system parts
- **Escalate** → **afk-do** — If fix requires refactoring or architecture changes

---

### 8. afk-hand-off

**Purpose:** Safely hand off current work state to another developer

**Triggering Scenarios:**
- Need to pause current task for others to continue
- Work incomplete but context transfer needed
- Team collaboration requires clear state snapshot

**Workflow:**
1. **Record State** — Current branch, completed content, work in progress
2. **List Next Steps** — TODOs, known issues, decision points
3. **Mark Dependencies** — Blockers, needed information/permissions
4. **Generate Document** — HANDOFF.md contains all context
5. **Commit to Branch** — Ensure handoff recipient can get latest state

**Design Decisions:**

**Why a hand-off skill?**
- Verbal handoffs easily miss details
- Async collaboration (timezone differences) needs documentation
- New team members need complete context, reducing understanding cost

**Why output HANDOFF.md instead of issue comment?**
- Document co-located with code on same branch, tight context association
- Avoid long technical details in issues (issues are product-oriented)
- Convenient for recipient to view locally, no internet needed

**Why record decision points?**
- Recipient may face the same decisions
- Explain "why we did this" not just "what we did"
- Avoid repeating already rejected approaches

**Collaboration with Other Skills:**
- **Follow-up** → **afk-do** — Recipient uses afk-do to continue task
- **Output** → HANDOFF.md → Team members

---

### 9. api-workflow

**Purpose:** Convert natural language business scenarios into executable Playwright API test files

**Triggering Scenarios:**
- User describes multi-step API flow (e.g., "login → create order → verify status")
- Need API + browser hybrid testing
- Need to verify webhooks, async tasks, error handling

**Workflow:**
1. **Parse** — Understand user scenario, identify API steps and data flow
2. **Generate** — Create test file in `tests/api-workflow/scenarios/`
3. **Confirm** — Show generated file structure
4. **Execute** — Run `pnpm playwright test`

**Generated Structure:**
```
tests/api-workflow/
├── scenarios/           # Business flow tests
├── fixtures/           # Reusable fixtures
├── utils/             # Utility functions
└── playwright.config.ts
```

**Template Reuse:**
- `templates/` — TypeScript code templates, ready to use
- `references/` — Pattern concept descriptions, help AI understand pattern meaning

**Collaboration with Other Skills:**
- **Prerequisite** → Any scenario needing API verification
- **Output** → Executable test files

---

### 10. afk-grill-me-context

**Purpose:** Follow-up questions based on existing context (architecture documents, code audit results, drafts), validate and supplement existing materials

**Triggering Scenarios:**
- Existing bounded contexts need validation
- Architecture document has assumptions to investigate
- Previous alignment draft needs supplementation/revision
- Need to read code to verify context matches actual codebase

**Workflow:**
1. **Identify Topic** — Read provided context, form understanding of existing picture
2. **Targeted Follow-up** — Ask specific questions based on existing materials: Are boundaries accurate? Terminology conflicts? Undocumented invariants? Cross-context relationships?
3. **Optional Code Audit** — If context is fuzzy, read code to verify accuracy
4. **Draft Summary** — Present updated CONTEXT.md, mark new additions
5. **User Confirmation** — Similar to afk-grill-me Step 4 gate (approve/revise/follow-up/add open questions)
6. **Write to /tmp/** — Only write after confirmation, not to repo working tree

**Design Decisions:**

**Why independent from afk-grill-me?**
- afk-grill-me interviews from scratch, afk-grill-me-context "fills gaps" based on existing materials
- When context exists, using the latter is more efficient, avoids redundant questions

**Why read code?**
- Code is the ultimate source of truth, used to verify whether boundaries in docs reflect actual architecture

**Closure Conditions:**
- Each section has at least 1 falsifiable answer
- After 2 rounds with no new information, draft document

**Collaboration with Other Skills:**
- **Prerequisite** ← Existing alignment documents, architecture diagrams, code audit results
- **Output** → CONTEXT.md → **afk-to-prd** or **afk-do**

---

### 11. afk-to-prd

**Purpose:** Synthesize requirements alignment records into a publishable PRD (Product Requirements Document)

**Triggering Scenarios:**
- Requirements interview/alignment completed, sufficient alignment records exist
- Need structured PRD for release and subsequent breakdown

**Workflow:**
1. **Verify Alignment Records** — Optional: read code to verify bounded contexts and architecture decisions
2. **Draft PRD** — Use `references/prd-template.md` template, includes: Problem Statement, Users & Jobs, Bounded Contexts, User Stories, Key Decisions, Open Risks, Non-Goals
3. **Gate Confirmation** — User approves before publishing
4. **Publish** — Create issue with `stage::prd` tag

**Design Decisions:**

**Why use a template?**
- Ensure consistent PRD output format, each AC uses 3-field format: `<text> -- <evidence_type> -- <check_command>`
- `evidence_type` controlled vocabulary: test | curl | log | manual | none

**Why limit synthesis scope?**
- Only synthesize existing information, don't invent user stories
- Unresolved open questions go directly into Open Risks, don't auto-resolve

**Collaboration with Other Skills:**
- **Prerequisite** ← **afk-grill-me** or **afk-grill-me-context** output
- **Output** → PRD.md → **afk-to-issues** breaks down into executable issues

---

### 12. afk-to-issues

**Purpose:** Break down requirements (PRD or free text) into tracker issues, with machine-verifiable acceptance criteria

**Triggering Scenarios:**
- Approved PRD needs breakdown into executable issues
- Any requirements context needs quick breakdown

**Workflow:**
1. **Select Mode** — PRD Mode (has PRD) or Direct Mode (free text)
2. **Read Code Infer Verification Method** — Infer `evidence_type` for each acceptance criteria (test/curl/log/manual)
3. **Slice** — Split requirements into independent issues using vertical/horizontal strategy
4. **Isolation Analysis** — Determine if `need::isolate` needed (database changes, middleware config, etc.)
5. **Draft** — Fill all issue template fields
6. **Self-check** — Run each `check_command` in sandbox, confirm non-zero exit
7. **Gate** — Present all drafts + DAG + labeling scheme, wait for approval
8. **Create** — After approval, use `afk issue create` to create, use `afk issue link` to establish DAG

**Design Decisions:**

**Why distinguish PRD Mode and Direct Mode?**
- PRD Mode has structured input, slicing is more precise
- Direct Mode supports fast path, can start without PRD

**Why isolation analysis?**
- Issues needing middleware (MySQL, Redis, etc.) require special tagging for scheduler to start isolated containers

**Collaboration with Other Skills:**
- **Prerequisite** ← **afk-to-prd** output (PRD Mode)
- **Output** → tracker issues → **afk-implement** or **afk-scheduler**

---

### 13. afk-pipeline

**Purpose:** Stage routing — When user is unsure which skill to use, recommend appropriate skill based on current work stage

**Triggering Scenarios:**
- User unsure which skill to invoke
- User asks about lifecycle overview

**Workflow:**
1. **Identify What User Has** — Idea? Document? Issue? MR?
2. **Match Routing Table** — Recommend corresponding skill based on user's current state
3. **Show Pipeline Diagram** — Optional: show complete flow view

**Routing Table:**

| User has... | Recommended Invocation |
|-----------|---------|
| Idea/feature, nothing written | `/afk-grill-me` |
| Existing bounded context/architecture doc/code audit | `/afk-grill-me-context` |
| Idea with technical risk | `/afk-prototype` |
| Alignment records (interview/draft/requirements) | `/afk-to-prd` |
| Approved PRD | `/afk-to-issues` |
| Tracker issue needing implementation | `/afk-implement <iid>` |
| Multiple issues needing orchestration | `/afk-scheduler` |
| Specific task in current session | `/afk-do "<task>"` |
| MR needing verification | `/afk-qa <mr-url>` |
| Reproducible failure | `/afk-debug` |
| Session state snapshot/recovery | `/afk-hand-off` |

**Design Decisions:**

**Why not auto-routing?**
- User intent may be ambiguous, multiple matches need human judgment
- Avoid skill being called incorrectly

**Collaboration with Other Skills:**
- **References all skills** — Pure routing, doesn't execute any skill

---

### 14. afk-branch-migrate

**Purpose:** Cross-branch code migration — Selectively extract code between branches with significant differences

**Triggering Scenarios:**
- Need to migrate code from a specific commit from one branch to another
- Two branches have significant differences, direct cherry-pick may conflict

**Workflow:**
1. **Identify Source** — Locate source via commit hash, search text, or commit range
2. **Analyze** — Classify each changed file: core/test/config/incidental
3. **Risk Assessment** — Compare target branch: low/medium/high/severe
4. **Confirm Migration Plan** — User selects files to include/exclude, create rollback checkpoint
5. **Apply** — Low/medium conflicts auto cherry-pick, high/severe manual resolution
6. **Verify** — Compile + test
7. **Rollback** — List available checkpoints, support restore to any point

**Design Decisions:**

**Why independent skill?**
- Cross-branch migration is more complex than ordinary cherry-pick, needs risk assessment and manual conflict resolution
- Pure Git operations, no external API calls

**Collaboration with Other Skills:**
- **Independent** — Typically doesn't depend on other skills

---

### 15. afk-scheduler

**Purpose:** Background scheduler — Based on `blocked_by` dependency DAG, automatically launches multiple issue implementation sessions in waves

**Triggering Scenarios:**
- Multiple `mode::afk` issues need execution in dependency order
- Need automatic scheduling and monitoring of background implementation sessions

**Workflow:**
1. **Build DAG** — Scan all `mode::afk` + `stage::ready-for-issues` issues
2. **Calculate Waves** — Topological sort: unblocked goes into Wave 1, subsequent waves after blocks clear
3. **Launch Gate** — Manual mode: show wave plan, confirm before launch; Auto mode: idempotent scan, launch immediately
4. **Execute Waves** — Poll MR status every 60 seconds, wave proceeds to next after all MRs in wave are merged
5. **Complete** — Notify human gate after all waves complete

**Design Decisions:**

**Why execute in waves?**
- Ensure correct dependency order: Wave N+1 only launches after Wave N fully completes
- Issues within same wave execute in parallel, improving efficiency

**Why auto mode skips confirmation?**
- Idempotent design, suitable for cron scheduled execution
- Only launches issues not already launched, no duplicates

**Collaboration with Other Skills:**
- **Calls** → `afk workflow run` — Launch implementation session for each issue
- **Output** → Merged MRs → Human review

---

### 16. md-to-pdf

**Purpose:** Convert Markdown documents (including Mermaid diagrams, tables, mixed Chinese/English) to beautifully formatted A4 PDF

**Triggering Scenarios:**
- User requests "convert to PDF", "export PDF"
- Need to share or print documents containing Mermaid diagrams

**Workflow:**
1. **Check Dependencies** — Verify `pandoc`, `mmdc`, `weasyprint` are installed
2. **Extract Mermaid Blocks** — Find all ` ```mermaid ` code blocks
3. **Render Diagrams** — Use `mmdc` to convert each block to PNG
4. **Replace Images** — Replace mermaid blocks with `![](path/to/diagram.png)`
5. **Convert to HTML** — Use `pandoc` to convert Markdown → HTML
6. **Inject CSS** — Apply A4 layout + Chinese font stack
7. **Generate PDF** — Use `weasyprint` to render HTML → PDF

**Tech Stack:** pandoc + weasyprint + mermaid-cli

**Collaboration with Other Skills:**
- **Independent** — Pure document conversion, doesn't depend on other skills

---

### 17. afk-skill-craft

**Purpose:** Create new SKILL.md, diagnose existing skill quality issues, or refactor to align with SKILL-GUIDE standards

**Triggering Scenarios:**
- User requests creating, auditing, or improving a skill
- New skill development
- Existing skill needs refactoring

**Workflow:**
1. **Select Mode** — Create / Diagnose / Refactor
2. **Create** — Confirm name → Draft frontmatter → Identify directory structure → Draft body → Validate
3. **Diagnose** — Read SKILL.md → Check each quality checklist item → Check constraint rules → Report issues
4. **Refactor** — Diagnose first → Apply fixes based on results → Validate again

**Design Decisions:**

**Why a meta skill?**
- Skill creation itself is a workflow worth standardizing
- Unified diagnostic standards ensure consistent skill quality
- Auto-fix common issues

**Key Principles:**
- Abstract concepts the LLM already knows, preserve domain-specific vocabulary (`mode::afk`, etc.)
- No formulaic decoration, describe each step in actual workflow shape
- Use explicit reasoning chains, don't blindly confirm

**Collaboration with Other Skills:**
- **Independent** — Doesn't depend on other skills
- **Output** → New skill or fixed skill

---

### 18. reasoning-guard

**Purpose:** In-session reasoning path guardian — Detect coding agent reasoning degradation in multi-turn conversations, inject corrective prompts

**Triggering Scenarios:**
- Repeated edits at same location with persistent errors
- Token consumption disproportionate to progress
- Code quality declining with edit rounds
- User requests "check reasoning path", "stop looping"

**Workflow:**
1. **Signal Detection** — Monitor repeated operations, token burning, semantic regression in session
2. **Intercept** — When signal detected, inject corrective framework before response:
   - SAFE_RESTORE — git stash saves state + rollback to stable baseline
   - FIRST_PRINCIPLES — Assume audit + root cause decomposition
   - CAUSAL_TRACE — git log/diff trace to earliest failing commit
   - ADVERSARIAL — Failure mode enumeration + counterexample search
3. **Continue** — Continue coding after completing analysis

**Design Decisions:**

**Why session-based detection instead of hooks?**
- No installation needed, no background process, entirely in-conversation
- Suitable for temporary reasoning monitoring needs

**Collaboration with Other Skills:**
- **Opposite** → **reasoning-watchdog** — Hooks-based automated version, suitable for persistent monitoring scenarios

---

### 19. reasoning-watchdog

**Purpose:** Hooks-based automatic reasoning path guardian — Install PostToolUse/PreToolUse/SessionEnd hooks into Claude Code, automatically detect and intercept reasoning degradation

**Triggering Scenarios:**
- reasoning-watchdog system already installed, need to check status or tune thresholds
- Need persistent, automated reasoning monitoring

**Workflow:**
1. **Install** — `npm run install` registers hooks to `~/.claude/settings.json`
2. **Auto-detect** — PostToolUse hook monitors repeated operations, token burning, etc.
3. **Intercept** — PreToolUse hook injects corrective prompts and blocks next action
4. **Cleanup** — SessionEnd hook cleans up session state files

**Architecture:**
```
Claude Code session
  └── PostToolUse hook → Detect error signals
  └── PreToolUse hook  → Inject corrective prompt + block next action
  └── SessionEnd hook  → Clean up session state files
```

**Design Decisions:**

**Why use hooks instead of in-session monitoring?**
- Persistent installation, auto-activates on each startup
- No human intervention needed, suitable for long-term use

**Difference from reasoning-guard:**
- reasoning-guard: In-session, no background process, temporary use
- reasoning-watchdog: Hooks installed, auto runs in background, persistent

**Collaboration with Other Skills:**
- **Opposite** → **reasoning-guard** — In-session version, for temporary monitoring

---

## Skills Design Principles Summary

### 1. Single Responsibility
Each skill solves one category of problems, avoiding feature overlap:
- **afk-grill-me** — Clarify requirements
- **afk-grill-me-context** — Follow-up with existing context
- **afk-research** — Research and understand
- **afk-prototype** — Validate approach
- **afk-to-prd** — Synthesize PRD
- **afk-to-issues** — Break down into issues
- **afk-implement** — TDD implementation
- **afk-qa** — Independent verification
- **afk-pipeline** — Stage routing
- **afk-branch-migrate** — Cross-branch migration
- **afk-scheduler** — Background scheduling
- **md-to-pdf** — Document conversion
- **reasoning-guard** — Reasoning path guardian
- **reasoning-watchdog** — Automatic reasoning monitor
- **afk-skill-craft** — Skill create/diagnose/refactor

### 2. Explicit Trigger Conditions
`description` is the sole trigger carrier, loaded at Claude Code startup for matching. Body only loads after activation.
```yaml
description: "Understand how an existing system works, or evaluate feasibility of an approach, before committing to a plan."
```

### 3. Verifiable Workflows
Ensure completion quality through mechanisms:
- **Signal files** — `.afk-signal.json` marks completion status
- **AC checks** — afk-qa independently verifies each acceptance criteria
- **Gate mechanism** — Key decision points require user confirmation

### 4. Methodology Integration
Built-in best practices, reducing cognitive load:
- **TDD** — afk-implement enforces red-green-refactor cycle
- **DDD** — references/ddd.md guides domain modeling
- **Time-boxing** — afk-prototype limits spike time

### 5. Cross-platform Compatibility
Unified commands, auto-adapt to GitLab/GitHub:
```bash
afk mr create "Title"  # Auto-detect platform
afk issue get 123      # GitLab iid or GitHub number
```

See: [ARCHITECTURE.md](ARCHITECTURE.md) for cross-platform abstraction layer design

## References System

Methodology documents referenced by Skills are located in the `references/` directory:

```
references/
├── README.md              # Task type detection guide
├── tdd-feature.md         # TDD development workflow
├── hard-checks.md         # Mandatory checklist
├── ddd.md                 # DDD design guide
├── architecture.md        # Architecture decision template
├── adr.md                 # ADR writing guide
└── task-type/
    ├── feature.md         # Feature development task
    ├── refactor.md        # Refactor task
    └── bugfix.md          # Bug fix task
```

**Why use references/ instead of hardcoding flows?**
1. **Evolvable** — When methodology improves, just update documents, no skill code changes needed
2. **Customizable** — Projects can override default references/, customize workflows
3. **Single Source of Truth** — Avoid inconsistency between skill code and documentation

## Next Steps

- **Architecture Design** → [ARCHITECTURE.md](ARCHITECTURE.md) — Cross-platform abstraction layer
- **Workflows** → [WORKFLOWS.md](WORKFLOWS.md) — Issue → MR pipeline, scheduler
- **Quick Start** → [GETTING-STARTED.md](GETTING-STARTED.md) — 5-minute getting started guide
