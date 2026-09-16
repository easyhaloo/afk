# Workflow Buttons and Status Labels Redesign

## Objective

Refine the workflow library and canvas editor controls without replacing the current AFK Desktop visual language. The result should feel like a precise desktop tool: compact, quiet, contextual, and easy to review.

## Confirmed Direction

- Preserve the current white workspace, orange active navigation, muted blue/green/amber semantic colors, thin borders, low-radius surfaces, and restrained shadows.
- Use Manus-style visible state and user control without turning status into a dominant visual element.
- Use Codex-style contextual actions: one clear primary action in the current scope, with secondary actions expressed as compact icon controls or quiet text actions.
- Avoid generic AI dashboard patterns: oversized pills, large rounded buttons, gradients, glow effects, and multiple competing primary actions.

## Scope

### Workflow Library

- Keep the existing library heading, grid, card dimensions, and click behavior.
- Keep the create action icon-only, but reduce its visual weight with a 26–28px control, 4–5px radius, hairline border, and no elevated shadow.
- Replace the active card's prominent filled treatment with a quiet inline status marker: a small semantic dot and `当前模板` text.
- Keep card navigation implicit through the clickable card. If a trailing affordance remains, use a lightweight arrow without a filled square container.
- Keep source labels such as `内置`, `项目`, and `AFK 管理` as metadata rather than status.
- Do not show per-template run status because `WorkflowRunSummary` currently has no reliable template identifier. This redesign does not change IPC DTOs or backend persistence.

### Workflow Studio Header

- Preserve the current three-column top bar and back navigation.
- Render `未保存` as a quiet inline amber dot plus text rather than a bordered pill.
- Keep `保存` as the only filled action in the header.
- Reduce the save control to approximately 26–28px high with a 4–5px radius, no gradient, and no floating shadow.
- Use a dark neutral primary surface so selection blue remains reserved for workflow state and canvas focus.
- Preserve disabled and `保存中…` behavior.

### Workflow Canvas Toolbar and Controls

- Preserve the existing icon-only add-step trigger and menu behavior.
- Standardize add, zoom, reset, and auto-layout controls to 24–28px visual boxes while retaining an accessible hit target of at least 28px.
- Use thin borders, low-radius corners, and a subtle one-pixel keyline for character instead of shadows or saturated backgrounds.
- Keep tooltips, `aria-label` values, keyboard focus visibility, and existing interaction semantics.
- Keep zoom percentage as neutral monospace text rather than a button.

### Workflow Nodes

- Preserve node dimensions, track colors, left semantic rail, node icons, selection border, drag behavior, and edge rendering.
- Replace the current unlabeled state dot with a compact inline status label composed of a 4–5px dot and short text.
- Do not add a background capsule around node status.
- Use the existing state vocabulary where available:
  - `active` → `运行中`
  - `complete` → `已完成`
  - `ready` → `就绪`
  - `muted` → `待执行`
- Keep status text visually secondary to the node title and metadata.

### Inspector

- Preserve the current overlay inspector, fields, select menus, footer behavior, and collapse control.
- Present runtime state as a quiet inline indicator in the header when the selected node has meaningful state.
- Do not add a large badge or a new status panel.
- Restyle inspector actions using the same compact button system as the studio header.
- Keep destructive actions semantically red but visually restrained until hover or focus.

## Control System

### Icon Control

- Visual size: 24–28px.
- Radius: 4–5px.
- Border: one-pixel neutral border.
- Background: white or transparent; accent tint only on hover, focus, or selected state.
- Shadow: none by default.
- Accessibility: fixed `aria-label`, tooltip where useful, and visible `:focus-visible` outline.

### Primary Action

- Height: 26–28px.
- Radius: 4–5px.
- Background: dark neutral in the light theme; light neutral in the graphite theme.
- No gradient, glow, or oversized horizontal padding.
- Only one filled primary action per local context.

### Secondary Action

- Same height and radius as the primary action.
- Neutral border or borderless text treatment.
- No persistent accent background.

### Status Indicator

- No capsule background for workflow node, inspector, or dirty-state indicators.
- Dot diameter: 4–5px.
- Label size: approximately 8px at the default application scale.
- Semantic colors reuse the existing workflow palette.
- Animation is limited to the active/running dot and must respect `prefers-reduced-motion`.

## Theme Behavior

- Light theme uses current neutral white and warm-gray surfaces.
- Graphite theme mirrors contrast without introducing new hues.
- Dark-theme primary actions invert to a light neutral surface rather than using a bright blue block.
- Focus rings must remain visible in both themes.

## Implementation Boundaries

- Primary files: `desktop-client/src/main.tsx` and `desktop-client/src/control.css`.
- Update `desktop-client/tests/e2e/workflow.spec.ts` only where button structure or accessible labels need verification.
- Preserve existing uncommitted select-menu styling and its E2E coverage in those files.
- Do not extract new Electron services, change IPC contracts, or introduce new dependencies.
- Do not change canvas layout, routing, normalization, dragging, zooming, saving, or workflow persistence behavior.

## Verification

- Library create action remains icon-only with `aria-label="新建工作流"`.
- Studio add action remains the only button in the add-step toolbar group and retains its menu labels.
- Save remains disabled when the draft is clean and shows `保存中…` while saving.
- Node state text is visible and does not overflow the node at supported font scales.
- Light and graphite themes maintain readable contrast.
- Existing workflow pan, zoom, drag, layout, width, and inspector select-menu tests continue to pass.
- Add focused E2E assertions for compact status markup and control dimensions where stable.

## Non-Goals

- Adding new workflow execution controls.
- Associating run history with templates.
- Changing workflow card content or information architecture.
- Redesigning navigation, global application chrome, inspector forms, or canvas geometry.
- Replacing Lucide icons or creating a new icon library.
