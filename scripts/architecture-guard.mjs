import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  if (!process.argv[index + 1]) throw new Error(`${name} requires a path`);
  return resolve(process.argv[index + 1]);
}

function hasOption(name) {
  return process.argv.includes(name);
}

function flag(name) {
  return process.argv.includes(name);
}

const root = option('--root', resolve(new URL('../src/', import.meta.url).pathname));
const baselinePath = option('--baseline', resolve(new URL('./architecture-legacy-baseline.json', import.meta.url).pathname));
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const legacyFiles = new Set(baseline.legacyFiles);
const legacyImports = baseline.legacyImports;
const legacyPatterns = baseline.legacyPatterns;
const checkPackages = flag('--check-packages') || flag('--require-packages');
const requirePackages = flag('--require-packages');
const packageRoots = [
  {
    name: 'core',
    path: option('--core-root', resolve(new URL('../packages/afk-core/', import.meta.url).pathname)),
    required: requirePackages,
  },
  {
    name: 'application',
    path: option('--application-root', resolve(new URL('../packages/afk-application/', import.meta.url).pathname)),
    required: requirePackages,
  },
];
const layers = ['cli', 'domain', 'core', 'application', 'infrastructure', 'shared', 'views'];
const forbiddenPatterns = [
  { pattern: /Record\s*<\s*string\s*,\s*unknown\s*>/g, message: 'generic Record<string, unknown> used in source' },
  { pattern: /from\s+['"]\.\.?\/.*client-factory(?:\.js)?['"]/g, message: 'legacy client-factory import remains' },
];
const nodeBuiltins = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel',
  'dns', 'domain', 'events', 'fs', 'http', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
  'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls', 'trace_events', 'tty',
  'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);
const domGlobals = ['document', 'window', 'navigator', 'localStorage', 'sessionStorage', 'HTMLElement', 'Element'];

const sourceFiles = [];
const violations = new Set();
const observedLegacyFiles = new Set();
const observedLegacyImports = new Map();
const observedLegacyPatterns = new Map();
const skippedPackageRoots = [];

function addViolation(message) {
  violations.add(message);
}

function sourcePath(file) {
  return relative(root, file).split(sep).join('/');
}

function isLegacy(file) {
  return sourcePath(file).startsWith('lib/');
}

function walk(directory) {
  sourceFiles.push(...collectSourceFiles(directory));
}

function collectSourceFiles(directory) {
  const files = [];
  const visit = currentDirectory => {
    for (const entry of readdirSync(currentDirectory)) {
      const fullPath = join(currentDirectory, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        if (entry === 'dist' || entry === 'node_modules' || entry === 'coverage') continue;
        visit(fullPath);
        continue;
      }
      if (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx')) files.push(fullPath);
    }
  };
  visit(directory);
  return files;
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
    domain: new Set(['core', 'shared']),
    core: new Set(['shared']),
    application: new Set(['core', 'domain', 'infrastructure', 'shared']),
    infrastructure: new Set(['core', 'domain', 'shared']),
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
    if (!legacyFiles.has(filename)) addViolation(`${fullPath}: unapproved legacy file: ${filename}`);
  }

  for (const rule of forbiddenPatterns) {
    const matches = [...source.matchAll(rule.pattern)].length;
    if (matches && !isLegacy(fullPath)) addViolation(`${fullPath}: ${rule.message}`);
    if (isLegacy(fullPath) && matches) {
      const key = `${filename} -> ${rule.message}`;
      observedLegacyPatterns.set(key, matches);
      if (matches > (legacyPatterns[key] ?? 0)) addViolation(`${fullPath}: unapproved legacy pattern: ${rule.message}`);
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
      addViolation(`${fullPath}: unresolved relative import '${specifier}'`);
      continue;
    }

    if (!isLegacy(fullPath) && isLegacy(resolved)) {
      const key = `${filename} -> ${sourcePath(resolved)}`;
      const count = (observedLegacyImports.get(key) ?? 0) + 1;
      observedLegacyImports.set(key, count);
      if (count > (legacyImports[key] ?? 0)) addViolation(`${fullPath}: unapproved legacy import: ${key}`);
    }

    if (testFile) continue;

    const toLayer = layerOf(resolved);
    if (fromLayer && toLayer && !dependencyLayer(fromLayer, toLayer)) {
      addViolation(`${fullPath}: forbidden dependency ${fromLayer} -> ${toLayer} via '${specifier}'`);
    }
  }
}

function isWithin(child, parent) {
  const childRelativePath = relative(parent, child);
  return childRelativePath === ''
    || (!childRelativePath.startsWith(`..${sep}`) && childRelativePath !== '..' && !isAbsolute(childRelativePath));
}

function packageSourceRoot(packageRoot) {
  const srcRoot = join(packageRoot, 'src');
  if (existsSync(srcRoot) && statSync(srcRoot).isDirectory()) return srcRoot;
  if (collectSourceFiles(packageRoot).length > 0) return packageRoot;
  return null;
}

function packageDependencyViolation(packageName, specifier) {
  addViolation(`${packageName} package must not depend on '${specifier}'`);
}

function checkPackageManifest(packageName, packageRoot) {
  const manifestPath = join(packageRoot, 'package.json');
  if (!existsSync(manifestPath)) return;

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    addViolation(`${manifestPath}: invalid package.json`);
    return;
  }

  const allowedDependencies = packageName === 'application' ? new Set(['@afk/core']) : new Set();
  const dependencies = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
  };
  for (const dependency of Object.keys(dependencies)) {
    if (!allowedDependencies.has(dependency)) packageDependencyViolation(packageName, dependency);
  }
}

function checkPackage(packageName, packageRoot) {
  const sourceRoot = packageSourceRoot(packageRoot);
  if (!sourceRoot) {
    addViolation(`Missing ${packageName} package source root: ${join(packageRoot, 'src')}`);
    return;
  }

  checkPackageManifest(packageName, packageRoot);
  const allowedExternalDependencies = packageName === 'application' ? new Set(['@afk/core']) : new Set();
  const packageFiles = collectSourceFiles(sourceRoot).filter(file => !isTestFile(file));
  for (const fullPath of packageFiles) {
    const source = stripComments(readFileSync(fullPath, 'utf8'));
    for (const globalName of domGlobals) {
      if (new RegExp(`\\b${globalName}\\b`).test(source)) addViolation(`${packageName} package must not use DOM global '${globalName}'`);
    }
    for (const match of source.matchAll(/(?:from\s+|import\s*(?:\(\s*)?)(['"`])([^'"`]+)\1/g)) {
      const specifier = match[2];
      if (match[1] === '`' && specifier.includes('${')) continue;

      if (specifier.startsWith('.')) {
        const resolved = resolveImport(fullPath, specifier);
        if (!resolved) {
          addViolation(`${fullPath}: unresolved relative import '${specifier}'`);
          continue;
        }
        if (!isWithin(resolved, packageRoot)) {
          addViolation(`${fullPath}: ${packageName} package must not import outside its package root via '${specifier}'`);
        }
        continue;
      }

      const builtinName = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
      const builtinRoot = builtinName.split('/')[0];
      const isElectronImport = specifier === 'electron' || specifier.startsWith('electron/');
      const isReactImport = specifier === 'react' || specifier.startsWith('react/');
      if (specifier.startsWith('node:') || nodeBuiltins.has(builtinRoot) || isElectronImport || isReactImport) {
        packageDependencyViolation(packageName, specifier);
        continue;
      }
      if (!allowedExternalDependencies.has(specifier)) packageDependencyViolation(packageName, specifier);
    }
  }
}

if (!existsSync(root)) {
  console.error(`Missing source root: ${root}`);
  process.exit(1);
}

walk(root);
for (const sourceFile of sourceFiles) checkFile(sourceFile);
if (checkPackages) {
  for (const packageRoot of packageRoots) {
    if (!existsSync(packageRoot.path) || !statSync(packageRoot.path).isDirectory()) {
      if (packageRoot.required) addViolation(`Missing ${packageRoot.name} package root: ${packageRoot.path}`);
      else skippedPackageRoots.push(packageRoot.path);
      continue;
    }
    checkPackage(packageRoot.name, packageRoot.path);
  }
}
for (const file of legacyFiles) {
  if (!observedLegacyFiles.has(file)) addViolation(`stale legacy file baseline: ${file}`);
}
for (const [key, count] of Object.entries(legacyImports)) {
  if ((observedLegacyImports.get(key) ?? 0) < count) addViolation(`stale legacy import baseline: ${key}`);
}
for (const [key, count] of Object.entries(legacyPatterns)) {
  if ((observedLegacyPatterns.get(key) ?? 0) < count) addViolation(`stale legacy pattern baseline: ${key}`);
}

if (violations.size > 0) {
  console.error(`Architecture guard failed with ${violations.size} violation(s):`);
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

for (const packageRoot of skippedPackageRoots) console.log(`Skipped optional package root: ${packageRoot}`);
console.log(`Architecture guard passed: ${sourceFiles.length} source files checked; ${observedLegacyFiles.size} legacy files, ${observedLegacyImports.size} imports and ${observedLegacyPatterns.size} patterns quarantined.`);
