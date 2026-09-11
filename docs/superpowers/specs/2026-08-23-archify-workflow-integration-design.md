# Archify Workflow Integration Design

**Status:** Approved design, implementation pending  
**Scope:** AFK CLI and `desktop-client`, workflow diagrams only  
**Decision:** Build an AFK-native workflow graph core with optional Archify-compatible JSON and validation output.

## Goal

Expose Archify-style, verifiable workflow maps in AFK CLI and AFK Control without making Archify JSON a second execution configuration or weakening Electron isolation.

## Decisions

1. AFK workflow YAML and persisted run facts remain the only execution sources of truth.
2. A shared, pure TypeScript graph core converts parsed AFK workflow facts into a deterministic graph snapshot.
3. Archify-compatible JSON is a derived export. Archify CLI integration, when available, is an adapter for validation/delivery and is not required for the default desktop runtime.
4. AFK Control uses an embedded, read-only review panel inside the workflow view. Editing remains in the existing native workflow studio.
5. Failed generation never replaces the last trusted snapshot. Diagnostics are retained and displayed.
6. Version one supports `workflow` only. Other Archify diagram types require a separate design.

## Architecture

```text
AFK YAML / run facts
        |
        v
AFK adapters (CLI or Electron main)
        |
        v
WorkflowGraphDefinition
        |
        v
@afk/workflow-graph
  normalize -> layout -> route -> validate -> receipt
        |
        +--> GraphSnapshot (native review panel)
        +--> Archify workflow JSON (optional export/validation)
        +--> GraphReceipt (diagnostics and cache metadata)
```

The shared core must be browser- and Node-compatible. It may use only standard TypeScript/JavaScript data structures and pure functions. It must not import React, Electron, Node filesystem/process APIs, YAML parsers, DOM APIs, or Archify renderer internals.

### Shared package

Create `packages/afk-workflow-graph/` with the following modules:

- `src/ir.ts`: versioned input, node, edge, track, geometry, diagnostic, snapshot, and receipt types.
- `src/project.ts`: converts a normalized AFK template summary into `WorkflowGraphDefinition`.
- `src/normalize.ts`: validates IDs and references, detects cycles, computes stable order and topological depth.
- `src/layout.ts`: deterministic layered left-to-right layout with `agent`, `system`, and `conditional` tracks.
- `src/routing.ts`: deterministic orthogonal routes with shared-endpoint port spreading and label bounds.
- `src/validate.ts`: semantic and geometry checks; returns diagnostics rather than throwing for user-authored graph errors.
- `src/receipt.ts`: stable input/graph hashes and generation metadata.
- `src/archify.ts`: maps the AFK graph definition/snapshot to Archify workflow JSON without adding facts.
- `src/index.ts`: public API only.

The package API should expose:

```ts
projectWorkflow(input): WorkflowGraphDefinition
buildWorkflowGraph(definition, preferences?): {
  snapshot: GraphSnapshot;
  receipt: GraphReceipt;
}
toArchifyWorkflow(definition, snapshot?): ArchifyWorkflowDocument
```

### Fact mapping

| AFK fact | Graph fact | Archify-compatible representation |
|---|---|---|
| Template ID/name/description | Graph metadata | `meta.title`, `meta.description` |
| Step ID/order | Stable node ID/order | `nodes[].id`, authored label |
| `kind: agent` | `agent` track | Agent semantic node |
| `kind: system` / `action` | `system` track and action label | System node/action text |
| `when` | `conditional` track and conditional edge label | Branch label; never current status |
| `dependsOn` | Directed edge | One edge per dependency |
| `provider` / `role` | Node metadata/tags | Short node metadata only |
| Persisted run fact with step ID | Optional read-only overlay | Status badge only when fact exists |

The converter must not infer success, timing, ownership, runtime impact, or external topology.

## CLI Design

Add a lazy-loaded `afk graph` command with a `workflow` subcommand:

```text
afk graph workflow [options]
```

Options:

- `--workspace <path>`: project root, default current directory.
- `--template <id>`: template ID, default configured template.
- `--format <format>`: `json` (default), `archify-json`, or `receipt`.
- `--output <path>`: write atomically; without it, write JSON to stdout.
- `--validate`: return non-zero when semantic or geometry diagnostics contain errors.
- `--run <run-id>`: explicitly request a persisted run overlay; never infer one.
- `--json`: machine-readable command envelope for diagnostics and receipt.

Examples:

```bash
afk graph workflow --template sequential-review --format archify-json --output .afk/cache/archify/sequential-review.json
afk graph workflow --template sequential-review --validate --json
```

Exit behavior:

- `0`: graph generated; with `--validate`, no error diagnostics.
- `1`: invalid arguments, missing template, or validation errors.
- `2`: optional Archify adapter unavailable or delivery failed.

The default command must work without Archify installed. A separate optional adapter command may invoke a pinned Archify executable for `validate`/`deliver`, but it must use a fixed argument allowlist and report the Archify version in the receipt.

## Electron Design

### Main process

Add an `electron/graph/` or `electron/services/graph-service.ts` boundary that:

1. Resolves and validates the workspace.
2. Reads the selected template through the existing schema-aware YAML path.
3. Calls the shared graph core.
4. Stores candidates under `.afk/cache/archify/` using the template ID and input hash.
5. Replaces `last-trusted.json` only after validation succeeds.
6. Returns DTOs through fixed IPC channels.

New channels:

- `afk:workflow-graph`: return current snapshot, receipt, trust state, and diagnostics.
- `afk:workflow-graph-generate`: generate a candidate and return its receipt.
- `afk:workflow-graph-export`: request an Archify-compatible JSON export through a save dialog or approved project-relative destination.

All handlers must call the existing sender guard and validate workspace, template ID, mode, and output format. Renderer-provided arbitrary paths, shell commands, URLs, and Archify arguments are forbidden.

### Renderer

Refactor the current workflow studio graph display so its geometry is consumed from `GraphSnapshot`; React may own selection, pan/zoom, and panel state only.

Add an embedded review section with:

- status: `missing`, `generating`, `trusted`, `stale`, or `rejected`;
- read-only SVG graph surface;
- node/edge selection and diagnostic focus;
- `生成审阅图`, `重新验证`, and `导出 Archify JSON` actions;
- last trusted receipt timestamp and input hash prefix;
- explicit stale badge when the workflow draft differs from the trusted input hash.

The review panel must not become a second workflow editor. Node edits continue through the native inspector and require explicit regeneration.

## Cache and Trust Model

```text
.afk/cache/archify/
  workflow/<template-id>/<input-hash>/
    graph.json
    archify.workflow.json
    receipt.json
    diagnostics.json
  index.json
```

Writes use same-directory temporary files followed by rename. The index records template ID, input hash, graph hash, generation time, core version, optional Archify version, and trust state. Old trusted artifacts are retained when a new candidate is rejected.

## Error Handling and Security

- Missing dependencies, duplicate IDs, invalid `when` references, cycles, route collisions, and label overlap are structured diagnostics.
- User-authored graph errors must not crash CLI, main process, or React.
- The native review panel renders the graph snapshot, not arbitrary generated HTML.
- If an Archify HTML viewer is later added, it must be loaded in a separate sandboxed view with a fixed protocol and no access to AFK IPC; that is out of scope for this phase.
- Development CSP warnings may remain during Vite development, but no new navigation, popup, permission, or arbitrary IPC capability may be introduced.

## Testing and Acceptance

### Shared core tests

- Sequential steps produce deterministic columns and edges.
- Parallel roots receive stable vertical ordering.
- `when` produces a conditional track and exact branch label.
- Missing dependency and cycle produce diagnostics and no undefined nodes.
- Shared endpoints route without duplicate center-point collisions.
- Repeated generation yields identical graph and input hashes.
- Archify export contains every authored node and dependency exactly once.

### CLI tests

- `afk graph workflow --json` returns a stable envelope.
- `--validate` exits 1 on invalid graph input.
- Output writes are atomic and parent directories are constrained to the workspace cache or an approved destination.
- The command succeeds when Archify is not installed.

### Desktop tests

- IPC sender and argument validation cover all new channels.
- Trusted, stale, rejected, and missing states render correctly.
- Generate failure preserves the previous trusted snapshot.
- The workflow page displays the embedded review panel without importing Node/Electron APIs.
- Existing `typecheck`, `test`, `build`, and runtime startup verification remain green.

## Delivery Phases

1. Shared IR, projection, normalization, layout, routing, validation, and tests.
2. CLI `graph workflow` command and cache/receipt writer.
3. Electron IPC/service integration.
4. Embedded read-only review panel using `GraphSnapshot`.
5. Optional Archify-compatible export and pinned adapter.
6. Full CLI, desktop, and runtime verification.

Out of scope for this phase: architecture/sequence/dataflow/lifecycle diagrams, live Archify preview daemon, arbitrary HTML loading, source-evidence tracing, guided stories, WebM/PNG export, and run overlays without explicit step-linked facts.
