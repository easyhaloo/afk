# TUI Backlog Provider Integration

## Goal

Refactor the TUI to consume the new backlog management backend instead of the
legacy `TrackerProvider`/`TrackedIssue` data path. The TUI remains read-only,
but supports navigation and opening provider URLs in the system browser.

## Scope

Included:

- Injecting `ManagementProviderBundle` into the dashboard data layer.
- Replacing issue/label-derived board data with `BacklogItem` data.
- A TUI view model for state, execution mode, parent/dependencies, branch, and
  provider reference.
- Optional provider-neutral `BacklogItem.webUrl` for browser navigation.
- Read-only detail/list/filter interactions.
- Opening backlog, change, project, and branch URLs through the existing
  `openInBrowser()` utility.
- Keeping tmux/session data as a separate runtime read model.

Excluded:

- Claiming, running, merging, tagging, transitioning, or changing execution
  mode from the TUI.
- Replacing the Ink layout or redesigning keyboard navigation beyond removing
  write actions and adding provider-neutral links.
- Introducing a database, cache service, or new middleware.

## Architecture

```text
DashboardEntry
  -> ManagementProviderBundle (claim-free)
  -> TUI backlog data adapter
  -> BacklogViewModel[]
  -> Ink list/detail views

DashboardEntry
  -> Tmux/session read model
  -> runtime session views
```

`ManagementProviderBundle.backlog` is the only backlog capability exposed to
the TUI. It supports lookup, listing, initialization, business-tag display,
and QA-compatible state reads; it does not expose `claim()` at type or runtime.
The TUI must not instantiate a tracker client or parse provider labels.

## Data model

Add an optional `webUrl?: string` to `BacklogItem`. GitHub/GitLab providers map
their issue URL into this field. Providers without a browser URL leave it
undefined; the TUI disables the corresponding action instead of reconstructing
URLs from provider-specific IDs.

The TUI adapter maps each backlog item to a view model containing:

- `id`, `title`, `description`
- `state`, `executionMode`
- `parentId`, `dependsOn`
- `tags`, `branchName`, `providerRef`, `webUrl`

State colors and filters are based on `BacklogState`; execution colors are
based on `BacklogExecutionMode`. No `stage::*` or `mode::*` label is read by
the TUI.

## Navigation and browser actions

The detail view exposes links only when supplied by the backend/view model:

- backlog `webUrl`
- change URL when available from the read-only change provider
- branch/project URL when available from provider metadata

All external opening uses `openInBrowser(url, label)`. URLs are never passed
to shell commands directly by view components. Browser actions report success
or failure through the existing notification path and do not mutate backlog
state.

## Read-only behavior

Remove or disable TUI actions that create tasks, launch workflows, kill
sessions, claim backlog, transition state, add/remove tags, or merge changes.
Session inspection and attachment information remain read-only; lifecycle
control stays in CLI commands and workflow runners.

## Error and loading behavior

- Provider initialization and backlog loading show the existing loading/error
  states without crashing the dashboard.
- A provider failure leaves the runtime/session view usable where possible.
- Missing `webUrl` renders a non-actionable reference rather than a guessed URL.
- A stale cached item may be displayed, but refresh always replaces it with
  provider data and never writes provider state.

## Testing

Add tests for:

- dashboard data loading through a fake `ManagementProviderBundle`;
- no `claim` access from the TUI facade;
- mapping of backlog state/mode/parent/dependencies/web URL;
- filtering without platform labels;
- browser action delegation and missing-URL behavior;
- read-only guarantees (no task launch/kill/transition calls).

Run typecheck, build, focused TUI tests, full tests, and `git diff --check`.
