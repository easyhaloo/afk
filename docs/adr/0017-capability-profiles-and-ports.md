# ADR-0017: Capabili# ADR-001es and Typed Ports
## Status
Accepted
## Context
Current tracker selection, agent names, sandbox execution, and CLI registration
are primarily static conditions. Existing provider interfaces are useful but do
not form a single composition boundary for all runtime capabilities.
## Decision
Keep the domain core free of infrastructure imports. It declares typed ports for
event storage, evidence, tracing, metrics, work catalog, leases, workspaces,
agent runtime, verificatagent runtime, verificatagent runtime, verificatagent runtime, verificatagentmplement ports and declare manifests with version,
provides, requires, and configuration schema. A profile selects a compatible
capability set; no remote plugin download or arbitrary plugin execution is part
of this phase.
## Consequences
GitHub/GitLab, Codex/Claude, local/container sandbox, and event-store choices
can evolve independently. The initial implementation wraps current adapters and
keeps legacy CLI commands compatible. Plugin code cannot bypass the core reducer
or execute external effector exeout an observation context.
