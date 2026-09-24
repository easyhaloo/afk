import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  if (!process.argv[index + 1]) throw new Error(`${name} requires a path`);
  return resolve(process.argv[index + 1]);
}

const root = option('--root', resolve(new URL('../src/', import.meta.url).pathname));
const baselinePath = option('--baseline', resolve(new URL('./architecture-legacy-baseline.json', import.meta.url).pathname));
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const legacyFiles = new Set(baseline.legacyFiles);
const legacyImports = baseline.legacyImports;
const legacyPatterns = baseline.legacyPatterns;
const layers = ['cli', 'domain', 'application', 'infrastructure', 'shared', 'views'];
const forbiddenPatterns = [
  { pattern: /Record\s*<\s*string\s*,\s*unknown\s*>/g, message: 'generic Record<string, unknown> used in source' },
  { pattern: /from\s+['"]\.\.?\/.*client-factory(?:\.js)?['"]/g, message: 'legacy client-factory import remains' },
];

const sourceFiles = [];
const violations = [];
const observedLegacyFiles = new Set();
const observedLegacyImports = new Map();
const observedLegacyPatterns = new Map();

function sourcePath(file) {
  return relative(root, file).split(sep).join('/');
}

function isLegacy(file) {
  return sourcePath(file).startsWith('lib/');
}

function walk(directory) {
  for (const entry of readdirSync(directory)) {
    const fullPath = join(directory, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walk(fullPath);
      continue;
    }
    if (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx')) sourceFiles.push(fullPath);
  }
}

function resolveImport(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const normalized = specifier.endsWith('.js') ? specifier.slice(0, -3) : specifier;
  const base = resolve(dirname(fromFile), normalized);
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

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

function isTestFile(filePath) {
  return /(?:\.test|\.spec|\.integration\.test)\.(?:ts|tsx)$/.test(filePath);
}

function layerOf(filePath) {
  const pathFromRoot = relative(root, filePath);
  const firstSegment = pathFromRoot.split(/[\\/]/)[0];
  return layers.includes(firstSegment) ? firstSegment : null;
}

function dependencyLayer(fromLayer, toLayer) {
  if (!fromLayer || !toLayer || fromLayer === toLayer) return true;

  const allowed = {
    cli: new Set(['application', 'domain', 'infrastructure', 'shared', 'views']),
    domain: new Set(['shared']),
    application: new Set(['domain', 'infrastructure', 'shared']),
    infrastructure: new Set(['domain', 'shared']),
    shared: new Set(),
    views: new Set(['application', 'domain', 'shared', 'infrastructure']),
  };
  return allowed[fromLayer]?.has(toLayer) ?? false;
}

function checkFile(fullPath) {
  const source = stripComments(readFileSync(fullPath, 'utf8'));
  const fromLayer = layerOf(fullPath);
  const testFile = isTestFile(fullPath);
  const filename = sourcePath(fullPath);
  if (isLegacy(fullPath)) {
    observedLegacyFiles.add(filename);
    if (!legacyFiles.has(filename)) violations.push(`${fullPath}: unapproved legacy file: ${filename}`);
  }

  for (const rule of forbiddenPatterns) {
    const matches = [...source.matchAll(rule.pattern)].length;
    if (matches && !isLegacy(fullPath)) violations.push(`${fullPath}: ${rule.message}`);
    if (isLegacy(fullPath) && matches) {
      const key = `${filename} -> ${rule.message}`;
      observedLegacyPatterns.set(key, matches);
      if (matches > (legacyPatterns[key] ?? 0)) violations.push(`${fullPath}: unapproved legacy pattern: ${rule.message}`);
    }
    rule.pattern.lastIndex = 0;
  }

  const importPattern = /(?:from\s+|import\s*(?:\(\s*)?)(['"`])([^'"`]+)\1/g;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[2];
    if (match[1] === '`' && specifier.includes('${')) continue;
    if (!specifier.startsWith('.')) continue;

    const resolved = resolveImport(fullPath, specifier);
    if (!resolved) {
      violations.push(`${fullPath}: unresolved relative import '${specifier}'`);
      continue;
    }

    if (!isLegacy(fullPath) && isLegacy(resolved)) {
      const key = `${filename} -> ${sourcePath(resolved)}`;
      const count = (observedLegacyImports.get(key) ?? 0) + 1;
      observedLegacyImports.set(key, count);
      if (count > (legacyImports[key] ?? 0)) violations.push(`${fullPath}: unapproved legacy import: ${key}`);
    }

    if (testFile) continue;

    const toLayer = layerOf(resolved);
    if (fromLayer && toLayer && !dependencyLayer(fromLayer, toLayer)) {
      violations.push(`${fullPath}: forbidden dependency ${fromLayer} -> ${toLayer} via '${specifier}'`);
    }
  }
}

if (!existsSync(root)) {
  console.error(`Missing source root: ${root}`);
  process.exit(1);
}

walk(root);
for (const sourceFile of sourceFiles) checkFile(sourceFile);
for (const file of legacyFiles) {
  if (!observedLegacyFiles.has(file)) violations.push(`stale legacy file baseline: ${file}`);
}
for (const [key, count] of Object.entries(legacyImports)) {
  if (observedLegacyImports.get(key) !== count) violations.push(`stale legacy import baseline: ${key}`);
}
for (const [key, count] of Object.entries(legacyPatterns)) {
  if (observedLegacyPatterns.get(key) !== count) violations.push(`stale legacy pattern baseline: ${key}`);
}

if (violations.length > 0) {
  console.error(`Architecture guard failed with ${violations.length} violation(s):`);
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`Architecture guard passed: ${sourceFiles.length} source files checked; ${observedLegacyFiles.size} legacy files, ${observedLegacyImports.size} imports and ${observedLegacyPatterns.size} patterns quarantined.`);
