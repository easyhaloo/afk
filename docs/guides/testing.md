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
// apps/cli/src/tui/shared/keyboard.test.ts
import { KeyboardDispatcher } from './index';

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
pnpm --filter afk exec vitest run src/tui/shared/
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
pnpm --filter afk exec vitest run src/tui/
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
const distPath = join(__dirname, '../../apps/cli/dist/index.js');

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
| `ink-testing-library` | Ink component rendering tests |
| `node-pty` | PTY process control (E2E) |

## Directory Structure

```
afk/
├── apps/
│   ├── cli/src/tui/             ← CLI unit and component tests beside source
│   └── desktop/tests/           ← Desktop tests, run with its own config
├── packages/
│   ├── runtime/src/             ← Runtime tests beside source
│   ├── core/src/
│   ├── application/src/
│   └── workflow-graph/src/
├── tests/
│   ├── e2e/
│   │   └── codex-runtime.test.ts     ← unit test, runs by default
│   └── pty/                          ← anything here needs a real terminal
│       ├── notification.test.ts
│       ├── dashboard-layout.test.ts
│       └── tui-plugin.test.ts
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
# Run shared packages, CLI and repository tests
pnpm test

# Desktop tests
pnpm --dir apps/desktop test

# Full CLI subprocess, PTY and Electron E2E suites
pnpm test:e2e

# CLI workflows only (builds the executable first)
pnpm test:e2e:cli

# Local plugin install/enable/disable/remove and real local provider operations
pnpm build && pnpm exec vitest run tests/e2e/plugin-local.test.ts

# Watch mode (development)
pnpm --filter afk exec vitest

# Unit tests only
pnpm --filter @afk/runtime test
pnpm --filter afk test

# Component tests only
pnpm --filter afk exec vitest run src/tui/

# PTY E2E only (opt-in, needs a real terminal)
pnpm test:e2e:pty

# Coverage
pnpm --filter afk exec vitest run --coverage
```

CLI workflow tests launch the production executable against an isolated local
GitLab HTTP fixture. They cover command loading, completion, backlog creation,
adoption, tags, interruption, retry, merge confirmation, inventory, graph output,
audit replay and corruption, plus execution-manifest errors. Provider responses
are simulated; command parsing, SDK calls and domain transitions remain real.
Electron uses the typed Runtime fixtures described in
[Desktop architecture](../../apps/desktop/architecture.md#end-to-end-testing).
These suites do not run a live coding agent or mutate a remote repository.

## Live Agent Tests

```bash
# Real Claude protocol, code generation, test execution and task projection
CLAUDE_CONFIG_DIR="$HOME/.claude" CLAUDE_CODE_SAFE_MODE=1 pnpm test:e2e:claude

# Real Codex implementation, independent QA and remote pull request
pnpm test:e2e:codex
```

Vitest isolates `HOME`; set `CLAUDE_CONFIG_DIR` to the existing authenticated Claude
configuration directory before starting the tests. This reuses its authentication
without copying credentials into fixtures. If a custom API endpoint or model is
defined there, confirm it remains available in safe mode.
Claude runs in temporary workspaces; the host independently checks its generated
function and reruns its tests. Safe mode disables user customizations while
preserving authentication and built-in tools. Omit it to include local plugins
and hooks. Codex uses the current repository's real tracker and credentials,
creates a dedicated issue and branches, and verifies the remote fixture diff.
It closes the test issue and pull request and deletes its remote branches on
completion. It does not merge into the target branch. Set `AFK_CODEX_E2E_KEEP=1`
only when the remote artifacts should be retained for inspection.

---

## node-pty macOS Installation Issues

macOS may block `spawn-helper` execution (`posix_spawnp failed` or `permission denied`).

Check its executable bit first; a missing bit does not require re-signing:
```bash
chmod u+x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
```

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

## Plugin matrix and source coverage

```sh
pnpm test:e2e:cli
pnpm test:coverage
pnpm test:coverage:report
```

The plugin matrix exercises built CLI subprocesses with isolated HOME directories,
real temporary files/Git repositories, loopback HTTP/TLS services and explicit command
fixtures. Local: 97 cases; HTTP: 27 cases; execution: 67 cases. These are test cases,
not source coverage percentages. The execution matrix covers all six Agents against
four Sandbox adapters and four Triggers against four Host adapters, with explicit
pair-completion assertions. Simulated Agent/SSH/cloud/container commands do not prove
live vendor behavior or container isolation. Verification command fixtures do not
prove that a browser rendered a page.

The learning E2E crosses the built CLI, actual workflow runner, subprocess Agent
fixture, durable experience store and context assembly: failure → candidate →
synthetic QA audit → guarded verification → later prompt reference → disable/re-enable → revocation.
The QA audit in this test is explicitly synthetic. Real Claude acceptance separately
executes the existing no-tool and full-tool sandbox tests; external backlog execution
must separately show its real provider state and independent QA verdict.

Coverage includes every executable TypeScript source in core, application,
workflow-graph, runtime and CLI, including untested files. It excludes Desktop's
separate toolchain, opt-in PTY tests, declarations, skills/scripts and generated output.
Pure type-only modules omitted by V8 are inventoried as non-executable. Separate CLI,
Agent and container subprocesses are not instrumented by this V8 report.

Reports are `coverage/coverage-summary.json`, `lcov.info`, `index.html`, `report.json`
and `report.md`. The collector uses the installed Vitest version with matching V8
support and one test worker. CI fails on missing/empty artifacts or omitted executable
source, and uploads reports even when coverage tests fail. `COVERAGE_BASE_REF` selects
the changed-file comparison. Optional `COVERAGE_CHANGED_LINES`,
`COVERAGE_CHANGED_STATEMENTS`, `COVERAGE_CHANGED_FUNCTIONS` and
`COVERAGE_CHANGED_BRANCHES` are percentage gates from 0 to 100. They apply to whole
changed files, not changed lines. No unstated 80% or full-repository gate is implied.

The integrated implementation measured on November 9, 2026 with Node 24.18.0/macOS
arm64 produced 3,858 passing tests and four explicit skips across 303 passing test
files and two skipped files. The full coverage command exited successfully:

| Scope | Lines / statements | Functions | Branches |
| --- | ---: | ---: | ---: |
| Core | 97.40% | 100.00% | 82.79% |
| Application | 97.46% | 93.02% | 92.06% |
| Workflow graph | 99.00% | 100.00% | 84.39% |
| Runtime | 90.75% | 85.02% | 86.16% |
| CLI | 70.45% | 71.88% | 75.25% |
| Combined measured scope | 87.56% | 83.43% | 84.98% |

The measured line numerator/denominator is 49,931/57,021. Use the generated report
after later changes; this measurement does not establish whole-repository coverage.
The checked-in `scripts/coverage-baseline.json` retains the November 8 measurement as
the nonregression seed. Every package and the total must retain its baseline
line/statement/function/branch percentage; the November 9 run passes every gate,
and CI explicitly loads the same baseline.
The baseline records its Node/platform/commit provenance. This is a measured local
seed, not a claim that a prior CI coverage run passed; evaluate the first CI result
on its actual Node/platform before changing a baseline. Missing or invalid baseline
data fails rather than silently disabling the gate.

Separately validated on November 9: 948 Desktop unit tests, all 99 Electron E2E
tests and two real Claude Code tests, including generated code independently
checked and tested by the host. Desktop typecheck/production build, 16 real-PTY
tests and the Node 22.17.0 registry-warning regression also passed in the preceding
acceptance. External vendor services and real container isolation remain outside
the synthetic matrix's evidence boundary.

The CLI 0.2.43 release was also packaged for macOS arm64 (5.2 MiB archive), installed
offline outside the repository with checksum verification, and checked across all
23 command entry points. The same archive is installed locally through the standard
installer, including the managed executable that currently leads PATH. An installed
CLI smoke test additionally verifies authenticated durable receipt, actual artifact
bytes, restart deduplication, pagination, retention and rejection of replaying a
successful delivery. A real SSH no-op also passed. The earlier Gmail OAuth/mail
delivery acceptance remains historical: the November 9 refresh attempt reported
`token.network`, so current Gmail reachability is not accepted. No new email was sent.

## Anti-patterns

- ❌ Rendering full Ink components in unit tests without size context
- ❌ Testing external services (GitLab API, etc.) - use MSW or mocks
- ❌ Tests that depend on execution order (vitest runs concurrently by default)
- ❌ Manually editing snapshot files without `--update`
