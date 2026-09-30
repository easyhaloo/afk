# AFK Agent Repository Constraints

Rules for coding agents working in this repository. For project orientation —
tech stack, layout, documentation map, and the build/test commands — read
[`CLAUDE.md`](CLAUDE.md). Desktop rules are owned separately by
[`desktop-client/ARCHITECTURE.md`](desktop-client/ARCHITECTURE.md); read that
before touching `desktop-client/`.

## Hard rules

- **`skills/` is the source of truth.** Never edit
  `~/.claude/plugins/cache/` or `~/.claude/plugins/marketplaces/`; those are
  installed copies and changes there are lost on reinstall.
- **Build output is not source.** `dist/`, `dist-electron/`, `release/`, and
  test screenshots are generated — do not review, edit, or commit them.
- **Add focused tests** for every extracted service or pure function. Each
  workspace package must pass its own typecheck, build, and test; a green root
  run must not mask a broken package.
- **The command registry is the CLI source of truth.** Changing a signature,
  flag, or command means updating
  [docs/architecture/overview.md](docs/architecture/overview.md#scope-and-command-surface)
  in the same commit.
- **Work identity is a contract.** `BacklogItem.id`, `Run.workItemId`,
  `runId`, `parentId`, `dependsOn`, and `baseBacklogId` have distinct,
  non-interchangeable meanings — see
  [docs/architecture/overview.md](docs/architecture/overview.md#work-item-and-execution-identity).
- **UI work under `desktop-client/`** must follow
  [docs/architecture/design-system.md](docs/architecture/design-system.md).

## Documentation

[`docs/index.md`](docs/index.md) maps every document. Prefer extending an
existing document over creating a new one, and link to it from
`CLAUDE.md` rather than copying its content — duplicated text is what silently
went stale in this repo before.
