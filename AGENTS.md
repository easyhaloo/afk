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
- **Every build-script approval is a decision.** `pnpm-workspace.yaml` lists
  each dependency whose install script may run as `true` or `false`. pnpm
  writes an undecided one as the literal text `set this to true or false`;
  pnpm reads that text as "not allowed", so the install ends with
  `ERR_PNPM_IGNORED_BUILDS` and a fresh checkout cannot be installed at all.
  `pnpm architecture:check` rejects a non-boolean there.

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
- **The package graph must be acyclic, and a test is not an exception.** pnpm
  builds its task graph from the package graph, devDependencies included, so
  a package that depends on a sibling which depends back on it makes
  `pnpm -r <task>` fail with `ERR_PNPM_TASK_CYCLE` before it runs a single
  task. One test file reaching for an implementation in the package below it
  was enough to make the whole workspace impossible to run recursively.
  A test that needs an implementation asserts it where the implementation
  lives, and the package that owns the behaviour asserts its own port
  against a stub. `pnpm architecture:check` rejects a cycle.

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
- **A test must not write to, or delete, anything in the developer's home
  directory.** The runtime keeps state under `~/.afk` — the resource
  registry, the port registry, the event store — and a test that points at
  the real one both pollutes the machine and, worse, destroys state the
  developer is relying on: a cleanup that removes the port registry
  directory throws away the record of which ports are taken. Give the
  runtime an override for the directory (`AFK_PORT_REGISTRY_DIR` does this
  for the port registry) and let the test use a temporary one. Check it
  afterwards: the file's timestamp should not change when the suite runs.
- **A test that waits for a real process must budget for it.** Spawning a
  process, letting it write, and reading the result takes longer on a
  loaded machine than the operation looks like it should. A one-second
  budget for a test that spawns a process is a flake waiting to happen: it
  fails on a busy machine and passes on an idle one. Give those waits the
  same ceiling the suite has, and keep the deliberately short ones — a
  timeout of five milliseconds is a test *about* timing out.
- **The same ceiling belongs to the setup and the teardown.** Creating a
  repository, cloning it, removing it takes as long as the test that uses
  it does, so the hook gets the same budget as the test. A test that times
  out inside its own setup has still timed out.
- **Do not hand-write the types of a package you do not own.** A
  `declare module` block that describes a third-party API is a claim about
  someone else's implementation, and it drifts without a compile error. Take
  the types from the maintained `@types/*` package and let the compiler
  compare the code against them.
- **The desktop's component tests render with `react-test-renderer`, and the
  pin is deliberate.** The suite runs in a `node` environment with no DOM, so
  there is no DOM renderer to use without adding one; the package is
  deprecated upstream and prints a warning on every suite that renders
  through it. Migrating means a DOM environment and rewriting the
  assertions that read the renderer's tree, so the pin moves with the React
  version and the deprecation is a known cost rather than an accident.

## Documentation

[`docs/index.md`](docs/index.md) maps every document. Prefer extending an
existing document over creating a new one, and link to it from
`CLAUDE.md` rather than copying its content — duplicated text is what silently
went stale in this repo before.
