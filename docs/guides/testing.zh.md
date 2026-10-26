# TUI 测试指南

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

**适用场景**：
- `KeyboardDispatcher`、`ViewRegistry` 等核心类
- reducer / state machine
- 配置解析、schema 验证
- Zod schema 解析

**运行**：
```bash
pnpm --filter afk exec vitest run src/tui/shared/
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
pnpm --filter afk exec vitest run src/tui/
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
| `ink-testing-library` | Ink 组件渲染测试 |
| `node-pty` | PTY 进程控制（E2E） |

## 目录结构

```
afk/
├── apps/
│   ├── cli/src/tui/             ← CLI 单元及组件测试与源码同目录
│   └── desktop/tests/           ← 桌面端测试，使用独立配置
├── packages/
│   ├── runtime/src/             ← Runtime 测试与源码同目录
│   ├── core/src/
│   ├── application/src/
│   └── workflow-graph/src/
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
# 运行共享包、CLI 和仓库测试
pnpm test

# 桌面端测试
pnpm --dir apps/desktop test

# 完整运行 CLI 子进程、PTY 和 Electron E2E
pnpm test:e2e

# 只跑 CLI 流程（先构建可执行文件）
pnpm test:e2e:cli

# 监听模式（开发时）
pnpm --filter afk exec vitest

# 只跑单元测试
pnpm --filter @afk/runtime test
pnpm --filter afk test

# 只跑组件测试
pnpm --filter afk exec vitest run src/tui/

# 只跑 PTY E2E（需显式运行，要求真实终端）
pnpm test:e2e:pty

# 覆盖率
pnpm --filter afk exec vitest run --coverage
```

CLI 流程测试启动生产可执行文件，连接隔离的本地 GitLab HTTP fixture，覆盖命令加载、
补全、Backlog 创建与接管、标签、中断、重试、合并确认、库存、图生成、审计重放与篡改检测，
以及执行清单错误。只模拟 Provider 响应，命令解析、SDK 调用和领域状态转换使用真实实现。
Electron 使用[桌面架构文档](apps/desktop/architecture.md#end-to-end-testing)
中描述的类型化 Runtime fixture。这些测试不运行真实编码 Agent，也不修改远程仓库。

## 真实 Agent 测试

```bash
# 真实 Claude 协议、代码生成、测试执行与任务投影
CLAUDE_CODE_SAFE_MODE=1 pnpm test:e2e:claude

# 真实 Codex 实现、独立 QA 与远程 PR
pnpm test:e2e:codex
```

Claude 在临时工作区执行；测试宿主会独立检查生成的函数并重新运行其测试。
安全模式关闭用户自定义配置，保留认证和内置工具；去掉该变量即可包含本地插件和钩子。
Codex 使用当前仓库的真实 Tracker 与认证，创建专用 Issue 和分支，并校验远程文件差异。
结束后关闭测试 Issue、PR 并删除本次远程分支，不合并到目标分支。
仅在需要保留远程产物供检查时设置 `AFK_CODEX_E2E_KEEP=1`。

---

## node-pty macOS 安装问题

macOS 可能阻止 `spawn-helper` 执行（`posix_spawnp failed` 或 `permission denied`）。

先检查执行权限；缺失执行位时不需要重新签名：
```bash
chmod u+x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
```

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
