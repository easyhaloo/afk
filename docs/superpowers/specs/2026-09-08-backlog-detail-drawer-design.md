# Backlog Detail Drawer Design

## Goal

Improve the desktop Backlog experience with an in-context detail preview, a
safe external-browser action, and application-styled controls instead of
native selects.

## Interaction

- Selecting a Backlog card opens a right-side drawer without leaving the list.
- The drawer loads the canonical item through `backlog.show`, displays its
  description and metadata, and can be dismissed with Escape, the close
  button, or the backdrop.
- The external-browser action is rendered only when `webUrl` exists. The main
  process accepts only `http` and `https` URLs before delegating to Electron's
  external opener.
- Provider and state filters use compact custom listbox controls. Existing
  create and tag flows remain intact.

## Architecture

- Add a `desktop.openExternal` command to the shared DTO/API contract,
  preload whitelist, and sender-guarded IPC registration.
- Keep data fetching in `BacklogPage`; keep drawer presentation in a focused
  `BacklogDetailDrawer` component.
- Use existing `lucide-react` icons and CSS variables so the feature follows
  the current desktop visual language.

## Acceptance Criteria

1. Clicking a Backlog item opens a right-side detail preview with canonical
   item data.
2. The preview can open an available `webUrl` in the external browser.
3. Provider and state controls are custom application UI, with no native
   `<select>` controls in the Backlog page.
4. Focus, Escape, loading, failure, and missing-URL states are covered by
   focused tests.
