import { execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname, basename, sep } from 'node:path';
import { isGeneratedOutputPath } from './doc-source-paths.mjs';

// Resolve repo root as the parent of the directory containing this script.
// Use fileURLToPath to avoid percent-encoding issues with .pathname on paths
// containing spaces or non-ASCII characters.
const repoRoot = resolve(fileURLToPath(new URL('../', import.meta.url))).replace(/\/$/, '');

// Run git ls-files to get only tracked .md files.
// We use find with hardcoded exclusions instead of git ls-files + glob to avoid
// zsh expanding *.md before node sees the execSync argument string.
// Use execFileSync so the find arguments are passed as-is without shell interpretation.
const EXCLUDES = [
  '*/node_modules/*', '*/.git/*', '*/dist/*', '*/dist-electron/*', '*/release/*',
  '*/.playwright-mcp/*', '*/.playwright-cli/*', '*/.afk/*', '*/.codegraph/*',
  '*/.worktrees/*', '*/.claude/*', '*/test-results/*', '*/.omo/*',
];
const findArgs = ['.', '-type', 'f', '-name', '*.md', ...EXCLUDES.flatMap(p => ['-not', '-path', p])];
let mdFiles;
try {
  const output = execFileSync('find', findArgs, { cwd: repoRoot, encoding: 'utf8' });
  mdFiles = output.trim().split('\n').filter(Boolean).map(f => f.replace(/^\.\//, ''));
} catch {
  console.error('Failed to run find');
  process.exit(1);
}

// A checker that finds nothing reports "0 broken" and exits 0 — strictly worse
// than no checker, because it manufactures false confidence. This exact failure
// happened once: repoRoot resolved to scripts/ instead of the repo root, so find
// scanned an empty directory and CI went permanently green. Fail loudly instead.
if (mdFiles.length === 0) {
  console.error(`Found 0 markdown files under ${repoRoot} — discovery is broken, refusing to pass.`);
  process.exit(1);
}

const linkPattern = /\[[^\]]*\]\(([^)\s]+)\)/g;
const skipProtocols = ['http://', 'https://', 'mailto:', '#', '/'];
// Known placeholder link texts that are template artifacts, not real links.
// Some are full paths (e.g. path/to/diagram.png), others are bare names.
// Check both exact match and rawLink.endsWith to cover both forms.
const skipLinkTexts = new Set([
  'path/to/diagram.png',
  'diagram.png',
  'uploads/xxx.png',
  'url',
]);

const broken = [];

/**
 * Case-exact existence check: readdirSync on the parent dir and find an entry
 * whose basename exactly equals the target basename. This catches the macOS
 * case-insensitivity trap where existsSync resolves a case-mismatched path
 * on the local filesystem but the path 404s on Linux CI.
 */
function fileExistsCaseSensitive(filePath) {
  const dir = dirname(filePath);
  const name = basename(filePath);
  if (!existsSync(dir)) return false;
  const entries = readdirSync(dir);
  return entries.some(entry => entry === name);
}

for (const mdFile of mdFiles) {
  const fullPath = join(repoRoot, mdFile);
  // Skip files that don't exist (e.g. deleted but still tracked)
  if (!existsSync(fullPath)) continue;

  const content = readFileSync(fullPath, 'utf8');
  const lines = content.split('\n');

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const lineNum = lineIdx + 1;

    for (const match of line.matchAll(linkPattern)) {
      const rawLink = match[1];

      // Skip external / protocol links
      if (skipProtocols.some(p => rawLink.startsWith(p))) continue;

      // Extract link text from the full match to check skip list
      const linkTextMatch = match[0].match(/\[([^\]]*)\]/);
      if (linkTextMatch) {
        const lt = linkTextMatch[1];
        // Skip: exact match, or rawLink ends with a skip pattern (covers path/to/diagram.png)
        if (skipLinkTexts.has(lt) || skipLinkTexts.has(rawLink)) continue;
      }

      // Strip anchor suffix
      const linkWithoutAnchor = rawLink.replace(/#.*$/, '');

      // Try resolving relative to the file's directory, then relative to repo root
      const fileDir = join(repoRoot, dirname(mdFile));
      const candidates = [
        join(fileDir, linkWithoutAnchor),
        join(repoRoot, linkWithoutAnchor),
      ];

      const found = candidates.some(candidate => fileExistsCaseSensitive(candidate));

      if (!found) {
        broken.push(`${mdFile}:${lineNum}  ${rawLink}`);
      }
    }
  }
}

if (broken.length > 0) {
  for (const b of broken) console.error(b);
  console.error(`\nchecked ${mdFiles.length} files, ${broken.length} broken`);
  process.exit(1);
}

// --- Source path references -------------------------------------------------
//
// A document that names a source file in backticks makes a claim that the
// file exists. The link check above cannot see that claim, because a
// backticked path is not a link. Moving a module without correcting the
// documents that name it is exactly what this catches.
//
// Known-stale references are recorded in scripts/doc-source-paths-baseline.json
// with the number of times each one appears. A reference that is new, or
// that appears more often than the baseline records, fails the check; a
// baseline entry that no longer appears at all is reported so the baseline
// can be tightened.

const sourcePathPattern = /`([^`\s]+\.(?:ts|tsx|mjs|js))(?::\d+(?:-\d+)?)?`/g;
// Paths under a build output directory. They are generated, they are not
// tracked, and their presence depends on whether the tree was built.
const buildOutputPattern = /(^|\/)(dist|dist-electron|release|build|coverage|node_modules|out)\//;
const sourcePathBaselineFile = join(repoRoot, 'scripts', 'doc-source-paths-baseline.json');
const sourcePathBaseline = existsSync(sourcePathBaselineFile)
  ? JSON.parse(readFileSync(sourcePathBaselineFile, 'utf8'))
  : {};
const observedSourcePaths = new Map();
const staleSourcePathViolations = [];

for (const mdFile of mdFiles) {
  // docs/_archive is a historical holding area: its documents describe the
  // repository as it was, not as it is.
  if (mdFile.startsWith('docs/_archive/')) continue;

  const fullPath = join(repoRoot, mdFile);
  if (!existsSync(fullPath)) continue;
  const content = readFileSync(fullPath, 'utf8');
  const fileDir = join(repoRoot, dirname(mdFile));

  for (const match of content.matchAll(sourcePathPattern)) {
    const raw = match[1];
    // A path, not a bare file name, and not a glob or a placeholder.
    if (!raw.includes('/')) continue;
    if (/[*<>]|\$\{/.test(raw)) continue;
    // Build output is not source: the artifact a build produces does not
    // exist until the build runs.
    if (isGeneratedOutputPath(raw)) continue;
    // Scope note: this check covers backticked paths that carry a directory
    // component and a source-code extension. It deliberately does not cover
    // bare file names, other extensions, or paths under a runtime or
    // user-output directory. Each of those was measured, and each produces
    // false positives rather than findings: a bare name that exists nowhere
    // is usually a file the skill asks the *user's* project to have, and
    // .md/.json/.yml references are mostly runtime artefacts
    // (.afk-signal.json), placeholders (NNNN-*.md), or files a skill writes
    // into the user's project. Widening the pattern is not a regex change:
    // it needs a calibration pass showing every newly reported reference is
    // a real drift.

    // A document may name a path relative to its own directory, to the
    // repository root, or relative to the desktop client.
    const candidates = [
      join(fileDir, raw),
      join(repoRoot, raw),
      join(repoRoot, 'desktop-client', raw),
      join(repoRoot, 'desktop-client', 'src', raw),
    ];
    if (candidates.some(candidate => existsSync(candidate))) continue;

    observedSourcePaths.set(raw, (observedSourcePaths.get(raw) ?? 0) + 1);
  }
}

const sourcePathViolations = [];
for (const [raw, count] of observedSourcePaths) {
  const known = sourcePathBaseline[raw];
  if (known === undefined) {
    sourcePathViolations.push(`new stale source path: ${raw} (${count}x)`);
  } else if (count > known) {
    sourcePathViolations.push(`stale source path spread: ${raw} (${count}x, baseline ${known}x)`);
  }
}
for (const [raw, known] of Object.entries(sourcePathBaseline)) {
  if (!observedSourcePaths.has(raw)) {
    staleSourcePathViolations.push(`stale baseline entry no longer referenced: ${raw}`);
  }
}

if (sourcePathViolations.length > 0 || staleSourcePathViolations.length > 0) {
  for (const v of sourcePathViolations) console.error(v);
  for (const v of staleSourcePathViolations) console.error(v);
  console.error(`\nchecked ${mdFiles.length} files, ${sourcePathViolations.length} broken source paths`);
  process.exit(1);
}

console.log(`checked ${mdFiles.length} files, 0 broken`);
