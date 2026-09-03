# AFK Agent Repository Constraints

## Desktop Electron Architecture

For work under `desktop-client/`, use the following organization:

- `electron/main.ts` only bootstraps Electron and composes modules.
- Main-process code is split into `window/`, `ipc/`, `services/`,
  `adapters/`, and `workflow/`; no single file owns all filesystem, process,
  SQLite, YAML, and IPC behavior.
- `electron/preload.ts` is the only renderer bridge and exposes a typed,
  fixed whitelist. Main-process handlers validate sender origin and arguments.
- React code in `src/` cannot import Node/Electron or perform local I/O.
- Cross-process DTOs live in `shared/` and have no runtime dependency on
  Electron, Node, React, DOM, YAML, or filesystem modules.
- Workflow graph normalization, layout, routing, and validation are pure
  functions with tests. Missing dependencies and cycles produce diagnostics,
  never runtime crashes.
- Use one schema-aware YAML parser for reads and writes.
- Add focused tests for every extracted service or pure function. The desktop
  package must have independent typecheck, build, and test CI checks.
- Treat `dist/`, `dist-electron/`, `release/`, and test screenshots as build
  output, not source.
