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

# 本地插件安装/启停/卸载，以及真实本地 Provider 调用
pnpm build && pnpm exec vitest run tests/e2e/plugin-local.test.ts

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
Electron 使用[桌面架构文档](../../apps/desktop/architecture.md#end-to-end-testing)
中描述的类型化 Runtime fixture。这些测试不运行真实编码 Agent，也不修改远程仓库。

## 真实 Agent 测试

```bash
# 真实 Claude 协议、代码生成、测试执行与任务投影
CLAUDE_CONFIG_DIR="$HOME/.claude" CLAUDE_CODE_SAFE_MODE=1 pnpm test:e2e:claude

# 真实 Codex 实现、独立 QA 与远程 PR
pnpm test:e2e:codex
```

Vitest 会隔离 `HOME`，运行前应将 `CLAUDE_CONFIG_DIR` 指向已有认证的 Claude 配置目录，
复用认证而不向 fixture 复制凭据。若该目录配置了自定义 API 地址或模型，需确认安全模式下仍可使用。
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

## 插件矩阵与源码覆盖率

```sh
pnpm test:e2e:cli
pnpm test:coverage
pnpm test:coverage:report
```

插件矩阵使用构建后的 CLI 子进程、隔离 HOME、真实临时文件和 Git 仓库、loopback HTTP / TLS 服务及明确标记的命令替身。本地 97 个用例、HTTP 27 个用例、执行 67 个用例；这些数字是测试数，不是源码覆盖率。执行矩阵覆盖六种 Agent × 四种 Sandbox、四种 Trigger × 四种 Host，并检查组合完成情况。模拟 Agent、SSH、云端和容器命令不能证明真实厂商行为或容器隔离；验证器的命令替身也不能证明浏览器完成页面渲染。

经验 E2E 穿过构建后的 CLI、真实工作流引擎、Agent 子进程替身、持久经验账本和上下文组装，覆盖“失败 → 候选 → 模拟 QA 审计 → 证据门禁验证 → 后续提示词引用 → 禁用及重新启用 → 撤销”。其中 QA 审计明确为模拟。真实 Claude 验收另行运行已有无工具和完整工具 Sandbox 用例；外部 backlog 的实际状态及独立 QA 结果必须单独报告。

覆盖率包含 core、application、workflow-graph、runtime 和 CLI 的所有可执行 TypeScript 源码，未执行文件也计入。Desktop 使用独立工具链，PTY 可选测试、声明、skills / scripts 和生成文件不在此报告范围内。V8 略过的纯类型模块列为不可执行；独立 CLI、Agent、容器子进程没有被此 V8 报告采集。

产物包括 `coverage/coverage-summary.json`、`lcov.info`、`index.html`、`report.json` 和 `report.md`。采集使用匹配版本的 Vitest / V8 和单个测试 worker。CI 对报告缺失、空文件、遗漏可执行源码直接失败，测试失败时仍上传报告。`COVERAGE_BASE_REF` 选择变更基线；可配置 `COVERAGE_CHANGED_LINES`、`COVERAGE_CHANGED_STATEMENTS`、`COVERAGE_CHANGED_FUNCTIONS`、`COVERAGE_CHANGED_BRANCHES`，值为 0–100。门禁作用于完整变更文件，不是变更行；没有隐含的 80% 或全仓库覆盖率承诺。

2026 年 11 月 9 日在 Node 24.18.0 / macOS arm64 上，对集成后的实现采集：3858 项通过、4 项明确跳过，测试文件为 303 项通过、2 项跳过，完整覆盖率命令退出码为 0。

| 范围 | 行 / 语句 | 函数 | 分支 |
| --- | ---: | ---: | ---: |
| Core | 97.40% | 100.00% | 82.79% |
| Application | 97.46% | 93.02% | 92.06% |
| Workflow graph | 99.00% | 100.00% | 84.39% |
| Runtime | 90.75% | 85.02% | 86.16% |
| CLI | 70.45% | 71.88% | 75.25% |
| 本次测量范围合计 | 87.56% | 83.43% | 84.98% |

行覆盖分子 / 分母为 49931 / 57021；后续修改后以重新生成的报告为准，本次测量不代表全仓库覆盖率。已提交的 `scripts/coverage-baseline.json` 保留 11 月 8 日本地全量测量作为防回退基线，逐包及总量的行、语句、函数、分支均不得低于基线；本次测量全部通过，CI 显式载入同一基线。文件记录 Node、平台和提交来源；它是本地实测种子，不代表此前 CI 已通过覆盖率验收。首次 CI 应按实际 Node/平台评估，不能为了通过而无证据降低基线；基线缺失或格式错误直接失败。

11 月 9 日另行验证：Desktop 948 项单测、全部 99 项 Electron E2E、2 项真实 Claude Code 测试（宿主独立检查生成代码并运行 Node 测试）全部通过。前次验收还包括 Desktop 类型检查与生产构建、16 项真实 PTY 测试和 Node 22.17.0 注册表警告回归。外部厂商服务与真实容器隔离仍不属于模拟矩阵的证明范围。

CLI 0.2.43 已打包为 macOS arm64 独立发行包（5.2 MiB），在仓库外完成校验和验证、离线安装及全部 23 个命令入口检查；同一发行包已通过标准安装器安装到本机，包括当前 PATH 优先的受管命令。安装后实测认证投递持久化、制品字节、重启去重、分页、保留窗口和拒绝重放成功投递，真实 SSH 空操作也通过。此前 Gmail OAuth 与邮件送达验收保留为历史证据；11 月 9 日刷新报告 `token.network`，不据此认定当前 Gmail 可达，本次未发送新邮件。

## 反模式

- ❌ 在单元测试中渲染完整 Ink 组件而不提供尺寸上下文
- ❌ 测试外部服务（GitLab API 等），用 MSW 或 mock
- ❌ 依赖执行顺序的测试（vitest 默认并发）
- ❌ 不使用 `--update` 就手动改 snapshot 文件
