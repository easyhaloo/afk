# TUI Testing Guide

AFK TUI 基于 React + Ink 构建，采用分层测试策略。

## 测试分层

```
┌─────────────────────────────────────────────────┐
│  E2E / Integration (node-pty)                   │  ← 完整终端交互、按键模拟
├─────────────────────────────────────────────────┤
│  Component (ink-testing-library + sized Box)    │  ← 组件渲染测试
├─────────────────────────────────────────────────┤
│  Unit / Logic (vitest)                          │  ← 纯逻辑、状态机、reducer
└─────────────────────────────────────────────────┘
```

## 1. 单元测试（推荐起步）

**目标**：纯逻辑、状态机、事件分发器、注册表

**工具**：vitest（已配置）

**模式**：直接实例化类，调用方法，断言结果

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

**适用场景**：
- `KeyboardDispatcher`、`ViewRegistry` 等核心类
- reducer / state machine
- 配置解析、schema 验证
- Zod schema 解析

**运行**：
```bash
pnpm dlx vitest --run src/lib/ui/core/
```

---

## 2. 组件测试（ink-testing-library）

**目标**：验证 TUI 组件文本输出

**工具**：`ink-testing-library` + `vitest`

**模式**：用 `render()` 渲染组件，通过 `lastFrame()` 检查输出

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

### `position: absolute` 解决方案

**问题**：Yoga/Flexbox 计算绝对定位需要父容器尺寸。直接渲染 `position: absolute` 组件会输出空。

**解决**：用 `<Box width={80} height={24}>` 包裹组件，为 Yoga 提供终端尺寸上下文。

```typescript
// ❌ 直接渲染 position:absolute - 输出空
const { lastFrame } = render(<Notification notification={n} animation="visible" />);

// ✅ 用 sized Box 包裹 - 正常工作
const TestContainer = () => (
  <Box width={80} height={24}>
    <Notification notification={n} animation="visible" />
  </Box>
);
const { lastFrame } = render(React.createElement(TestContainer));
await new Promise(resolve => setTimeout(resolve, 100));
expect(lastFrame()).toContain('Test message');
```

**完整示例**：

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

**运行**：
```bash
pnpm dlx vitest --run src/views/
```

---

## 3. E2E 测试（node-pty）

**目标**：真实终端按键交互、完整 TUI 生命周期

**工具**：`node-pty`

**模式**：启动子进程，pty 注入按键，捕获输出

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

**运行**：
```bash
pnpm dlx vitest --run tests/e2e/
```

---

## 测试工具链

| 工具 | 用途 |
|------|------|
| `vitest` | 测试运行器 + 断言库 |
| `ink-testing-library` | Ink 组件渲染测试 |
| `node-pty` | PTY 进程控制（E2E） |

## 目录结构

```
afk/
├── src/
│   ├── lib/ui/core/
│   │   ├── Keyboard.test.ts      ← 单元测试 (4 tests)
│   │   └── Registry.test.ts      ← 单元测试 (10 tests)
│   └── views/board/views/
│       └── Notification.test.tsx ← 组件测试 (4 rendering + 5 logic)
├── tests/
│   └── e2e/
│       └── notification.test.ts  ← E2E 测试 (2 tests)
├── scripts/
│   └── fix-node-pty.sh           ← node-pty macOS 签名修复
├── vitest.config.ts
└── docs/
    └── TESTING.md
```

## 运行测试

```bash
# 运行所有测试
source ~/.nvm/nvm.sh && nvm use lts/iron && pnpm dlx vitest --run

# 监听模式（开发时）
pnpm dlx vitest

# 只跑单元测试
pnpm dlx vitest --run src/lib/

# 只跑组件测试
pnpm dlx vitest --run src/views/

# 只跑 E2E
pnpm dlx vitest --run tests/e2e/

# 覆盖率
pnpm dlx vitest --run --coverage
```

---

## node-pty macOS 安装问题

macOS 可能阻止 `spawn-helper` 执行（`posix_spawnp failed` 或 `permission denied`）。

**修复脚本**：
```bash
./scripts/fix-node-pty.sh --force
```

**手动修复**：
```bash
# 重新签名
sudo codesign --force --deep --sign - node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper

# 清除扩展属性
sudo xattr -cr node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper

# 验证
node -e "const {spawn}=require('node-pty');spawn('node',['--version'],{cols:80,rows:24}).onData(d=>console.log(d)).onExit(()=>process.exit())"
```

---

## TUI 测试要点

### 异步渲染需等待

`ink-testing-library` 的 `render()` 返回同步对象，但 Ink 渲染是异步的：

```typescript
beforeEach(() => vi.useRealTimers());

it('renders text', async () => {
  const { lastFrame } = render(<Text>Hello</Text>);
  await new Promise(resolve => setTimeout(resolve, 100)); // 等待渲染完成
  expect(lastFrame()).toContain('Hello');
});
```

### 随机输出

TUI 中常有动态内容（时间戳、随机 ID）。测试时：

- Mock `Date.now()` 或时间相关函数
- 使用固定 seed 的随机数
- Golden 文件中用正则匹配动态部分

### PTY 尺寸

E2E 测试中指定终端尺寸：

```typescript
proc = spawn(process.execPath, [distPath, 'board'], {
  cols: 80, rows: 24,
});
```

---

## 反模式

- ❌ 在单元测试中渲染完整 Ink 组件而不提供尺寸上下文
- ❌ 测试外部服务（GitLab API 等），用 MSW 或 mock
- ❌ 依赖执行顺序的测试（vitest 默认并发）
- ❌ 不使用 `--update` 就手动改 snapshot 文件
