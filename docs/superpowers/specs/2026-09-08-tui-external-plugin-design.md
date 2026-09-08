# External TUI Plugin Design

**Date:** 2026-09-08

## Problem

AFK's TUI currently has fixed built-in views. The repository previously
contained a larger TUI Core and plugin loader, but those pieces were not wired
into the running application. We need to restore third-party TUI extension
capability without restoring the unused registry, keyboard dispatcher, and
statistics abstractions.

## Goals

- Load explicitly enabled plugins from `~/.afk/plugins/<id>/dist/index.js`.
- Let a plugin add one or more navigable Ink/React pages to the TUI.
- Keep built-in views and their existing behavior unchanged.
- Keep plugin loading failures isolated from TUI startup.
- Validate plugin metadata and reject malformed or conflicting plugins.
- Provide a small, stable, read-only plugin context.
- Cover loading, validation, conflicts, failure isolation, and rendering with
  focused tests.

## Non-goals

- Reintroducing the generic `ViewRegistry` or `KeyboardDispatcher` classes.
- Providing a plugin sandbox. A loaded local plugin has the same process
  privileges as AFK and must be treated as trusted code.
- Allowing plugins to replace built-in pages or override built-in shortcuts.
- Adding a plugin statistics or background refresh subsystem.
- Supporting arbitrary plugin configuration in this first implementation.

## Plugin Contract

Each plugin entry point exports either a default plugin object or a named
`plugin` export:

```ts
export interface TuiPlugin {
  readonly id: string;
  readonly name: string;
  readonly views: readonly TuiPluginView[];
}

export interface TuiPluginView {
  readonly id: string;
  readonly title: string;
  readonly shortcut: string;
  readonly render: (context: TuiPluginContext) => React.ReactNode;
}

export interface TuiPluginContext {
  readonly cwd: string;
  readonly workspace?: string;
  readonly notify: (message: string) => void;
}
```

Plugin view IDs are namespaced as `plugin:<plugin-id>:<view-id>` by the host;
plugins only need to provide IDs unique within their own manifest. A plugin
must have a non-empty ID and name, and every view must have a non-empty ID,
title, shortcut, and render function.

The host passes a fresh context to the active plugin view. The context exposes
only the current process directory, the selected workspace when available,
and a notification callback. It does not expose Node modules, Electron APIs,
the internal state store, or mutable provider objects.

## Discovery and Loading

The host reads `~/.afk/plugins.yml` using the existing YAML parser. The
supported shape remains:

```yaml
plugins:
  - id: example
    enabled: true
```

Only entries with `enabled` not equal to `false` are loaded. For each enabled
ID, the loader imports:

```text
~/.afk/plugins/<id>/dist/index.js
```

Loading is lazy with respect to the TUI page: plugin metadata is discovered
before navigation is built, but the plugin module is imported once during TUI
startup so invalid plugins can be removed from the available navigation list
before the first render.

The loader accepts a default export first and falls back to a named `plugin`
export. It validates the resulting object and returns normalized host-owned
descriptors. It never leaks the imported module object into the rest of the
application.

## Failure and Conflict Rules

- Missing plugin directories or entry files produce a warning and are skipped.
- Import errors, malformed manifests, and render-entry validation errors
  produce a warning and are skipped.
- Duplicate plugin IDs are loaded once, using the first configuration entry.
- Built-in view IDs and shortcuts always win.
- Duplicate plugin view IDs are skipped after the first normalized view.
- Duplicate plugin shortcuts are skipped after the first accepted view.
- A plugin failure must not prevent built-in TUI startup.
- A runtime render exception is caught at the plugin view boundary and shown as
  a plugin-specific error panel; it must not crash the host TUI process.

Warnings use the existing file/logger path where available and include the
plugin ID and failure reason without printing plugin source contents.

## TUI Integration

The current built-in navigation remains the source of truth for built-in
views. The host creates one combined list of built-in and normalized plugin
view descriptors for navigation and shortcut lookup.

Built-in views continue to render through the existing `Body`/`Footer` path.
When the active ID is a plugin view, `AppContent` renders the plugin boundary
instead of passing the ID into built-in data loaders. Plugin views do not
participate in built-in list/detail selection, project pagination, or task
mutation flows.

`DashboardEntry` owns plugin discovery and passes the resulting immutable
descriptor list and plugin context inputs to `AppContent`. This keeps file I/O
and dynamic imports outside individual React view components while preserving
the current renderer boundary.

The existing `View` union is expanded to a host-owned `TuiViewId` string type
that can represent namespaced plugin IDs. Built-in checks remain explicit, so
plugin IDs cannot accidentally enter built-in fetch or detail logic.

## Security Boundary

This feature intentionally supports trusted local plugins, not untrusted code.
Dynamic imports from `~/.afk/plugins` execute with the user's account and AFK's
process permissions. The CLI should document this before users enable a
plugin. The host must avoid adding a broader context API until a separate
sandbox design exists.

## Testing

Add focused tests for:

- YAML discovery and enabled/disabled entries.
- Default and named module exports.
- Manifest and view descriptor validation.
- Missing files and import failures being skipped.
- Built-in shortcut precedence and plugin duplicate handling.
- Namespaced IDs and combined navigation descriptors.
- Plugin rendering through the host boundary, including render failures.
- Existing built-in TUI navigation and loading behavior remaining unchanged.

Update the TUI documentation to describe the external plugin contract and
remove references to the deleted generic TUI Core classes.

## Migration and Compatibility

Existing `~/.afk/plugins.yml` files remain valid. Existing plugins that only
targeted the deleted `View`/`RegistryAPI` contracts are not automatically
compatible; they must export the new `TuiPlugin` shape. The loader should
report this as a validation warning rather than fail the entire TUI.

