#!/usr/bin/env node
/**
 * Sync the repo's `skills/*` into `.opencode-pkg/skills/` so the standalone
 * npm package stays fresh with the source of truth.
 *
 * Run from the worktree root:  node scripts/build-opencode-pkg.mjs
 *
 * - Mirrors every skill directory (a directory containing SKILL.md).
 * - Removes destination skill dirs that no longer exist in the source, so
 *   renamed/removed skills don't linger in the bundle.
 * - Leaves non-skill files at the top of `skills/` (README.md,
 *   SKILL-GUIDE.md) out of the bundle; only skill directories are copied.
 * - Pure Node, zero dependencies.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_MANIFEST = "SKILL.md";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcSkills = join(repoRoot, "skills");
const destSkills = join(repoRoot, ".opencode-pkg", "skills");

if (!existsSync(srcSkills)) {
  console.error(`[build-opencode-pkg] source skills dir not found: ${srcSkills}`);
  process.exit(1);
}

mkdirSync(destSkills, { recursive: true });

// Source skill dirs.
const srcSkillsList = readdirSync(srcSkills, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(srcSkills, e.name, SKILL_MANIFEST)))
  .map((e) => e.name)
  .sort();

const copied = [];
for (const name of srcSkillsList) {
  const dest = join(destSkills, name);
  if (existsSync(dest)) {
    const st = statSync(dest);
    if (st.isDirectory()) rmSync(dest, { recursive: true, force: true });
    else rmSync(dest, { force: true });
  }
  cpSync(join(srcSkills, name), dest, { recursive: true });
  copied.push(name);
}

// Prune destination skill dirs that are no longer in the source.
const destList = readdirSync(destSkills, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);
const pruned = [];
for (const name of destList) {
  if (!srcSkillsList.includes(name)) {
    rmSync(join(destSkills, name), { recursive: true, force: true });
    pruned.push(name);
  }
}

console.log(
  `[build-opencode-pkg] synced ${copied.length} skill(s) -> .opencode-pkg/skills/`
);
if (pruned.length > 0) {
  console.log(`[build-opencode-pkg] pruned ${pruned.length} stale skill(s): ${pruned.join(", ")}`);
}
console.log(`[build-opencode-pkg] skills: ${copied.join(", ")}`);