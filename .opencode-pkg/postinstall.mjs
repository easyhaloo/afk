#!/usr/bin/env node
/**
 * AFK — OpenCode 2.x postinstall hook.
 *
 * `opencode plugin add @easyhaloo/afk-opencode` loads the plugin entry
 * (`plugin.mjs`) but OpenCode discovers SKILLS only from on-disk skills
 * directories — it does NOT read SKILL.md from inside an installed npm
 * package. This hook bridges that gap for the *manual* `npm i` path by copying
 * the skill suite bundled in this package into the user's global OpenCode
 * skills directory:
 *
 *   target = ${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills/<skill-name>/
 *
 * NOTE: this hook only fires on a direct `npm i @easyhaloo/afk-opencode` (npm
 * runs lifecycle scripts for a direct install). The `opencode plugin add` path
 * does NOT run lifecycle scripts — that path is covered by `plugin.mjs`, whose
 * `setup(ctx)` installs the same bundled skills when OpenCode loads the plugin.
 *
 * All of the copy logic lives in `install-skills.mjs` (shared with the plugin's
 * `setup()` so there is exactly ONE copy). This file is a thin, standalone-
 * runnable wrapper: `node postinstall.mjs` installs the skills and exits 0.
 *
 * Never fails the install: a non-fatal copy error is logged as a warning and
 * the process still exits 0, so a broken postinstall can't break the install.
 * Failures are surfaced, not swallowed silently.
 *
 * Pure Node, zero dependencies.
 */

import { installSkills, printInstallSummary } from "./install-skills.mjs";

// `installSkills()` never throws (it guards everything internally), but wrap
// anyway so a postinstall error can never break `npm i`.
try {
  printInstallSummary(installSkills());
} catch (err) {
  console.warn(
    `\x1b[33m[afk-opencode] warning: postinstall could not complete (${err?.message || err}). ` +
      `The plugin is still loaded; skills may not be installed.\x1b[39m`
  );
}
process.exitCode = 0;