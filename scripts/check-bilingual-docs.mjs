#!/usr/bin/env node
// Bilingual documentation check.
//
// The repository ships some documents in two languages: `name.md` (English)
// and `name.zh.md` (Chinese). The rule that the two must stay in sync was
// prose only, and it had already been broken once: `docs/architecture/
// overview.md` changed without its `overview.zh.md` counterpart, and the
// drift was only noticed a round later. A prose rule is not a check.
//
// This script makes the rule machine-checkable. For every pair it compares
// the *heading level sequence* of the two files:
//
//   - The level sequence is compared, not the heading text. The two languages
//     name the same section differently, so comparing text would report every
//     pair as broken.
//   - Fenced code blocks are removed first. A `# comment` inside a shell
//     snippet is a comment, not a heading.
//   - A heading is `#`+ followed immediately by a non-whitespace character at
//     the start of a line. `## Title` and `##标题` are both headings;
//     `## ` (no text) and an indented `  ## Title` are not.
//
// Usage: node scripts/check-bilingual-docs.mjs [dir]
//        (default: the repository root, so the README pair is checked too)

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../', import.meta.url))).replace(/\/$/, '');

// The default target is the repository root: the documentation lives under
// docs/, but the README has a Chinese twin at the top level too. An
// explicit argument is resolved against the current working directory so
// the script can be pointed at a scratch directory during verification.
const targetDir = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : repoRoot;

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'dist-electron', 'release', 'coverage',
  'packages', 'src', 'scripts', 'skills', 'tests', 'desktop-client', 'assets',
  'docker', '.github', '.husky', '.claude', '.codex', '.opencode',
  '.claude-plugin', '.codegraph', '.afk',
]);

/**
 * The two ways a document names its Chinese twin.
 *
 * `docs/` uses `name.zh.md`; the repository's README uses `README_zh.md`.
 * Both are the same convention - a Chinese twin of an English document -
 * and both drift the same way.
 */
const CHINESE_SUFFIXES = ['.zh.md', '_zh.md'];

/**
 * Collect every Chinese document under `dir`, recursively.
 */
function collectChineseDocs(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectChineseDocs(full, acc);
    } else if (entry.isFile() && CHINESE_SUFFIXES.some(suffix => entry.name.endsWith(suffix))) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Extract the heading level sequence of a markdown document.
 *
 * Fenced code blocks (``` or ~~~) are stripped before headings are read, so a
 * shell comment inside a snippet is never mistaken for a heading.
 */
function extractHeadings(content) {
  const lines = content.split('\n');
  const headings = [];
  let fenceChar = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const marker = fence[1][0];
      if (fenceChar === null) {
        fenceChar = marker;
      } else if (marker === fenceChar) {
        fenceChar = null;
      }
      continue;
    }
    if (fenceChar !== null) continue;

    // A heading is `#`+ at the start of a line followed by heading text:
    // either whitespace and then non-whitespace (`## Title`), or the text
    // directly (`##标题`). A `#` run with no text at all (`## `) is not a
    // heading. The `(?!#)` keeps the captured run maximal, so `#####` on its
    // own line is not read as a level-4 heading.
    const heading = /^(#+)(?!#)(?:\s+(?=\S)|\S)/.exec(line);
    if (heading) {
      headings.push({ level: heading[1].length, text: line.trim(), line: i + 1 });
    }
  }

  return headings;
}

/**
 * Return the first position at which the two heading sequences differ, or
 * null when they are identical.
 */
function firstDifference(en, zh) {
  const max = Math.max(en.length, zh.length);
  for (let i = 0; i < max; i++) {
    const a = en[i];
    const b = zh[i];
    if ((a ? a.level : null) !== (b ? b.level : null)) {
      return { index: i, en: a ?? null, zh: b ?? null };
    }
  }
  return null;
}

/**
 * Print a path relative to the repository root when it is inside the
 * repository, and absolute otherwise (the script also runs against scratch
 * directories during verification).
 */
function displayPath(filePath) {
  const rel = relative(repoRoot, filePath);
  return rel.startsWith('..') ? filePath : rel;
}

if (!existsSync(targetDir)) {
  console.error(`Target directory ${targetDir} does not exist.`);
  process.exit(1);
}

const chineseDocs = collectChineseDocs(targetDir).sort();

const pairs = [];
for (const zhPath of chineseDocs) {
  const enPath = CHINESE_SUFFIXES.reduce(
    (candidate, suffix) => (candidate.endsWith(suffix) ? candidate.slice(0, -suffix.length) + '.md' : candidate),
    zhPath,
  );
  if (existsSync(enPath)) {
    pairs.push({ enPath, zhPath });
  }
}

// A checker that finds nothing reports "0 mismatched" and exits 0 — strictly
// worse than no checker, because it manufactures false confidence. Finding
// zero pairs means the glob or the path is wrong, so refuse to pass.
if (pairs.length === 0) {
  console.error(
    `Found 0 bilingual pairs under ${targetDir} — discovery is broken, refusing to pass.`,
  );
  process.exit(1);
}

const mismatches = [];
const emptyDocuments = [];

for (const { enPath, zhPath } of pairs) {
  const enHeadings = extractHeadings(readFileSync(enPath, 'utf8'));
  const zhHeadings = extractHeadings(readFileSync(zhPath, 'utf8'));

  // A document with no headings at all means the extraction is broken (or the
  // document was emptied). Two empty sequences compare equal, so without this
  // guard the check would pass a pair that contains nothing to compare.
  for (const [path, headings] of [[enPath, enHeadings], [zhPath, zhHeadings]]) {
    if (headings.length === 0) {
      emptyDocuments.push(path);
    }
  }

  const diff = firstDifference(enHeadings, zhHeadings);
  if (diff) {
    mismatches.push({ enPath, zhPath, enHeadings, zhHeadings, diff });
  }
}

if (emptyDocuments.length > 0) {
  for (const path of emptyDocuments) {
    console.error(`no headings found: ${displayPath(path)} — extraction is broken, refusing to pass.`);
  }
  console.error(`\nchecked ${pairs.length} pairs, ${emptyDocuments.length} unreadable`);
  process.exit(1);
}

if (mismatches.length > 0) {
  for (const m of mismatches) {
    const enRel = displayPath(m.enPath);
    const zhRel = displayPath(m.zhPath);
    const position = m.diff.index + 1;
    console.error(`${enRel} <-> ${zhRel}: heading ${position} differs`);
    if (m.diff.en) {
      console.error(`  en: ${m.diff.en.text}  (${enRel}:${m.diff.en.line})`);
    } else {
      console.error(`  en: (missing heading ${position})  (${enRel})`);
    }
    if (m.diff.zh) {
      console.error(`  zh: ${m.diff.zh.text}  (${zhRel}:${m.diff.zh.line})`);
    } else {
      console.error(`  zh: (missing heading ${position})  (${zhRel})`);
    }
    console.error(
      `  levels: en=${m.enHeadings.length} headings, zh=${m.zhHeadings.length} headings`,
    );
  }
  console.error(`\nchecked ${pairs.length} pairs, ${mismatches.length} mismatched`);
  process.exit(1);
}

console.log(`checked ${pairs.length} pairs, 0 mismatched`);
