# TUI Testing Guide

AFK TUI is built with React + Ink and uses a layered testing strategy.

## Test Layers

```
┌─────────────────────────────────────────────────┐
│  E2E / Integration (node-pty)                   │  ← Full terminal interaction, key simulation
├─────────────────────────────────────────────────┤
│  Component (ink renderToString + sized Box)      │  ← Component rendering tests
├─────────────────────────────────────────────────┤
│  Unit / Logic (vitest)                          │  ← Pure logic, state machines, reducers
└─────────────────────────────────────────────────┘
```

## 1. Unit Tests (Recommended Starting Point)

**Goal**: Pure logic, state machines, event dispatchers, registries

**Tool**: vitest (pre-configured)

**Pattern**: Instantiate classes directly, call methods, assert results

```typescript
// src/views/shared/Keyboard.test.ts
import { KeyboardDispatcher } from './Keyboard';

it('dispatches escape to global handler', () => {
  const dispatcher = new KeyboardDispatcher();
  const handler = vi.fn();
  dispatcher.registerGlobal('escape', handler);
  dispatcher.dispatch({ key: 'escape', input: '', ctrl: false, shift: false, meta: false });
  expect(handler).toHaveBeenCalled();
});
```

**Use cases**:
- Core classes like `KeyboardDispatcher`, `ViewRegistry`
- Reducers / state machines
- Config parsing, schema validation
- Zod schema parsing

**Run**:
```bash
pnpm exec vitest run src/views/shared/
```

---

## 2. Component Tests (ink `renderToString`)

**Goal**: Verify TUI component text output

**Tools**: `ink`'s `renderToString` + `vitest`

`ink-testing-library` is **not** a dependency of this repository. The twelve
`*.test.tsx` files render with `renderToString` from `ink` itself: it returns
the rendered frame as a string, so an assertion is a plain `toContain` against
that string and no timer or frame polling is involved.

**Pattern**: Render the component to a string, assert on the string

```typescript
import { renderToString } from 'ink';
import { Text } from 'ink';

it('renders text content', () => {
  const output = renderToString(<Text>Hello</Text>);
  expect(output).toContain('Hello');
});
```

### `position: absolute` Solution

**Problem**: Yoga/Flexbox calculates absolute positioning using parent container dimensions. Rendering `position: absolute` components directly produces empty output.

**Solution**: Wrap components in `<Box width={80} height={24}>` to give Yoga the terminal size context.

```typescript
// ❌ Direct render with position: absolute - empty output
const output = renderToString(<Notification notification={n} animation="visible" />);

// ✅ Wrapped in sized Box - works correctly
const TestContainer = () => (
  <Box width={80} height={24}>
    <Notification notification={n} animation="visible" />
  </Box>
);
const output = renderToString(<TestContainer />);
expect(output).toContain('Test message');
```

**Full example**:

```typescript
import { renderToString } from 'ink';
import { Box } from 'ink';
import { Notification } from './Notification';

describe('Notification rendering', () => {
  it('renders notification message', () => {
    const notification = { type: 'info' as const, message: 'Test message' };
    const TestContainer = () => (
      <Box width={80} height={24}>
        <Notification notification={notification} animation="visible" />
      </Box>
    );
    const output = renderToString(<TestContainer />);
    expect(output).toContain('Test message');
  });

  it('renders nothing when notification is null', () => {
    const TestContainer = () => (
      <Box width={80} height={24}>
        <Notification notification={null} animation="hidden" />
      </Box>
    );
    const output = renderToString(<TestContainer />);
    expect(output).not.toContain('Message:');
  });
});
```

**Run**:
```bash
pnpm exec vitest run src/views/
```

---

## 3. E2E Tests (node-pty)

**Goal**: Real terminal key interactions, complete TUI lifecycle

**Tool**: `node-pty`

**Pattern**: Spawn a child process, inject keys via pty, capture output

```typescript
// tests/pty/notification.test.ts
import { spawn } from 'node-pty';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distPath = join(__dirname, '../../dist/index.js');

// Detect node-pty at module load time
let nodePtyWorks = false;
try {
  const testPty = spawn('node', ['--version'], { cols: 80, rows: 24 });
  testPty.onData(() => {});
  testPty.onExit(() => {});
  testPty.kill();
  nodePtyWorks = true;
} catch {
  nodePtyWorks = false;
}

const describeE2E = nodePtyWorks ? describe : describe.skip;

describeE2E('Notification E2E', () => {
  let proc: ReturnType<typeof spawn> | null = null;

  afterEach(() => { if (proc) proc.kill(); });

  it('renders with absolute positioning', async () => {
    proc = spawn(process.execPath, [distPath], {
      cols: 80, rows: 24,
      env: { ...process.env, NO_TMUX: '1' },
    });
    const output: string[] = [];
    proc.onData((data) => output.push(data));
    await new Promise(resolve => setTimeout(resolve, 500));
    proc.kill();
    expect(output.join('').length).toBeGreaterThan(0);
  });
});
```

**Run**: anything in `tests/pty/` is excluded from the default config and runs opt-in.

```bash
pnpm test:e2e:pty
```

> **Why opt-in**: node-pty 1.1.0 fires its ThreadSafeFunction callback during
> `node::Environment::CleanupHandles`; the C++ exception has no JS stack to
> unwind into, so `std::__terminate` aborts the whole vitest worker. `vitest.config.ts`
> also sets `pool: 'forks'` so any remaining abort is contained to one child
> process instead of taking the suite down with it.

---

## Test Toolchain

| Tool | Purpose |
|------|---------|
| `vitest` | Test runner + assertion library |
| `node-pty` | PTY process control (E2E) |
| `ink` | `renderToString` for Ink component rendering tests |

## Directory Structure

```
afk/
├── src/
│   ├── views/shared/
│   │   ├── Keyboard.test.ts      ← Unit tests (5 tests)
│   │   └── Registry.test.ts      ← Unit tests (8 tests)
│   └── views/board/views/
│       └── Notification.tsx      ← Component (no dedicated test file)
├── packages/
│   ├── afk-core/tests/               ← package suite, own `test` script
│   ├── afk-application/tests/
│   ├── afk-infrastructure/tests/
│   ├── afk-execution/tests/
│   └── afk-workflow-graph/tests/
├── tests/
│   ├── architecture-guard.test.ts    ← repository-level invariants
│   ├── contract/                     ← cross-layer contracts
│   ├── e2e/
│   │   └── codex-runtime.test.ts     ← unit test, runs by default
│   └── pty/                          ← anything here needs a real terminal
│       ├── notification.test.ts
│       ├── dashboard-layout.test.ts
│       └── tui-plugin.test.ts
├── desktop-client/tests/             ← Electron process boundary, own test script
│   ├── e2e/                          ← Playwright
│   ├── electron/                     ← main-process services
│   └── shared/
├── scripts/
│   └── fix-node-pty.sh           ← node-pty macOS signature fix
├── vitest.config.ts              ← default suite (pool: 'forks', excludes tests/pty/**)
├── vitest.pty.config.ts          ← opt-in tests/pty/** suite
└── docs/
    ├── guides/testing.md
    └── guides/testing.zh.md
```

## Running Tests

```bash
# Run everything: the root suite plus every workspace package's own suite
pnpm test

# The root suite alone
pnpm exec vitest run

# One workspace package's suite
pnpm --filter @afk/core test

# Watch mode (development)
pnpm exec vitest

# Component tests only
pnpm exec vitest run src/views/

# PTY E2E only (opt-in, needs a real terminal)
pnpm test:e2e:pty

# Codex runtime E2E
pnpm test:e2e:codex

# Coverage
pnpm exec vitest run --coverage
```

`pnpm test` is the only command that runs everything. It is
`vitest run` at the root followed by the six workspace package suites
(`@afk/core`, `@afk/application`, `@afk/infrastructure`, `@afk/execution`,
`@afk/workflow-graph`, and the root's own). A bare `vitest run` covers the
root suite only. `pnpm dlx vitest` is wrong here as well: it downloads a
standalone vitest instead of using the pinned one.

---

## node-pty macOS Installation Issues

macOS may block `spawn-helper` execution (`posix_spawnp failed` or `permission denied`).

**Fix script**:
```bash
./scripts/fix-node-pty.sh --force
```

**Manual fix**:
```bash
# Re-sign
sudo codesign --force --deep --sign - node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper

# Clear extended attributes
sudo xattr -cr node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper

# Verify
node -e "const {spawn}=require('node-pty');spawn('node',['--version'],{cols:80,rows:24}).onData(d=>console.log(d)).onExit(()=>process.exit())"
```

---

## TUI Testing Tips

### Terminal Size Is Part of the Fixture

`renderToString` lays the component out against the current terminal size, so
a component that branches on width needs the size pinned for the test:

```typescript
it('renders text', () => {
  Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 100 });
  Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 16 });
  const output = renderToString(<Text>Hello</Text>);
  expect(output).toContain('Hello');
});
```

### Random Output

TUI often has dynamic content (timestamps, random IDs). When testing:

- Mock `Date.now()` or time-related functions
- Use seeded random number generators
- Use regex to match dynamic parts in golden files

### PTY Dimensions

Specify terminal dimensions in E2E tests:

```typescript
proc = spawn(process.execPath, [distPath], {
  cols: 80, rows: 24,
});
```

`afk` with no arguments launches the TUI board. `afk board` is not a command:
the dispatcher rejects it and tells you to run `afk` with no arguments.

---

## Anti-patterns

- ❌ Rendering full Ink components in unit tests without size context
- ❌ Testing external services (GitLab API, etc.) - use MSW or mocks
- ❌ Tests that depend on execution order (vitest runs concurrently by default)
- ❌ Manually editing snapshot files without `--update`
