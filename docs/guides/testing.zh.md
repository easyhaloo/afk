# TUI 测试指南

AFK TUI 基于 React + Ink 构建，采用分层测试策略。

## 测试分层

```
┌─────────────────────────────────────────────────┐
│  E2E / Integration (node-pty)                   │  ← 完整终端交互、按键模拟
├─────────────────────────────────────────────────┤
│  Component (ink renderToString + sized Box)      │  ← 组件渲染测试
├─────────────────────────────────────────────────┤
│  Unit / Logic (vitest)                          │  ← 纯逻辑、状态机、reducer
└─────────────────────────────────────────────────┘
```

## 1. 单元测试（推荐起步）

**目标**：纯逻辑、状态机、事件分发器、注册表

**工具**：vitest（已配置）

**模式**：直接实例化类，调用方法，断言结果

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

**适用场景**：
- `KeyboardDispatcher`、`ViewRegistry` 等核心类
- reducer / state machine
- 配置解析、schema 验证
- Zod schema 解析

**运行**：
```bash
pnpm exec vitest run src/views/shared/
```

---

## 2. 组件测试（ink `renderToString`）

**目标**：验证 TUI 组件文本输出

**工具**：`ink` 自带的 `renderToString` + `vitest`

`ink-testing-library` **不是**本仓库的依赖。十二个 `*.test.tsx` 用的是 `ink`
自身的 `renderToString`：它把渲染结果直接返回为字符串，于是断言就是对字符串做
`toContain`，既不需要定时器，也不需要轮询帧。

**模式**：把组件渲染成字符串，对字符串断言

```typescript
import { renderToString } from 'ink';
import { Text } from 'ink';

it('renders text content', () => {
  const output = renderToString(<Text>Hello</Text>);
  expect(output).toContain('Hello');
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

**运行**：
```bash
pnpm exec vitest run src/views/
```

---

## 3. E2E 测试（node-pty）

**目标**：真实终端按键交互、完整 TUI 生命周期

**工具**：`node-pty`

**模式**：启动子进程，pty 注入按键，捕获输出

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

**运行**：`tests/pty/` 下的文件被默认配置排除，需显式运行：

```bash
pnpm test:e2e:pty
```

> **为何改为显式运行**：node-pty 1.1.0 会在 `node::Environment::CleanupHandles`
> 期间触发 ThreadSafeFunction 回调，该 C++ 异常已无 JS 栈可展开，最终走到
> `std::__terminate` 并 abort 整个 vitest worker。`vitest.config.ts` 另外设置了
> `pool: 'forks'`，把残余的 abort 关进子进程，不再拖垮整个测试套件。

---

## 测试工具链

| 工具 | 用途 |
|------|------|
| `vitest` | 测试运行器 + 断言库 |
| `node-pty` | PTY 进程控制（E2E） |
| `ink` | `renderToString`，用于 Ink 组件渲染测试 |

## 目录结构

```
afk/
├── src/
│   ├── views/shared/
│   │   ├── Keyboard.test.ts      ← 单元测试 (5 tests)
│   │   └── Registry.test.ts      ← 单元测试 (8 tests)
│   └── views/board/views/
│       └── Notification.tsx      ← 组件（无独立测试文件）
├── tests/
│   ├── e2e/
│   │   └── codex-runtime.test.ts     ← 单元测试，默认运行
│   └── pty/                          ← 放在这里的都需要真实终端
│       ├── notification.test.ts
│       ├── dashboard-layout.test.ts
│       └── tui-plugin.test.ts
├── scripts/
│   └── fix-node-pty.sh           ← node-pty macOS 签名修复
├── vitest.config.ts              ← 默认套件（pool: 'forks'，排除 tests/pty/**）
├── vitest.pty.config.ts          ← 显式运行的 tests/pty/** 套件
└── docs/
    ├── guides/testing.md
    └── guides/testing.zh.md
```

## 运行测试

```bash
# 跑全部：根套件 + 每个工作区包自己的套件
pnpm test

# 只跑根套件
pnpm exec vitest run

# 只跑某个工作区包
pnpm --filter @afk/core test

# 监听模式（开发时）
pnpm exec vitest

# 只跑组件测试
pnpm exec vitest run src/views/

# 只跑 PTY E2E（需显式运行，要求真实终端）
pnpm test:e2e:pty

# Codex runtime E2E
pnpm test:e2e:codex

# 覆盖率
pnpm exec vitest run --coverage
```

`pnpm test` 是唯一能跑全的命令：它先跑根套件，再跑六个工作区包的套件
（`@afk/core`、`@afk/application`、`@afk/infrastructure`、`@afk/execution`、
`@afk/workflow-graph` 以及根包自身）。单独跑 `vitest run` 只覆盖根套件。
`pnpm dlx vitest` 在这里是错的：它会下载一份独立的 vitest，而不是用仓库锁定的那份。

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

### 终端尺寸是夹具的一部分

`renderToString` 按当前终端尺寸排版，因此会按宽度分支的组件必须在测试里固定尺寸：

```typescript
it('renders text', () => {
  Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 100 });
  Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 16 });
  const output = renderToString(<Text>Hello</Text>);
  expect(output).toContain('Hello');
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
proc = spawn(process.execPath, [distPath], {
  cols: 80, rows: 24,
});
```

`afk` 不带参数即启动 TUI 看板。`afk board` 不是命令：调度器会拒绝它，并提示改用
不带参数的 `afk`。

---

## 反模式

- ❌ 在单元测试中渲染完整 Ink 组件而不提供尺寸上下文
- ❌ 测试外部服务（GitLab API 等），用 MSW 或 mock
- ❌ 依赖执行顺序的测试（vitest 默认并发）
- ❌ 不使用 `--update` 就手动改 snapshot 文件
