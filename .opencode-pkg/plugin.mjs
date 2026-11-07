/**
 * AFK — OpenCode 2.x plugin entry point.
 *
 * This is the module OpenCode V2 loads when `@easyhaloo/afk-opencode` is
 * registered as a plugin (via `opencode plugin add`, a git/npm package spec, or
 * a local path entry in the `plugins` array of `opencode.json(c)`). It
 * default-exports the V2 plugin shape `{ id, setup }` documented at
 * https://opencode.ai/v2/docs/build/plugins/.
 *
 * AFK's substance is the skill suite bundled under `skills/`, which OpenCode
 * discovers through its own skills mechanism (a skills directory such as
 * `~/.config/opencode/skills`). The catch: OpenCode does NOT read `SKILL.md`
 * from inside an installed npm package, and `opencode plugin add` does NOT run
 * npm lifecycle scripts — so a `postinstall` hook alone never fires on the
 * OpenCode install path. That is exactly why `setup(ctx)` below installs the
 * bundled skills: OpenCode CALLS `setup(ctx)` every time it loads the plugin,
 * so skills get installed on the path users actually use.
 *
 * `setup()` delegates to the shared `install-skills.mjs` module and is:
 *   - Idempotent & cheap: a skill dir is only rewritten when its content
 *     actually differs, and repeat sessions log at most one concise line, so
 *     calling setup() on every session start is quiet and fast.
 *   - Non-destructive: never deletes unrelated skills.
 *   - Fail-safe: wrapped so a copy error can never break plugin load.
 *
 * This entry registers no tools, hooks, or transforms of its own — it exists so
 * the package is a valid, loadable V2 plugin, AFK appears correctly in
 * OpenCode's plugin list, and its skills land on disk where OpenCode can find
 * them.
 *
 * Kept dependency-free on purpose: a distribution-layer plugin should load
 * without pulling any runtime. It must not import the `jev-agent-guard`
 * adapter (that skill owns its own host integration).
 */

import { installSkills, printInstallSummary } from "./install-skills.mjs";

const plugin = {
  id: "afk",

  async setup(ctx) {
    // No hooks/tools/transforms to register at the distribution layer; `setup`
    // is present so this is a well-formed V2 plugin. Its real job is to make
    // the bundled skills discoverable on the OpenCode load path (which skips
    // npm lifecycle scripts). Hooks/tools would be registered here
    // (e.g. `ctx.tool.hook(...)`, `ctx.session.hook(...)`) if AFK ever needs
    // them.
    void ctx;

    // Install/refresh the bundled skills into the user's OpenCode skills dir.
    // `installSkills` already guards every failure internally and never throws,
    // but we wrap it too so nothing here can ever break plugin load.
    try {
      const summary = installSkills();
      printInstallSummary(summary);
    } catch (err) {
      console.warn(
        `\x1b[33m[afk-opencode] warning: setup could not install skills (${err?.message || err}). ` +
          `The plugin is still loaded.\x1b[39m`
      );
    }
  },
};

export default plugin;