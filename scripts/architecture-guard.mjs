import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';

const root = resolve(new URL('../src/', import.meta.url).pathname);
const forbiddenDirectories = new Set(['lib', 'core']);
const forbiddenImports = ['/lib/', '/core/', '../lib/', '../core/', './lib/', './core/'];
const forbiddenPatterns = [
  { pattern: /Record<string,\s*unknown>/g, message: 'generic Record<string, unknown> used in source' },
  { pattern: /from ['"]\.\.?\/.*client-factory['"]/g, message: 'legacy client-factory import remains' },
];

const sourceFiles = [];
const violations = [];

function walk(directory) {
  for (const entry of readdirSync(directory)) {
    const fullPath = join(directory, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (forbiddenDirectories.has(entry)) {
        violations.push(`${fullPath}: forbidden architecture directory`);
        continue;
      }
      walk(fullPath);
      continue;
    }
    if (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx')) sourceFiles.push(fullPath);
  }
}

function resolveImport(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  return candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

function checkFile(fullPath) {
  const source = readFileSync(fullPath, 'utf8');

  for (const forbidden of forbiddenImports) {
    if (source.includes(forbidden)) {
      violations.push(`${fullPath}: forbidden import pattern '${forbidden}'`);
    }
  }

  for (const rule of forbiddenPatterns) {
    if (rule.pattern.test(source)) {
      violations.push(`${fullPath}: ${rule.message}`);
    }
    rule.pattern.lastIndex = 0;
  }

  const importPattern = /(?:from\s+|import\(\s*)['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    const resolved = resolveImport(fullPath, specifier);
    if (specifier.startsWith('.') && !resolved) {
      violations.push(`${fullPath}: unresolved relative import '${specifier}'`);
    }
  }
}

if (!existsSync(root)) {
  console.error(`Missing source root: ${root}`);
  process.exit(1);
}

walk(root);
for (const sourceFile of sourceFiles) checkFile(sourceFile);

if (violations.length > 0) {
  console.error(`Architecture guard failed with ${violations.length} violation(s):`);
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`Architecture guard passed: ${sourceFiles.length} source files checked.`);
