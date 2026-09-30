# Desktop Internationalization Design

## Scope

AFK Control initially supports Simplified Chinese (`zh-CN`) and US English
(`en-US`). The default preference is `system`; unsupported system locales fall
back to English. Users can override the locale from Settings.

## Boundaries

- `AppearancePreferences.locale` persists in Electron's existing
  `userData/appearance.json`; old files without the field migrate to `system`.
- The main process resolves and persists preferences but does not own UI copy.
- Renderer catalogs live in `src/i18n/`, are dependency-free, and share one
  strongly typed key set.
- Navigation, settings, status labels, errors, workflow controls, environment
  views, timestamps, tooltips, and accessibility labels use the active catalog.
- Runtime evidence remains verbatim: backlog and run IDs, event names,
  commands, paths, tmux output, provider output, and raw JSON are never
  translated.

## Verification

Unit tests cover catalog parity, locale resolution, interpolation, and legacy
preference migration. Desktop verification runs tests, typecheck, build, and
packaging, then checks both locales in the packaged application.
