# TUI Testing Guide

AFK TUI is built with React + Ink and uses a layered testing strategy.

## Test Layers

```
┌─────────────────────────────────────────────────┐
│  E2E / Integration (node-pty)                   │  ← Full terminal interaction, key simulation
├─────────────────────────────────────────────────┤
│  Component (ink-testing-library + sized Box)    │  ← Component rendering tests
├─────────────────────────────────────────────────┤
│  Unit / Logic (vitest)                          │  ← Pure logic, state machines, reducers
└─────────────────────────────────────────────────┘
```

## 1. Unit Tests (Recommended Starting Point)

**Goal**: Pure logic, state machines, event dispatchers, registries

**Tool**: vitest (pre-configured)

**Pattern**: Instantiate classes directly, call methods, assert results

```typescript
// src/lib/ui/core/Keyboard.test.ts
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
pnpm dlx vitest --run src/lib/ui/core/
```

---

## 2. Component Tests (ink-testing-library)

**Goal**: Verify TUI component text output

**Tools**: `ink-testing-library` + `vitest`

**Pattern**: Render components with `render()`, check output via `lastFrame()`

```typescript
import { render } from 'ink-testing-library';
import { Text, Box } from 'ink';

beforeEach(() => vi.useRealTimers());

it('renders text content', async () => {
  const { lastFrame } = render(React.createElement(Text, null, 'Hello'));
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(lastFrame()).toContain('Hello');
});
```

### `position: absolute` Solution

**Problem**: Yoga/Flexbox calculates absolute positioning using parent container dimensions. Rendering `position: absolute` components directly produces empty output.

**Solution**: Wrap components in `<Box width={80} height={24}>` to give Yoga the terminal size context.

```typescript
// ❌ Direct render with position: absolute - empty output
const { lastFrame } = render(<Notification notification={n} animation="visible" />);

// ✅ Wrapped in sized Box - works correctly
const TestContainer = () => (
  <Box width={80} height={24}>
    <Notification notification={n} animation="visible" />
  </Box>
);
const { lastFrame } = render(React.createElement(TestContainer));
await new Promise(resolve => setTimeout(resolve, 100));
expect(lastFrame()).toContain('Test message');
```

**Full example**:

```typescript
import { render } from 'ink-testing-library';
import { Box } from 'ink';
import { Notification } from './Notification';

describe('Notification rendering', () => {
  beforeEach(() => vi.useRealTimers());

  it('renders notification message', async () => {
    const notification = { type: 'info' as const, message: 'Test message' };
    const TestContainer = () => (
      <Box width={80} height={24}>
        <Notification notification={notification} animation="visible" />
      </Box>
    );
    const { lastFrame } = render(React.createElement(TestContainer));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(lastFrame()).toContain('Test message');
  });

  it('renders nothing when notification is null', async () => {
    const TestContainer = () => (
      <Box width={80} height={24}>
        <Notification notification={null} animation="hidden" />
      </Box>
    );
    const { lastFrame } = render(React.createElement(TestContainer));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(lastFrame()).not.toContain('Message:');
  });
});
```

**Run**:
```bash
pnpm dlx vitest --run src/views/
```

---

## 3. E2E Tests (node-pty)

**Goal**: Real terminal key interactions, complete TUI lifecycle

**Tool**: `node-pty`

**Pattern**: Spawn a child process, inject keys via pty, capture output

```typescript
// tests/e2e/notification.test.ts
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
    proc = spawn(process.execPath, [distPath, 'board'], {
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

**Run**:
```bash
pnpm dlx vitest --run tests/e2e/
```

---

## Test Toolchain

| Tool | Purpose |
|------|---------|
| `vitest` | Test runner + assertion library |
| `ink-testing-library` | Ink component rendering tests |
| `node-pty` | PTY process control (E2E) |

## Directory Structure

```
afk/
├── src/
│   ├── lib/ui/core/
│   │   ├── Keyboard.test.ts      ← Unit tests (4 tests)
│   │   └── Registry.test.ts      ← Unit tests (10 tests)
│   └── views/board/views/
│       └── Notification.test.tsx ← Component tests (4 rendering + 5 logic)
├── tests/
│   └── e2e/
│       └── notification.test.ts  ← E2E tests (2 tests)
├── scripts/
│   └── fix-node-pty.sh           ← node-pty macOS signature fix
├── vitest.config.ts
└── docs/
    ├── TESTING.md
    └── TESTING_zh.md
```

## Running Tests

```bash
# Run all tests
source ~/.nvm/nvm.sh && nvm use lts/iron && pnpm dlx vitest --run

# Watch mode (development)
pnpm dlx vitest

# Unit tests only
pnpm dlx vitest --run src/lib/

# Component tests only
pnpm dlx vitest --run src/views/

# E2E only
pnpm dlx vitest --run tests/e2e/

# Coverage
pnpm dlx vitest --run --coverage
```

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

### Async Rendering Needs Wait

`ink-testing-library`'s `render()` returns a synchronous object, but Ink rendering is asynchronous:

```typescript
beforeEach(() => vi.useRealTimers());

it('renders text', async () => {
  const { lastFrame } = render(<Text>Hello</Text>);
  await new Promise(resolve => setTimeout(resolve, 100)); // Wait for render to complete
  expect(lastFrame()).toContain('Hello');
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
proc = spawn(process.execPath, [distPath, 'board'], {
  cols: 80, rows: 24,
});
```

---

## Anti-patterns

- ❌ Rendering full Ink components in unit tests without size context
- ❌ Testing external services (GitLab API, etc.) - use MSW or mocks
- ❌ Tests that depend on execution order (vitest runs concurrently by default)
- ❌ Manually editing snapshot files without `--update`
