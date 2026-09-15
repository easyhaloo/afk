# 工作流配置面板统一选择器实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将工作流右侧配置面板中的原生下拉框替换为现有 `SelectMenu` 组件，并保持现有字段更新和保存行为。

**Architecture:** `WorkflowStudioInspector.field` 继续作为字段渲染入口；当传入选项数组时，将字符串选项转换为 `SelectMenu` 的 `{ value, label }` DTO，并把 `onChange` 直接桥接回原回调。工作流面板通过局部 CSS 规则约束选择器尺寸和布局，复用全局 `SelectMenu` 的交互与主题变量。

**Tech Stack:** React 18, TypeScript, lucide-react, Vitest, React Test Renderer, Vite CSS。

---

### Task 1: 为工作流检查器选择字段建立失败测试

**Files:**
- Modify: `desktop-client/tests/select-menu.test.tsx`
- Test target: `WorkflowStudioInspector` in `desktop-client/src/main.tsx`

- [ ] **Step 1: 写测试，覆盖选项映射和非原生 DOM**

在现有 `describe("SelectMenu")` 后新增测试，使用 `react-test-renderer` 加载从 `main.tsx` 导出的测试入口（若当前组件未导出，则先将 `WorkflowStudioInspector` 以 `export` 形式暴露，不改变运行时 API），传入一个自定义 Agent 节点和最小工作流模型。断言：

```tsx
expect(renderer.root.findAllByProps({ className: "select-menu" })).toHaveLength(1);
expect(renderer.root.findAllByType("select")).toHaveLength(0);
act(() => {
  renderer.root.findByProps({ className: "select-menu-trigger" }).props.onClick();
});
expect(renderer.root.findByProps({ role: "listbox", "aria-label": "执行 Agent" })).toBeTruthy();
act(() => {
  renderer.root.findAllByProps({ role: "option" })[1].props.onClick();
});
expect(onTemplatePatch).toHaveBeenCalledWith("agent-1", { provider: "codex" });
```

测试数据应提供 `WorkflowCanvasNode` 所需的 `id`、`number`、`title`、`caption` 和 `custom`，并提供 `loop`、`runs`、`onPatch`、`onCodexPatch`、`onDeleteTemplate`、`onSave` 等最小可调用桩；断言只关注选择器渲染和回调桥接。

- [ ] **Step 2: 运行单测，确认当前实现按预期失败**

Run: `cd desktop-client && pnpm vitest run tests/select-menu.test.tsx`

Expected: 新增测试 FAIL，原因是工作流检查器仍渲染原生 `select` 或检查器未提供可导出的测试入口；现有 `SelectMenu` 测试保持 PASS。

### Task 2: 用 `SelectMenu` 替换工作流检查器原生选择器

**Files:**
- Modify: `desktop-client/src/main.tsx:1-20` (import) and `desktop-client/src/main.tsx:574-589` (`WorkflowStudioInspector`)

- [ ] **Step 1: 引入组件并保留字符串回调契约**

在 `main.tsx` 顶部现有组件导入区域加入：

```tsx
import { SelectMenu } from "./components/SelectMenu";
```

将 `field` 辅助函数中的选项分支替换为：

```tsx
const field = (label: string, value: string | number, onChange: (next: string) => void, options?: string[]) => (
  <label className="workflow-field" key={label}>
    <span>{label}</span>
    {options ? (
      <SelectMenu
        label={label}
        value={String(value)}
        options={options.map((option) => ({ value: option, label: option || "继承默认 Agent" }))}
        onChange={onChange}
      />
    ) : (
      <input value={String(value)} onChange={(event) => onChange(event.target.value)} />
    )}
  </label>
);
```

将 `WorkflowStudioInspector` 改为具名导出 `export function WorkflowStudioInspector(...)`，仅用于测试复用，不改变现有调用方。

- [ ] **Step 2: 运行测试，确认选择器行为通过**

Run: `cd desktop-client && pnpm vitest run tests/select-menu.test.tsx`

Expected: `SelectMenu` 现有测试和新增工作流检查器测试全部 PASS，DOM 中没有原生 `select`。

### Task 3: 为右侧面板选择器补齐局部样式

**Files:**
- Modify: `desktop-client/src/control.css:852-881` near workflow inspector field rules

- [ ] **Step 1: 添加面板内选择器规则**

在现有 `.workflow-studio-inspector .workflow-field` 规则附近加入：

```css
.workflow-studio-inspector .workflow-field .select-menu { width: 100%; min-width: 0; }
.workflow-studio-inspector .workflow-field .select-menu-trigger {
  min-height: 32px;
  height: 32px;
  padding: 0 9px;
  border-color: #dfe0da;
  background: #fff;
  color: #30332f;
  font-family: "DM Mono", monospace;
  font-size: 9px;
}
.workflow-studio-inspector .workflow-field .select-menu-trigger:hover,
.workflow-studio-inspector .workflow-field .select-menu-trigger.open,
.workflow-studio-inspector .workflow-field .select-menu-trigger:focus-visible {
  border-color: #7180a5;
  box-shadow: 0 0 0 3px rgba(112, 128, 165, .14);
}
```

在 graphite 主题块中为同一选择器补充 `border-color: #464a44; background: #20221f; color: #e6e8e1;`，并让 hover/focus 使用现有 graphite 面板边框颜色。

- [ ] **Step 2: 运行静态检查和组件测试**

Run: `cd desktop-client && pnpm vitest run tests/select-menu.test.tsx tests/workflow-graph.test.ts && pnpm exec tsc --noEmit -p tsconfig.json`

Expected: 测试 PASS，TypeScript 无错误。

### Task 4: 完整验证并检查差异

**Files:**
- Verify: `desktop-client/src/main.tsx`
- Verify: `desktop-client/src/control.css`
- Verify: `desktop-client/tests/select-menu.test.tsx`

- [ ] **Step 1: 检查原生选择器是否只剩无关代码**

Run: `rg -n "<select|workflow-field select|SelectMenu" desktop-client/src/main.tsx desktop-client/src/control.css desktop-client/tests/select-menu.test.tsx`

Expected: `main.tsx` 的工作流检查器不再出现 `<select>`；工作流 CSS 不再依赖 `workflow-field select`；共享 `SelectMenu` 和对应样式仍存在。

- [ ] **Step 2: 运行桌面端相关测试**

Run: `cd desktop-client && pnpm test -- --run`

Expected: 全部现有测试 PASS。

- [ ] **Step 3: 查看最终差异，确保没有无关文件变化**

Run: `git diff -- desktop-client/src/main.tsx desktop-client/src/control.css desktop-client/tests/select-menu.test.tsx`

Expected: 差异仅包含选择器组件替换、局部样式和针对性测试。
