# Jev Agent Guard Global Runtime Implementation Plan

> **For agentic workers:** Implement task-by-task with test-driven development. Do not install into the developer's real home directory while running tests. Existing edits to `install.mjs`, `jev-client.mjs`, and `semantic-engine.mjs` must be preserved. Do not commit unless explicitly requested.

**Goal:** Install one Jev-powered, privacy-preserving runtime globally for Claude Code, Codex, and OpenCode; improve tool/Skill selection, Skill adherence, and model-facing context quality across local projects.

**Architecture:** A versioned runtime in the user data directory owns session state and a host-neutral decision engine. Thin, independently tested host adapters translate native events and decisions. Deterministic checks handle ordinary actions; Jev is consulted only at ambiguous or high-value checkpoints. The installer integrates only with user-level host configuration and never relies on the source repository after installation.

**Tech Stack:** Node.js 20+, `@typesafe-ai/sdk`, `node:test`, JSON host configuration, OpenCode ESM plugin.

---

**Execution checkpoint (September 28, 2026):** The global runtime, three host adapters, bounded Jev checkpoints, Skill routing/ledger, and conservative output reduction have initial implementations with isolated tests. Actual user-level installation has not been run. `doctor` deliberately reports native hook loading as unverified. Live provider evaluation, OpenCode V2 integration, three-host end-to-end sessions, and an A/B task corpus remain acceptance work; unit and temporary-home probes alone do not prove those outcomes.

## Scope and contracts

- Target local sessions that load user-level configuration. Remote machines, cloud sessions, and policy-disabled hooks need a separate installation and must be reported by `doctor` rather than claimed as covered.
- Global runtime: `${XDG_DATA_HOME:-$HOME/.local/share}/jev-agent-guard/current/` on POSIX. On Windows, use `%LOCALAPPDATA%/jev-agent-guard/current/`. Resolve paths via platform APIs and `fileURLToPath`, not URL `.pathname` or the current working directory.
- Configuration: respect `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and `XDG_CONFIG_HOME` when set; otherwise use the documented user defaults. Never write a project-level configuration in global mode.
- One normalized event envelope: `{ version: 1, host, event, sessionId, projectRoot, taskSummary, activeSkill, action, outcome, evidence }`. No raw host payload or credentials cross the provider boundary.
- Decisions: `{ decision: 'allow' | 'advise' | 'deny' | 'needs-user', reason, nextStep? }`. Only host adapters emit native JSON, stdout text, and exit codes. `needs-user` must not be represented by an exit code that means unconditional denial.
- Failures: invalid install inputs abort before mutation; Jev outages preserve native permissions for ordinary actions; local deterministic denials still apply. Stop checks with insufficient evidence produce an advisory, not an endless stop-hook loop.

## Task 1: Runtime installation and path correctness

**Files:**
- Create: `skills/jev-agent-guard/scripts/paths.mjs`, `skills/jev-agent-guard/tests/paths.test.mjs`, `skills/jev-agent-guard/tests/install-runtime.test.mjs`
- Modify: `skills/jev-agent-guard/scripts/install.mjs`, `skills/jev-agent-guard/scripts/install-sdk.mjs`, `skills/jev-agent-guard/package.json`

- [ ] Add failing `node:test` cases for custom `HOME`/XDG locations, source paths with spaces, execution from an unrelated working directory, repeated install, and a missing SDK install. Use temporary homes and a fake npm executable; never call the live package registry in tests.
- [ ] Run `node --test skills/jev-agent-guard/tests/paths.test.mjs skills/jev-agent-guard/tests/install-runtime.test.mjs`; verify failures are caused by current cwd-derived paths and the extra `..` in `install-sdk.mjs`.
- [ ] Implement `sourceRoot = fileURLToPath(new URL('..', import.meta.url))` in scripts under `scripts/`; expose `resolveRuntimeRoot(env, platform)` and `resolveHostPaths(env, platform)` as pure functions.
- [ ] Stage a copy of only `SKILL.md`, `rules/`, `references/`, `scripts/`, `package.json`, and a pinned lockfile in a sibling temporary directory. Install the SDK there with lifecycle scripts disabled; validate script syntax and importability before atomically switching `current` to the new release. Preserve the previous release for rollback; never copy `node_modules` from the development checkout.
- [ ] Fix `install-sdk.mjs` to use the Skill directory directly. Add `install --global`, `install --dry-run`, `doctor`, and `uninstall`; display the resolved runtime and config paths before writes. Repeat the focused tests until green.

## Task 2: Real user-level host registration

**Files:**
- Create: `skills/jev-agent-guard/scripts/hosts/claude-code.mjs`, `skills/jev-agent-guard/scripts/hosts/codex.mjs`, `skills/jev-agent-guard/scripts/hosts/opencode.mjs`, `skills/jev-agent-guard/tests/hosts.test.mjs`
- Modify: `skills/jev-agent-guard/scripts/install.mjs`, `skills/jev-agent-guard/scripts/adapters/claude-code.mjs`, `skills/jev-agent-guard/scripts/adapters/codex.mjs`, `skills/jev-agent-guard/scripts/adapters/opencode.mjs`

- [ ] Capture minimal valid native input/output fixtures for each installed host version. Test existing unrelated hooks/plugins remain byte-for-byte equivalent after install and uninstall; malformed existing JSON must fail rather than be silently replaced.
- [ ] Run `node --test skills/jev-agent-guard/tests/hosts.test.mjs` and observe the existing flat Claude hooks, inert Codex manifest, and OpenCode `plugins` entry fail their fixtures.
- [ ] Claude Code: merge marked user-level hook groups (event → matcher → `hooks` array); cover prompt, tool-before, tool-after, Skill load/invocation, compact, and stop events where supported. Map `needs-user` to native `permissionDecision: 'ask'`; do not map it to exit 2. Preserve the user's other hooks and settings.
- [ ] Codex: merge marked user-level `hooks.json` entries using only supported events and native response fields; use the installed CLI's actual hook schema. Never generate a manifest that Codex does not read, and never emulate unsupported `ask` or output-replacement fields.
- [ ] OpenCode: detect its installed plugin API version, install a loadable user-level ESM plugin in the documented global plugin directory, and export the native `tool.execute.before`/`tool.execute.after`/prompt/context handlers supported by that version. Reject unknown versions with a diagnostic rather than silently claiming success.
- [ ] Quote/escape launch commands on every platform, write config atomically with backup, and make uninstall remove only marked entries. Run fixture tests until green.

## Task 3: Safe, bounded semantic state

**Files:**
- Create: `skills/jev-agent-guard/scripts/event-state.mjs`, `skills/jev-agent-guard/scripts/decision-engine.mjs`, `skills/jev-agent-guard/tests/decision-engine.test.mjs`, `skills/jev-agent-guard/tests/privacy.test.mjs`
- Modify: `skills/jev-agent-guard/scripts/adapters/runtime-adapter.mjs`, `skills/jev-agent-guard/scripts/semantic-engine.mjs`, `skills/jev-agent-guard/scripts/jev-client.mjs`, `skills/jev-agent-guard/scripts/guard.mjs`

- [ ] Test that fake tokens, `.env` contents, source snippets, and unrelated tool output never enter Jev requests or audit records. Test local safe actions do not create SDK requests, while ambiguous decisions call Jev once with bounded state and a strict timeout.
- [ ] Run both test files and verify current `raw_summary` and full-state logging fail privacy assertions.
- [ ] Replace `raw_summary` with an explicit allowlist and bounded, redacted summaries. Delete or repair the unparsable legacy `guard.mjs`, integrating its useful rules into the deterministic engine. Store only metadata, decisions, and evidence references; enforce restrictive file permissions.
- [ ] Batch related Jev questions at task entry, after repeated failures, and before completion. Fix `--model` to set the SDK's `defaultModel` or request `model`; configure timeout/retries and a per-session request budget. Validate malformed/missing answers before accepting a decision.
- [ ] Run the focused tests and `node --check` on every `.mjs` file under the Skill.

## Task 4: Skill routing and adherence ledger

**Files:**
- Create: `skills/jev-agent-guard/scripts/skill-catalog.mjs`, `skills/jev-agent-guard/scripts/skill-ledger.mjs`, `skills/jev-agent-guard/tests/skill-ledger.test.mjs`, `skills/jev-agent-guard/tests/skill-routing.test.mjs`
- Modify: `skills/jev-agent-guard/scripts/adapters/runtime-adapter.mjs`, `skills/jev-agent-guard/rules/semantic.json`

- [ ] Test candidate selection from bounded Skill metadata without loading every full body. Include no match, one match, conflicting matches, explicitly invoked Skill, missing required step, sufficient evidence, and a session resuming after compaction.
- [ ] Read only native host-visible Skill metadata and invocation/load events. Persist `{ skillId, version, mandatorySteps, forbiddenActions, currentStep, evidenceRefs }` per host/session/project with expiry; if invocation is unobservable, report recommendation only, never claim adherence supervision.
- [ ] Validate structural requirements locally; let Jev choose among a small number of ambiguous candidates or recommend the next missing step. Before stopping, report concrete missing evidence and allow the host to continue without recursive stop loops.
- [ ] Run the two focused test files; use recorded host fixtures to verify Skill state survives a new project and cannot leak between sessions.

## Task 5: Conservative context reduction

**Files:**
- Create: `skills/jev-agent-guard/scripts/context-filter.mjs`, `skills/jev-agent-guard/tests/context-filter.test.mjs`
- Modify: host adapters only where a tested native output-replacement/context capability exists.

- [ ] Test that failing commands retain the first causal error, exit status, relevant stack frames, file paths, and a recoverable reference to the original output; successful repetitive logs may shrink. Never alter user messages, requested full output, source files, or durable audit evidence.
- [ ] Prefer deterministic truncation/deduplication to provider calls. Apply filtered model-facing output only on host versions that actually support it. For hosts that do not, emit a compact advisory/checkpoint without claiming to have removed tokens.
- [ ] Include original/filtered byte counts and an opt-out flag; run focused tests and each host's native fixture tests.

## Task 6: Diagnostics and acceptance

**Files:**
- Create: `skills/jev-agent-guard/tests/e2e-global-install.test.mjs`
- Modify: `skills/jev-agent-guard/SKILL.md`, `skills/jev-agent-guard/references/host-integration.md`, `skills/jev-agent-guard/references/policy.md`

- [ ] Test fresh/repeated install, two unrelated projects, an existing hook/plugin, install paths with spaces, offline SDK failure, rollback, uninstall, and missing/disabled host capabilities in temporary homes.
- [ ] `doctor` must distinguish files written, hooks loaded, probes triggered, and decisions honored; clearly report unavailable host features.
- [ ] Run `node --test skills/jev-agent-guard/tests/*.test.mjs` and all `.mjs` syntax checks. Verify live integrations in isolated test homes with each available host binary; report skipped host/version checks explicitly.
- [ ] Compare an identical task corpus with guard disabled/enabled: model-facing tokens, Jev calls and latency, correct Skill selection, completed mandatory steps, and lost failure evidence. Enable context replacement by default only after token use falls without reducing task success or losing failure evidence.

## Implementation order and release gates

1. Ship Tasks 1–2 together as **global integration**; no efficiency or Skill-compliance claims yet.
2. Ship Tasks 3–4 as **selective Jev supervision** after privacy and state tests pass.
3. Ship Tasks 5–6 as **context optimization** only after host-specific replacement capabilities and baseline metrics are verified.

The working-tree installer/client/engine edits are user-owned inputs. Incorporate them deliberately; do not discard or overwrite unrelated changes. Do not invoke the actual global installer as a test without explicit authorization.
