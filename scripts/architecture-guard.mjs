import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(new URL('../src/', import.meta.url).pathname);
const layers = ['cli', 'domain', 'application', 'infrastructure', 'shared', 'views'];
const forbiddenDirectories = new Set(['lib', 'core']);
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
  const source = readFileSync(fullPath, 'utf8');
  const fromLayer = layerOf(fullPath);

  for (const rule of forbiddenPatterns) {
    if (rule.pattern.test(source)) violations.push(`${fullPath}: ${rule.message}`);
    rule.pattern.lastIndex = 0;
  }

  const importPattern = /(?:from\s+|import\(\s*)['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (!specifier.startsWith('.')) continue;

    const resolved = resolveImport(fullPath, specifier);
    if (!resolved) {
      violations.push(`${fullPath}: unresolved relative import '${specifier}'`);
      continue;
    }

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

if (violations.length > 0) {
  console.error(`Architecture guard failed with ${violations.length} violation(s):`);
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`Architecture guard passed: ${sourceFiles.length} source files checked.`);
