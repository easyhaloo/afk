# 工作流配置面板统一选择器设计

## 目标

将工作流右侧配置面板中的原生 HTML `<select>` 统一替换为项目现有的 `SelectMenu` 封装组件，避免系统原生控件造成的视觉差异，并保持现有配置读写行为不变。

## 范围

- 修改 `desktop-client/src/main.tsx` 中 `WorkflowStudioInspector` 的字段渲染辅助函数。
- 带有选项列表的字段渲染 `SelectMenu`；普通文本、数字和多行文本字段保持现状。
- 保留字段标签、当前值、选项字符串、变更回调、脏状态和保存流程。
- 修改 `desktop-client/src/control.css`，为工作流配置面板内的 `SelectMenu` 提供全宽、统一高度、字体、间距和禁用状态样式，使其与现有输入控件协调。
- 增加针对工作流配置字段的组件测试，验证下拉字段使用封装组件并能完成选择，不渲染原生 `<select>`。

## 组件与数据流

`WorkflowStudioInspector.field` 接收现有的字符串值、字符串选项和回调。当 `options` 存在时，将每个字符串映射为 `SelectMenuOption`：`value` 使用原字符串，`label` 对空字符串使用“继承默认 Agent”，其他值直接作为显示文本。`SelectMenu` 触发变更后调用原有 `onChange`，由父级的 `onPatch`、`onCodexPatch` 或 `onTemplatePatch` 更新草稿。

`SelectMenu` 的默认外部点击关闭、Escape 关闭、listbox 语义和选中标记继续复用，不新增工作流专属交互逻辑。工作流面板中的选择器通过局部 CSS 选择器继承面板的颜色变量，并覆盖宽度和控件高度；其他页面的选择器样式不变。

## 错误处理与兼容性

- 空选项值仍作为合法配置值传递，显示为“继承默认 Agent”。
- 当前值不在选项列表时遵循 `SelectMenu` 现有回退行为，显示第一个选项，不修改数据，避免破坏草稿。
- 不改变 Electron 主进程、IPC、配置 schema 或 YAML 读写。
- 保持面板窄宽和 graphite 主题下的可读性，菜单超出空间时沿用现有 popover 定位逻辑。

## 验证标准

1. 工作流右侧面板中所有带选项的字段均渲染 `.select-menu`，DOM 中不存在原生 `<select>`。
2. 打开选择器显示 `role="listbox"`，点击选项后调用对应字段的原有变更回调并关闭菜单。
3. 无选项字段仍渲染输入框，数字和文本区域行为不变。
4. 现有 `SelectMenu`、工作流和桌面端类型检查/构建测试通过。
