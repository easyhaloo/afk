# Architecture Design Guide

**Purpose**: Guide agents to design module structure and data flows before writing code for new features.
**When**: afk-implement Step 3, if the feature introduces new modules/packages or complex data flows.
**Output**: Module graph in commit message; architecture decision in `docs/architecture/decisions/`.

---

## Architecture Design Before Code

**Mandatory for**:
- New package or module (e.g., new `internal/domain/<new>/`)
- New external dependency (new DB, new queue, new API)
- Cross-module data flow that isn't already documented
- Feature that changes how data flows between existing modules

**Optional for**: small additions to existing modules (add a method, add a field).

---

## Step 1 — Sketch the Module Graph

List all modules/packages involved and draw dependency direction:

```bash
# Example: new reorder feature
cat docs/architecture/module-graph.md 2>/dev/null || echo "(no graph yet)"
```

Document the current graph, then add the new component:

```
Before:
  [Ingest] --> [Snapshot]

After (new):
  [Ingest] --> [Snapshot] --> [L2 Extract] --> [WikiPage]
                     |
                     v
               [Deduplication]
```

---

## Step 2 — Define Interfaces Before Implementation

For every cross-module boundary, define the interface **before** writing implementation:

```go
// Step: Write this first (in domain/, not infra/)
type SnapshotRepository interface {
    FindByBindingAndDocID(bindingID, externalDocID string) (*SourceSnapshot, error)
    Save(snap *SourceSnapshot) error
    ListByBindingID(bindingID string) ([]*SourceSnapshot, error)
}
```

**Rule**: Interface in `domain/`, implementation in `infra/`. Never expose implementation types across module boundaries.

---

## Step 3 — Document the Data Flow

For the commit message, document:

```
Architecture:
- Module graph: Order --> Inventory --> Shipping
- New interfaces: InventoryRepository (domain/inventory)
- Data flow: Order.Create --> Inventory.Reserve --> emit ORDER_CREATED --> Shipping.Schedule
- Failure points:
  - If Inventory.Reserve fails: Order stays in draft, no shipping scheduled
  - If Shipping.Schedule fails: Inventory reservation stays, retry via queue
```

---

## Step 4 — Check for Architectural Problems

| Problem | Signal | Fix |
|---------|--------|-----|
| Cyclic dependency | A imports B, B imports A | Extract interface, put in third package |
| God object | One file/class does everything | Split by responsibility |
| Shotgun surgery | One change requires editing many files | Maybe missing abstraction |
| Jump over layer | Infra directly calls domain logic | Add domain service |
| Missing layer | Business logic in HTTP handler | Move to app/ or domain/ |

---

## Module Structure Reference (language-agnostic)

```
src/
├── domain/
│   ├── order/              # Order bounded context
│   │   ├── models/         # Entities, value objects
│   │   ├── repository.go   # Repository interface
│   │   ├── service.go      # Domain logic
│   │   └── events/         # Domain events
│   └── catalog/             # Catalog bounded context
│       ├── models/
│       ├── repository.go
│       ├── service.go
│       └── events/
├── app/                    # Application services (orchestration)
│   └── order_app.go
├── infra/                  # External adapters (implement repository interfaces)
│   ├── mysql/
│   │   ├── order_repo.go
│   │   └── catalog_repo.go
│   └── queue/
└── kernel/                 # Cross-cutting (events, config)
    ├── event/
    └── config/
```

---

## Architecture Commit Format

```bash
git add -A && git commit -m "$(cat <<'EOF'
feat: <desc> #<iid>

Architecture:
- Module graph: <who calls whom>
- New interfaces: <interface name> (domain/<ctx>)
- Data flow: <input --> step1 --> step2 --> output>
- Failure points: <what if X fails>

Next: <concrete next action>
EOF
)"
```

