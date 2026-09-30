# AFK Agent Repository Constraints

Desktop architecture rules live in
[`desktop-client/ARCHITECTURE.md`](desktop-client/ARCHITECTURE.md) and are
maintained independently. Read that file before touching `desktop-client/`.

## Testing discipline

- Add focused tests for every extracted service or pure function.
- The desktop package must have independent typecheck, build, and test CI
  checks; a failure there must not be masked by the root package passing.

## Build output

- Treat `dist/`, `dist-electron/`, `release/`, and test screenshots as build
  output, not source. Do not review or edit them, and do not commit them.

## UI work

For UI changes under `desktop-client/`, follow
[`docs/architecture/design-system.md`](docs/architecture/design-system.md).
