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
- **The desktop client never spawns an AFK CLI process.** It calls the shared
  use cases in process. See
  [Package boundaries](#package-boundaries) below.

## Package boundaries

The root `src/` tree is the CLI and the TUI. Everything another entry point
might need lives in `packages/`.

- **Shared capability belongs in a package.** A domain model, a use case, a
  provider implementation or the execution runtime goes into
  `packages/`, not into the root tree. A use case more than one entry point
  needs goes into `@afk/application` with its dependencies behind ports, and
  the implementations into `@afk/infrastructure`. `pnpm architecture:check`
  refuses a package that reaches outside its own root, and a root `src/` file
  that reaches into a package in the wrong direction.
- **The desktop client never spawns an AFK CLI process.** It assembles the
  shared use cases in `desktop-client/electron/composition-root.ts` and calls
  them in process, so the CLI and the desktop run the same code for the same
  operation. A desktop feature that needs new behaviour adds it to a package.
  `pnpm architecture:check` rejects a desktop file that spawns `afk`.
- **A package's own modules import each other by relative path.** Importing a
  sibling by the package's own name resolves to `dist/`, which loads a second
  copy of the module and silently defeats `vi.mock` and mock-based
  assertions. `pnpm architecture:check` rejects a package that imports
  itself.

## Moving a module

- **A move is a documentation edit in the same commit.** Every backticked
  source path that names the module is a claim that it exists.
  `pnpm docs:check` verifies those paths against
  `scripts/doc-source-paths-baseline.json`: a path that stops existing, or
  starts appearing more often, fails the check.
- **Apply a bulk path rewrite once, then prove it is idempotent.** Running the
  same rewrite twice over the same tree produces doubled paths
  (`packages/x/packages/x/...`) that resolve to nothing. Run it a second time
  and diff: the second pass must change nothing.
- **Compare against the baseline tree, not the working tree.** When checking
  whether a change introduced a broken reference, resolve the baseline's
  paths with `git cat-file -e <rev>:<path>`. Judging them against the current
  tree makes every path that no longer exists look like it was always broken,
  and the regression vanishes from the comparison.
- **Move the tests with the code.** A test that exercises relocated code
  belongs to the package that now owns it, so that package's own suite covers
  it. A test that spans two packages — the execution runtime and the TUI, for
  instance — stays in the root package.

## Bundling and testing

- **A CommonJS dependency cannot be bundled into the ESM Electron main
  without a real `require`**, and a CommonJS bundle has no `import.meta`:
  point `import.meta.url` at the bundle's own location. Both are handled in
  `desktop-client/scripts/build-main.mjs` and
  `desktop-client/scripts/build-provider-inventory.mjs`; keep them that way
  when the bundle's contents change.
- **Fork the test workers when a test stubs the environment.** A worker
  thread gets a copy of `process.env`, so a test that stubs `HOME` does not
  change what `os.homedir()` returns, and a test that expects a temporary
  home reads the developer's real one. `@afk/execution` sets
  `pool: 'forks'` for this reason; a package that starts stubbing the
  environment needs the same.

## Documentation

[`docs/index.md`](docs/index.md) maps every document. Prefer extending an
existing document over creating a new one, and link to it from
`CLAUDE.md` rather than copying its content — duplicated text is what silently
went stale in this repo before.
