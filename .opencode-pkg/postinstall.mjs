#!/usr/bin/env node
/**
 * AFK — OpenCode 2.x postinstall hook.
 *
 * `opencode plugin add @easyhaloo/afk-opencode` loads the plugin entry
 * (`plugin.mjs`) but OpenCode discovers SKILLS only from on-disk skills
 * directories — it does NOT read SKILL.md from inside an installed npm
 * package. This hook bridges that gap by copying the skill suite bundled in
 * this package into the user's global OpenCode skills directory:
 *
 *   target = ${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills/<skill-name>/
 *
 * Design guarantees:
 *   - Idempotent: re-running refreshes AFK-owned skill dirs; safe to reinstall.
 *   - Non-destructive: never deletes unrelated skills already present. On a
 *     name collision it logs a note and refreshes the AFK-owned directory.
 *   - Skips `jev-agent-guard`, which owns its own host integration (installs
 *     hooks/plugins into claude-code/codex/opencode) and must be opt-in.
 *   - Never fails the install: a non-fatal copy error is logged as a warning
 *     and the process still exits 0, so a broken postinstall can't break
 *     `opencode plugin add`. Failures are surfaced, not swallowed silently.
 *
 * Pure Node (node:fs, node:path), zero dependencies. The bundled skills dir is
 * resolved relative to `import.meta.url` so it works regardless of where npm
 * cached or unpacked the package.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_MANIFEST = "SKILL.md";

/** Skills excluded from auto-copy, with the reason surfaced to the user. */
const SKIPPED = new Map([
  [
    "jev-agent-guard",
    "it owns its own host integration (installs hooks/plugins into " +
      "claude-code/codex/opencode) and is opt-in",
  ],
]);

/** Best-effort brand color for the summary line. */
const c = {
  bold: (s) => `\x1b[1m${s}\x1b[22m`,
  green: (s) => `\x1b[32m${s}\x1b[39m`,
  yellow: (s) => `\x1b[33m${s}\x1b[39m`,
  dim: (s) => `\x1b[2m${s}\x1b[22m`,
};

function opencodeSkillsDir() {
  const configHome =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim() !== ""
      ? process.env.XDG_CONFIG_HOME
      : join(process.env.HOME || process.env.USERPROFILE || "", ".config");
  return join(configHome, "opencode", "skills");
}

/**
 * Copy one skill directory into `targetDir`. Removes any existing dir at the
 * destination first so a stale install is fully refreshed (not merged).
 */
function installSkill(srcDir, destDir) {
  if (existsSync(destDir)) {
    const st = statSync(destDir);
    if (!st.isDirectory()) {
      // A non-directory is sitting where the skill should go — replace it.
      rmSync(destDir, { force: true });
    } else {
      rmSync(destDir, { recursive: true, force: true });
    }
  }
  mkdirSync(dirname(destDir), { recursive: true });
  cpSync(srcDir, destDir, { recursive: true });
}

function main() {
  const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)));
  const bundledSkillsDir = join(pkgRoot, "skills");

  if (!existsSync(bundledSkillsDir)) {
    console.warn(
      c.yellow(
        "[afk-opencode] warning: bundled skills/ directory not found; " +
          "plugin loaded but no skills were installed."
      )
    );
    return;
  }

  const targetDir = opencodeSkillsDir();

  // Collect bundled skill dirs (a "skill" = a directory containing SKILL.md).
  let bundled;
  try {
    bundled = readdirSync(bundledSkillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (err) {
    console.warn(
      c.yellow(
        `[afk-opencode] warning: could not read bundled skills (${err?.message}); ` +
          "plugin loaded but no skills were installed."
      )
    );
    return;
  }

  const installed = [];
  const skipped = [];
  const failed = [];

  for (const name of bundled) {
    const srcDir = join(bundledSkillsDir, name);
    // Only treat it as a skill if it has a SKILL.md; copy the whole dir anyway
    // but keyed on the manifest so we don't copy stray non-skill directories.
    if (!existsSync(join(srcDir, SKILL_MANIFEST))) continue;

    if (SKIPPED.has(name)) {
      skipped.push(name);
      continue;
    }

    try {
      installSkill(srcDir, join(targetDir, name));
      installed.push(name);
    } catch (err) {
      failed.push({ name, message: err?.message || String(err) });
    }
  }

  // --- Friendly summary -----------------------------------------------------
  const line = c.bold("afk-opencode");
  if (installed.length > 0) {
    console.log(
      `${c.green("✓")} ${line}: installed ${c.bold(String(installed.length))} ` +
        `skill${installed.length === 1 ? "" : "s"} to ${c.dim(targetDir)}`
    );
  } else {
    console.log(
      `${line}: no new skills installed ${c.dim(`(${targetDir})`)}`
    );
  }

  if (skipped.length > 0) {
    for (const name of skipped) {
      console.log(
        `${c.yellow("•")} ${line}: skipped "${name}" because ${SKIPPED.get(name)}.`
      );
    }
    console.log(
      `  ${c.dim("To enable it, run its installer inside " +
        "node_modules/@easyhaloo/afk-opencode/skills/jev-agent-guard")}`
    );
  }

  if (failed.length > 0) {
    for (const f of failed) {
      console.warn(
        c.yellow(`[afk-opencode] warning: failed to install "${f.name}": ${f.message}`)
      );
    }
    console.warn(
      c.yellow(
        "[afk-opencode] warning: some skills could not be copied. The plugin " +
          "is still loaded; reinstall to retry."
      )
    );
  }

  if (installed.length > 0) {
    console.log(
      `${c.dim("Start a session and try e.g. ")}${c.bold("@afk-do")}${c.dim(".")}`
    );
  }
}

// Never let a postinstall error break `opencode plugin add`.
try {
  main();
} catch (err) {
  console.warn(
    `\x1b[33m[afk-opencode] warning: postinstall could not complete (${err?.message || err}). ` +
      `The plugin is still loaded; skills may not be installed.\x1b[39m`
  );
}
process.exitCode = 0;