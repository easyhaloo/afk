/**
 * AFK — OpenCode 2.x plugin entry point.
 *
 * This is the module OpenCode V2 loads when `@easyhaloo/afk-opencode` is
 * registered as a plugin (via `opencode plugin add`, a git/npm package spec, or
 * a local path entry in the `plugins` array of `opencode.json(c)`). It
 * default-exports the V2 plugin shape `{ id, setup }` documented at
 * https://opencode.ai/v2/docs/build/plugins/.
 *
 * AFK is deliberately a *thin* plugin: its substance is the skill suite bundled
 * under `skills/`, which OpenCode discovers through its own skills mechanism
 * (the `skills` array in `opencode.json(c)`, or a skills directory such as
 * `~/.config/opencode/skills`). The package's `postinstall` hook copies those
 * bundled skills into the user's OpenCode skills directory so they are
 * discoverable. This entry registers no tools, hooks, or transforms of its own
 * — it exists so the package is a valid, loadable V2 plugin and AFK appears
 * correctly in OpenCode's plugin list.
 *
 * Kept dependency-free on purpose: a distribution-layer plugin should load
 * without pulling any runtime. It must not import the `jev-agent-guard`
 * adapter (that skill owns its own host integration).
 */

const plugin = {
  id: "afk",

  async setup(ctx) {
    // No runtime behavior to register at the distribution layer. `setup` is
    // present so this is a well-formed V2 plugin; hooks/tools/transforms would
    // be registered here (e.g. `ctx.tool.hook(...)`, `ctx.session.hook(...)`)
    // if AFK ever needs them. Doing nothing is a valid plugin lifecycle.
    void ctx;
  },
};

export default plugin;