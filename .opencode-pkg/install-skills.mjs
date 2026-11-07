/**
 * AFK — shared skill-installer for the standalone npm package.
 *
 * Both entry points delegate here so there is exactly ONE copy of the copy
 * logic:
 *   - `postinstall.mjs` — runs on a manual `npm i @easyhaloo/afk-opencode`
 *     (npm lifecycle scripts DO fire for a direct install).
 *   - `plugin.mjs`      — OpenCode V2 calls `setup(ctx)` when it loads the
 *     plugin (this is the path `opencode plugin add` uses, and it does NOT run
 *     npm lifecycle scripts). See the module-level comment in `plugin.mjs`.
 *
 * Copies every bundled skill directory (a directory containing `SKILL.md`)
 * into the user's global OpenCode skills directory:
 *
 *   target = ${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills/<skill-name>/
 *
 * Design guarantees:
 *   - Idempotent: re-running refreshes AFK-owned skill dirs; safe to reinstall.
 *   - Cheap on repeat: a skill dir is only rewritten when its content actually
 *     differs from the destination, so calling `setup()` on every session start
 *     stays quiet and fast (no needless re-copy, no log spam).
 *   - Non-destructive: never deletes unrelated skills already present. On a
 *     name collision it refreshes the AFK-owned directory.
 *   - Skips `jev-agent-guard`, which owns its own host integration (installs
 *     hooks/plugins into claude-code/codex/opencode) and must be opt-in.
 *   - Never throws: the top-level function is wrapped so a failure can never
 *     break plugin load. Callers get a summary; failures are surfaced, not
 *     swallowed silently.
 *
 * Pure Node (node:fs, node:path, node:url), zero dependencies. The bundled
 * skills dir is resolved relative to `import.meta.url` so it works regardless
 * of where npm cached or unpacked the package.
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

/** Best-effort brand colors for the summary line (safe in non-TTY too). */
export const colors = {
  bold: (s) => `\x1b[1m${s}\x1b[22m`,
  green: (s) => `\x1b[32m${s}\x1b[39m`,
  yellow: (s) => `\x1b[33m${s}\x1b[39m`,
  dim: (s) => `\x1b[2m${s}\x1b[22m`,
};

/**
 * Resolve the user's OpenCode skills directory from the environment.
 * Honors `XDG_CONFIG_HOME`, falling back to `$HOME/.config`.
 */
export function opencodeSkillsDir() {
  const configHome =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim() !== ""
      ? process.env.XDG_CONFIG_HOME
      : join(process.env.HOME || process.env.USERPROFILE || "", ".config");
  return join(configHome, "opencode", "skills");
}

/**
 * Recursively collect a stable snapshot of a directory tree: a sorted list of
 * relative paths plus file sizes. Used for cheap change detection so we only
 * re-copy a skill when its content actually differs.
 */
function snapshot(dir) {
  const out = new Map();
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // unreadable / missing -> treat as "no snapshot"
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      out.set(e.name + "/", "dir");
      for (const [rel, info] of snapshot(p)) out.set(e.name + "/" + rel, info);
    } else if (e.isFile()) {
      let size = -1;
      try {
        size = statSync(p).size;
      } catch {
        /* leave -1 */
      }
      out.set(e.name, size);
    }
  }
  return out;
}

/** True when the destination tree is byte-for-byte the same shape as source. */
function treesMatch(srcDir, destDir) {
  if (!existsSync(destDir)) return false;
  const a = snapshot(srcDir);
  const b = snapshot(destDir);
  if (a.size !== b.size) return false;
  for (const [rel, info] of a) {
    if (b.get(rel) !== info) return false;
  }
  return true;
}

/**
 * Copy one skill directory into `destDir`. Removes any existing dir at the
 * destination first so a changed skill is fully refreshed (not merged).
 */
function installSkill(srcDir, destDir) {
  if (existsSync(destDir)) {
    const st = statSync(destDir);
    if (st.isDirectory()) rmSync(destDir, { recursive: true, force: true });
    else rmSync(destDir, { force: true });
  }
  mkdirSync(dirname(destDir), { recursive: true });
  cpSync(srcDir, destDir, { recursive: true });
}

/**
 * Install the bundled skills.
 *
 * @param {{ log?: (line: string) => void, warn?: (line: string) => void }} opts
 *   Optional loggers. Defaults to `console.log` / `console.warn`. Pass no-op
 *   functions to stay silent (e.g. on repeat `setup()` calls).
 * @returns {{ installed: string[], skipped: string[], failed: object[],
 *             unchanged: number, targetDir: string, bundledDir: string,
 *             ok: boolean }}
 *   A summary the caller can print. `ok` is true unless the bundled skills dir
 *   itself was unreadable.
 */
export function installSkills(opts = {}) {
  const log = opts.log || ((line) => console.log(line));
  const warn = opts.warn || ((line) => console.warn(line));

  const summary = {
    installed: [],
    skipped: [],
    failed: [],
    unchanged: 0,
    targetDir: "",
    bundledDir: "",
    ok: false,
  };

  // Resolve the bundled skills/ dir relative to THIS module, so it works no
  // matter where npm cached/unpacked the package.
  const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)));
  const bundledSkillsDir = join(pkgRoot, "skills");
  summary.bundledDir = bundledSkillsDir;

  try {
    if (!existsSync(bundledSkillsDir)) {
      warn(
        colors.yellow(
          "[afk-opencode] warning: bundled skills/ directory not found; " +
            "plugin loaded but no skills were installed."
        )
      );
      return summary;
    }

    const targetDir = opencodeSkillsDir();
    summary.targetDir = targetDir;

    // Collect bundled skill dirs (a "skill" = a directory containing SKILL.md).
    let bundled;
    try {
      bundled = readdirSync(bundledSkillsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch (err) {
      warn(
        colors.yellow(
          `[afk-opencode] warning: could not read bundled skills (${err?.message}); ` +
            "plugin loaded but no skills were installed."
        )
      );
      return summary;
    }

    for (const name of bundled) {
      const srcDir = join(bundledSkillsDir, name);
      // Only treat it as a skill if it has a SKILL.md; keyed on the manifest so
      // we don't copy stray non-skill directories.
      if (!existsSync(join(srcDir, SKILL_MANIFEST))) continue;

      if (SKIPPED.has(name)) {
        summary.skipped.push(name);
        continue;
      }

      const destDir = join(targetDir, name);
      try {
        if (treesMatch(srcDir, destDir)) {
          summary.unchanged++;
          continue;
        }
        installSkill(srcDir, destDir);
        summary.installed.push(name);
      } catch (err) {
        summary.failed.push({ name, message: err?.message || String(err) });
      }
    }

    summary.ok = true;
    return summary;
  } catch (err) {
    // Absolute last-resort guard: never let skill install break plugin load.
    warn(
      colors.yellow(
        `[afk-opencode] warning: skill install could not complete (${err?.message || err}). ` +
          "The plugin is still loaded; skills may not be installed."
      )
    );
    return summary;
  }
}

/**
 * Print a friendly one-line summary for an `installSkills()` result. Used by
 * both `postinstall.mjs` and `plugin.mjs` so wording stays consistent.
 *
 * @param {ReturnType<typeof installSkills>} s
 * @param {(line: string) => void} log
 */
export function printInstallSummary(s, log = (line) => console.log(line)) {
  const line = colors.bold("afk-opencode");
  const total = s.installed.length;

  if (total > 0) {
    log(
      `${colors.green("✓")} ${line}: installed ${colors.bold(String(total))} ` +
        `skill${total === 1 ? "" : "s"} to ${colors.dim(s.targetDir)}`
    );
    log(
      `${colors.dim("Start a session and try e.g. ")}${colors.bold("@afk-do")}${colors.dim(".")}`
    );
  } else if (s.unchanged > 0) {
    // Quiet, single line for the common repeat-session case.
    log(
      `${line}: skills up to date ${colors.dim(`(${s.unchanged} in ${s.targetDir})`)}`
    );
  } else if (!s.ok) {
    // Bundled dir was missing/unreadable — already warned; stay quiet here.
  } else {
    log(`${line}: no new skills installed ${colors.dim(`(${s.targetDir})`)}`);
  }

  if (s.skipped.length > 0) {
    for (const name of s.skipped) {
      log(
        `${colors.yellow("•")} ${line}: skipped "${name}" because ${SKIPPED.get(name)}.`
      );
    }
    log(
      `  ${colors.dim(
        "To enable it, run its installer inside " +
          "node_modules/@easyhaloo/afk-opencode/skills/jev-agent-guard"
      )}`
    );
  }

  if (s.failed.length > 0) {
    for (const f of s.failed) {
      log(
        colors.yellow(
          `[afk-opencode] warning: failed to install "${f.name}": ${f.message}`
        )
      );
    }
    log(
      colors.yellow(
        "[afk-opencode] warning: some skills could not be copied. The plugin " +
          "is still loaded; reinstall to retry."
      )
    );
  }
}