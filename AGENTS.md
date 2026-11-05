# AFK Agent Repository Constraints

Rules for coding agents working in this repository. For project orientation —
tech stack, layout, documentation map, and the build/test commands — read
[`CLAUDE.md`](CLAUDE.md). Desktop rules are owned separately by
[`apps/desktop/architecture.md`](apps/desktop/architecture.md); read that
before touching `apps/desktop/`.

## Hard rules

- **`skills/` is the source of truth.** Never edit
  `~/.claude/plugins/cache/` or `~/.claude/plugins/marketplaces/`; those are
  installed copies and changes there are lost on reinstall.
- **Skill changes require a plugin version bump.** When adding or changing a
  skill (including its scripts and references), update `version` in
  `.claude-plugin/plugin.json` in the same commit. Increment at least the patch
  version; use a minor or major bump when the release requires it.
- **CLI source changes require a CLI version bump.** If source code used by the
  CLI changes — in `apps/cli/` or any workspace package the CLI depends on —
  update `version` in `apps/cli/package.json` in the same commit. Treat this
  as the release version for the CLI; do not rely on a later release commit to
  add the bump. Keep any CLI-reported version derived from this canonical value.
- **Build output is not source.** `dist/`, `dist-electron/`, `release/`, and
  test screenshots are generated — do not review, edit, or commit them.
- **Add focused tests** for every extracted service or pure function. Each
  workspace package must pass its own typecheck, build, and test; a green root
  run must not mask a broken package.
- **The command registry is the CLI source of truth.** Changing a signature,
  flag, or command means updating
  [docs/architecture/execution.md](docs/architecture/execution.md#execution-entry-points)
  in the same commit.
- **Work identity is a contract.** `BacklogItem.id`, `Run.workItemId`,
  `runId`, `parentId`, `dependsOn`, and `baseBacklogId` have distinct,
  non-interchangeable meanings — see
  [docs/architecture/overview.md](docs/architecture/overview.md#work-item-identity-and-relationships).
- **UI work under `apps/desktop/`** must follow
  [docs/architecture/design-system.md](docs/architecture/design-system.md).

## Workflow rules

- **Work on a task branch.** Never modify an existing repository's integration
  line in place. Cut `fix/*` or `feat/*` from the integration line, commit
  there, push it, and open a pull request against the integration line. The
  integration line's working tree stays clean — check `git status --porcelain`
  is empty before handing the work over.
- **The merge is a person's decision.** AFK publishes the change request and
  stops there. An agent never merges a pull request or a merge request on a
  human's behalf.
- **A PRD accumulates on its own baseline branch.** A slice of a PRD is written
  on `prd/<prd issue number>` and merges into it; the baseline branch merges
  into the repository's integration line once the whole PRD is done. A slice
  never lands on the integration line directly. See
  [ADR-0024](docs/adr/0024-prd-baseline-branches.md) and the
  [execution architecture](docs/architecture/execution.md#prd-baseline-branches).
- **Provider data changes go through the AFK CLI.** Labels, relations, and
  roles are written with the AFK CLI commands rather than by calling the
  provider API directly. A provider edit the CLI does not support is a gap in
  the CLI: extend the CLI first.

## Documentation

[`docs/index.md`](docs/index.md) maps every document. Prefer extending an
existing document over creating a new one, and link to it from
`CLAUDE.md` rather than copying its content — duplicated text is what silently
went stale in this repo before.
