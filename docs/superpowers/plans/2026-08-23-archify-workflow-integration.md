# Archify Workflow Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic AFK workflow graph core, expose it through `afk graph workflow`, and render its read-only review surface inside AFK Control.

**Architecture:** Parsed AFK templates are projected into a shared pure graph package. The CLI and Electron main process own parsing, persistence, and optional Archify export; the renderer consumes only graph DTOs through fixed IPC. AFK YAML remains authoritative and graph artifacts are hash-addressed derived cache entries.

**Tech Stack:** TypeScript, Zod workflow types, Vitest, Commander, Electron IPC, React/SVG, `js-yaml` only at existing parser boundaries.

---

## Task 0: Reconcile the AFK CLI package entrypoint before feature work

**Files:**
- Inspect: `package.json`
- Inspect: `package-lock.json`
- Inspect: `src/index.ts`
- Inspect: `scripts/build.mjs`
- Inspect: `tsconfig.json`
- Modify only if confirmed by repository evidence: `package.json`, `pnpm-lock.yaml`

- [ ] **Step 1: Reproduce the metadata mismatch**

Run:

```bash
node -e "const p=require('./package.json'); console.log(p.name, p.scripts)"
node -e "const p=require('./package-lock.json'); console.log(p.name, p.packages?.['']?.name)"
test -f src/index.ts && test -f scripts/build.mjs
```

Expected: the current root manifest and lockfile disagree; the lockfile and source identify the AFK CLI.

- [ ] **Step 2: Confirm the root AFK CLI boundary from repository evidence**

The root is the authoritative AFK CLI boundary: `src/index.ts`, `scripts/build.mjs`, `dist/index.js`, the AFK README commands, and `package-lock.json` all point to it; `git show 261eb7b:package.json` contains the matching AFK manifest. The current `@ant/desktop` manifest is inconsistent with those sources and must be corrected before feature work.

- [ ] **Step 3: Restore the AFK CLI package metadata**

Restore the AFK `name`, `version`, `type`, `bin`, scripts, and dependency declarations from the AFK baseline represented by `git show 261eb7b:package.json`, then retain any dependency that is still imported by the current `src/` tree. Regenerate `pnpm-lock.yaml` from that manifest. Do not change the separate `desktop-client/package.json`.

- [ ] **Step 4: Verify the baseline**

Run:

```bash
pnpm build
pnpm typecheck
pnpm test
```

Expected: existing AFK tests pass before graph changes begin.

- [ ] **Step 5: Commit the entrypoint correction separately**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(cli): establish afk cli package entrypoint"
```

## Task 1: Create the shared graph package skeleton and public IR

**Files:**
- Create: `packages/afk-workflow-graph/package.json`
- Create: `packages/afk-workflow-graph/tsconfig.json`
- Create: `packages/afk-workflow-graph/src/ir.ts`
- Create: `packages/afk-workflow-graph/src/index.ts`
- Modify: `tsconfig.json`
- Modify: `pnpm-workspace.yaml` (create if absent)
- Test: `packages/afk-workflow-graph/tests/ir.test.ts`

- [ ] **Step 1: Write the failing IR test**

```ts
import { describe, expect, it } from 'vitest';
import { graphSchemaVersion, type GraphSnapshot } from '../src';

describe('workflow graph IR', () => {
  it('exposes a versioned snapshot contract without runtime dependencies', () => {
    const snapshot: GraphSnapshot = {
      schemaVersion: graphSchemaVersion,
      kind: 'workflow',
      nodes: [],
      edges: [],
      tracks: [],
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      diagnostics: [],
    };
    expect(snapshot.schemaVersion).toBe(1);
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm exec vitest run packages/afk-workflow-graph/tests/ir.test.ts`

Expected: FAIL because the package and exported IR do not exist.

- [ ] **Step 3: Add the package and IR types**

Define `WorkflowGraphDefinition`, `GraphStep`, `GraphNode`, `GraphEdge`, `GraphTrack`, `Rect`, `Point`, `OrthogonalRoute`, `GraphDiagnostic`, `GraphSnapshot`, `GraphReceipt`, and `WorkflowGraphPreferences` in `ir.ts`. Use `readonly` arrays for outputs, string literal unions for diagnostic severity/code, and `schemaVersion: 1` as a literal. Export only the public types and `graphSchemaVersion` from `src/index.ts`. Configure the package to emit ESM declarations to `dist` and include only `src`.

- [ ] **Step 4: Run the focused test and typecheck**

Run: `pnpm exec vitest run packages/afk-workflow-graph/tests/ir.test.ts && pnpm exec tsc -p packages/afk-workflow-graph/tsconfig.json --noEmit`

Expected: PASS and exit code 0.

- [ ] **Step 5: Commit**

```bash
git add packages/afk-workflow-graph tsconfig.json pnpm-workspace.yaml
git commit -m "feat(graph): add workflow graph IR package"
```

## Task 2: Project AFK templates and normalize graph semantics

**Files:**
- Create: `packages/afk-workflow-graph/src/project.ts`
- Create: `packages/afk-workflow-graph/src/normalize.ts`
- Create: `packages/afk-workflow-graph/tests/project.test.ts`
- Create: `packages/afk-workflow-graph/tests/normalize.test.ts`
- Modify: `packages/afk-workflow-graph/src/index.ts`

- [ ] **Step 1: Write failing projection and diagnostic tests**

Cover these exact cases:

```ts
it('projects kind, role, provider, action, when, and dependencies without inference', () => {
  const graph = projectWorkflow({
    templateId: 'review',
    templateVersion: 1,
    name: 'Review',
    description: 'Review flow',
    steps: [{ id: 'implement', kind: 'agent', role: 'implementer', provider: 'codex', dependsOn: [] },
      { id: 'review', kind: 'agent', role: 'reviewer', when: { step: 'implement', equals: 'failed' }, dependsOn: ['implement'] }],
  });
  expect(graph.steps[1]).toMatchObject({ id: 'review', dependsOn: ['implement'], when: { step: 'implement', equals: 'failed' } });
});

it('returns missing dependency and cycle diagnostics without undefined nodes', () => {
  const result = normalizeDefinition(definitionWithSteps([
    { id: 'a', dependsOn: ['missing'] },
    { id: 'b', dependsOn: ['a'] },
    { id: 'a', dependsOn: ['b'] },
  ]));
  expect(result.diagnostics.map(d => d.code)).toEqual(expect.arrayContaining(['missing-dependency', 'duplicate-id', 'cycle']));
  expect(result.steps.every(step => step.id)).toBe(true);
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `pnpm exec vitest run packages/afk-workflow-graph/tests/project.test.ts packages/afk-workflow-graph/tests/normalize.test.ts`

Expected: FAIL because projection and normalization are not implemented.

- [ ] **Step 3: Implement projection and normalization**

`projectWorkflow` accepts a JSON-safe template summary, preserves YAML order, maps omitted `kind` to `agent`, and computes `contentHash` from canonical JSON. `normalizeDefinition` must validate unique IDs, dependency references, `when.step` references, and DAG structure. Use Kahn topological sorting with original order then ID as deterministic tie-breakers. Return valid steps only, with diagnostics for invalid references; never synthesize a step for a missing reference.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm exec vitest run packages/afk-workflow-graph/tests/project.test.ts packages/afk-workflow-graph/tests/normalize.test.ts && pnpm exec tsc -p packages/afk-workflow-graph/tsconfig.json --noEmit`

Expected: PASS with all diagnostics assertions satisfied.

- [ ] **Step 5: Commit**

```bash
git add packages/afk-workflow-graph/src packages/afk-workflow-graph/tests
git commit -m "feat(graph): project and normalize workflow definitions"
```

## Task 3: Add deterministic layout, routing, validation, and receipts

**Files:**
- Create: `packages/afk-workflow-graph/src/layout.ts`
- Create: `packages/afk-workflow-graph/src/routing.ts`
- Create: `packages/afk-workflow-graph/src/validate.ts`
- Create: `packages/afk-workflow-graph/src/receipt.ts`
- Create: `packages/afk-workflow-graph/tests/layout.test.ts`
- Create: `packages/afk-workflow-graph/tests/routing.test.ts`
- Create: `packages/afk-workflow-graph/tests/validate.test.ts`
- Create: `packages/afk-workflow-graph/tests/determinism.test.ts`
- Modify: `packages/afk-workflow-graph/src/index.ts`

- [ ] **Step 1: Write failing geometry and determinism tests**

Assert that topological depth maps to columns, `when` steps use the conditional track, parallel roots are vertically stable, every dependency creates one edge, shared endpoints receive distinct ports, routes do not intersect node rectangles, and two calls with the same definition produce equal snapshots and hashes.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm exec vitest run packages/afk-workflow-graph/tests/layout.test.ts packages/afk-workflow-graph/tests/routing.test.ts packages/afk-workflow-graph/tests/validate.test.ts packages/afk-workflow-graph/tests/determinism.test.ts`

Expected: FAIL because layout, routing, validation, and receipt functions are absent.

- [ ] **Step 3: Implement pure layout and routing**

Use fixed node dimensions from one exported constant. Place columns by normalized topological depth, tracks by `when` then `kind`, and rows by original order plus parent median. Generate left-to-right orthogonal routes. Spread ports when a node has multiple outgoing or incoming edges. Return `geometry/no-route` when an edge cannot be routed without crossing an opaque node or label bounds; do not draw a fallback line through a node.

- [ ] **Step 4: Implement validator and receipt**

`validateSnapshot` checks semantic diagnostics, duplicate node/edge IDs, missing endpoints, route segment intersections, bounds containment, and label overlap. `createReceipt` canonicalizes JSON with sorted object keys, hashes input and snapshot using SHA-256, and records core version and generation timestamp separately from hashes.

- [ ] **Step 5: Run all shared package tests**

Run: `pnpm exec vitest run packages/afk-workflow-graph/tests && pnpm exec tsc -p packages/afk-workflow-graph/tsconfig.json --noEmit`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/afk-workflow-graph/src packages/afk-workflow-graph/tests
git commit -m "feat(graph): add deterministic layout routing and receipts"
```

## Task 4: Add Archify-compatible workflow export

**Files:**
- Create: `packages/afk-workflow-graph/src/archify.ts`
- Create: `packages/afk-workflow-graph/tests/archify.test.ts`
- Modify: `packages/afk-workflow-graph/src/index.ts`

- [ ] **Step 1: Write the failing export test**

Build a three-step workflow with one conditional edge and assert the export has one authored node per valid step, one edge per dependency, `meta.quality_profile: "showcase"`, and no inferred runtime status or external component.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm exec vitest run packages/afk-workflow-graph/tests/archify.test.ts`

Expected: FAIL because `toArchifyWorkflow` is absent.

- [ ] **Step 3: Implement the export adapter**

Define the minimal Archify workflow document type locally. Map AFK metadata, nodes, tracks/lanes, authored edges, and exact `when` labels. Omit unsupported Archify fields instead of inventing values. Keep the adapter pure and independent of the Archify repository or CLI binary.

- [ ] **Step 4: Run package tests and commit**

Run: `pnpm exec vitest run packages/afk-workflow-graph/tests`

Expected: PASS.

```bash
git add packages/afk-workflow-graph/src/archify.ts packages/afk-workflow-graph/tests/archify.test.ts packages/afk-workflow-graph/src/index.ts
git commit -m "feat(graph): export archify workflow documents"
```

## Task 5: Add the `afk graph workflow` CLI command and cache writer

**Files:**
- Create: `src/application/visualizations/workflow-graph.ts`
- Create: `src/application/visualizations/graph-cache.ts`
- Create: `src/cli/commands/graph.ts`
- Create: `src/cli/commands/graph.test.ts`
- Modify: `src/cli/command-registry.ts`
- Modify: `src/cli/completion/tree.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Write failing CLI tests**

Test a temporary project containing `.afk/workflows/sequential-review.yml`: default JSON output, `--format archify-json`, `--validate` exit behavior for a missing dependency, and cache writes under `.afk/cache/archify/workflow/<template>/<hash>/` without invoking external commands.

- [ ] **Step 2: Run focused CLI tests and verify failure**

Run: `pnpm exec vitest run src/cli/commands/graph.test.ts`

Expected: FAIL because the command is not registered.

- [ ] **Step 3: Implement the application adapter and cache writer**

Use the existing `TemplateLoader` and workflow schema types to load the selected template. Convert it to the shared definition, build the graph, and return a stable JSON envelope. Constrain `--output` to a workspace-relative path or the `.afk/cache/archify` directory; write via a same-directory temporary file and rename. Persist `index.json`, `graph.json`, optional `archify.workflow.json`, and `receipt.json`. Never delete the last trusted artifact on failure.

- [ ] **Step 4: Register lazy loading and completion**

Add `graph` to `COMMANDS`, register the nested `workflow` command, and include it in completion tree construction. Keep `--json` output free of human-readable log lines.

- [ ] **Step 5: Run focused tests and CLI typecheck**

Run: `pnpm exec vitest run src/cli/commands/graph.test.ts && pnpm exec tsc --noEmit`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/application/visualizations src/cli/commands/graph.ts src/cli/command-registry.ts src/cli/completion/tree.ts src/cli/commands/graph.test.ts .gitignore
git commit -m "feat(cli): add workflow graph command"
```

## Task 6: Add Electron graph DTOs, service, and IPC

**Files:**
- Modify: `desktop-client/shared/ipc-contract.ts`
- Modify: `desktop-client/electron/preload.ts`
- Create: `desktop-client/electron/services/graph-service.ts`
- Modify: `desktop-client/electron/ipc/register-handlers.ts`
- Create: `desktop-client/tests/graph-service.test.ts`
- Modify: `desktop-client/tests/sender-guard.test.ts`

- [ ] **Step 1: Write failing service and contract tests**

Cover trusted/missing/rejected/stale status mapping, hash comparison between draft and trusted input, failure preserving the old trusted graph, and rejection of untrusted senders or invalid template IDs/output formats.

- [ ] **Step 2: Run focused desktop tests and verify failure**

Run: `cd desktop-client && pnpm exec vitest run tests/graph-service.test.ts tests/sender-guard.test.ts`

Expected: FAIL because graph DTOs, service, and IPC channels do not exist.

- [ ] **Step 3: Extend the shared IPC contract and preload whitelist**

Add JSON-safe `WorkflowGraphStatus`, `WorkflowGraphGenerateResult`, and fixed channels for status/generate/export. Keep the preload channel names local to the sandboxed preload and expose only typed methods. Do not expose an Archify executable, arbitrary path, shell, or generic `invoke` function.

- [ ] **Step 4: Implement the main-process graph service**

Resolve the workspace through the existing service, read the selected template using the existing schema-aware YAML path, call the shared graph package, and manage the hash-addressed cache. The service must return the last trusted snapshot alongside a rejected candidate diagnostic and must never throw for graph authoring errors.

- [ ] **Step 5: Register and validate IPC handlers**

Call `assertTrustedSender` for every handler. Validate workspace strings, kebab-case template IDs, fixed format values (`json`/`archify-json`), and an optional approved destination token. Use `dialog.showSaveDialog` for user-selected export paths rather than accepting raw renderer paths.

- [ ] **Step 6: Run desktop typecheck/tests**

Run: `cd desktop-client && pnpm typecheck && pnpm test`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add desktop-client/shared/ipc-contract.ts desktop-client/electron/preload.ts desktop-client/electron/services/graph-service.ts desktop-client/electron/ipc/register-handlers.ts desktop-client/tests/graph-service.test.ts desktop-client/tests/sender-guard.test.ts
git commit -m "feat(desktop): add workflow graph IPC service"
```

## Task 7: Add the embedded read-only review panel

**Files:**
- Create: `desktop-client/src/features/workflows/graph/GraphReviewPanel.tsx`
- Create: `desktop-client/src/features/workflows/graph/GraphSurface.tsx`
- Create: `desktop-client/src/features/workflows/graph/graph.css`
- Modify: `desktop-client/src/features/workflows/graph/normalize.ts`
- Modify: `desktop-client/src/main.tsx`
- Modify: `desktop-client/src/control.css`
- Create: `desktop-client/tests/graph-review-panel.test.tsx`

- [ ] **Step 1: Write the failing renderer test**

Render the panel with a trusted snapshot and assert the status, graph node labels, `生成审阅图` action, and diagnostic state. Render a rejected generation result and assert that the previous trusted graph remains visible with a rejection message.

- [ ] **Step 2: Run the focused renderer test and verify failure**

Run: `cd desktop-client && pnpm exec vitest run tests/graph-review-panel.test.tsx`

Expected: FAIL because the review panel does not exist.

- [ ] **Step 3: Implement the read-only SVG surface**

Render `GraphSnapshot.nodes`, `edges`, `tracks`, and `bounds` into one SVG viewBox. Selection, pan, and zoom are local UI state. Use the snapshot's node dimensions and route points; do not recalculate business graph geometry in React. Render structured diagnostics below the graph and keep unknown nodes out of the DOM.

- [ ] **Step 4: Integrate into the existing workflow studio**

Add a secondary `审阅图` section to the workflow view. It must show `missing`, `generating`, `trusted`, `stale`, and `rejected` states; call the typed preload methods; refresh status after native workflow save; and keep editing in the existing inspector. Add explicit actions for generation, revalidation, and Archify JSON export.

- [ ] **Step 5: Run renderer tests and typecheck**

Run: `cd desktop-client && pnpm exec vitest run tests/graph-review-panel.test.tsx && pnpm typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add desktop-client/src/features/workflows/graph desktop-client/src/main.tsx desktop-client/src/control.css desktop-client/tests/graph-review-panel.test.tsx
git commit -m "feat(desktop): embed workflow graph review panel"
```

## Task 8: Add optional Archify adapter and end-to-end verification

**Files:**
- Create: `src/application/visualizations/archify-adapter.ts`
- Create: `src/application/visualizations/archify-adapter.test.ts`
- Modify: `src/cli/commands/graph.ts`
- Modify: `desktop-client/electron/services/graph-service.ts`
- Modify: `desktop-client/README.md`
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the failing adapter test**

Mock the process executor and assert that only the fixed Archify commands `validate workflow <input> --quality showcase --json` and `deliver workflow <input> <output> --quality showcase --json` can be constructed. Assert that arbitrary flags and paths are rejected.

- [ ] **Step 2: Implement the optional adapter**

Detect a configured/pinned Archify executable, report unavailable status without failing default graph generation, and store Archify version and receipt metadata when validation/delivery succeeds. Do not invoke the adapter from the default desktop startup path.

- [ ] **Step 3: Update documentation and CI**

Document `afk graph workflow`, cache/trust semantics, optional Archify installation, and the embedded review panel. Add shared graph tests, root CLI tests, and desktop typecheck/test/build jobs to CI without committing generated cache or release output.

- [ ] **Step 4: Run the full verification set**

Run:

```bash
pnpm exec vitest run
pnpm exec tsc --noEmit
cd desktop-client && pnpm typecheck && pnpm test && pnpm build
git diff --check
```

Expected: all commands exit 0; no graph test reports undefined nodes; no generated `.afk/cache/archify` files are staged.

- [ ] **Step 5: Start and inspect Electron**

Run: `cd desktop-client && pnpm dev`

Verify with the desktop accessibility state that the AFK Control window shows the workflow page, the embedded review panel renders, generation failure does not blank the page, and the console has no preload/IPC/React errors.

- [ ] **Step 6: Commit**

```bash
git add src/application/visualizations src/cli/commands/graph.ts desktop-client/electron/services/graph-service.ts desktop-client/README.md README.md CLAUDE.md AGENTS.md .github/workflows/ci.yml
git commit -m "feat: integrate archify workflow review"
```
