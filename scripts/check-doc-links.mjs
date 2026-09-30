import { execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname, basename, sep } from 'node:path';

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

console.log(`checked ${mdFiles.length} files, 0 broken`);
