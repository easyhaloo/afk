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
const legacyStateMappings = baseline.legacyStateMappings ?? {};
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
  {
    name: 'infrastructure',
    path: option('--infrastructure-root', resolve(new URL('../packages/afk-infrastructure/', import.meta.url).pathname)),
    required: requirePackages,
  },
  {
    name: 'execution',
    path: option('--execution-root', resolve(new URL('../packages/afk-execution/', import.meta.url).pathname)),
    required: requirePackages,
  },
];
/**
 * Dependency contract per package.
 *
 * `core` is the pure business kernel: no runtime, no I/O, no sibling package.
 * `application` holds use cases and the Port interfaces they are written
 * against: it may reach for the core model and nothing else, so it stays
 * free of Node, Electron and provider SDKs.
 * `infrastructure` is where I/O implementations live — Node builtins and the
 * provider SDKs are the reason it exists — but it may only ever point
 * inwards at core and application.
 */
const packageDependencyRules = {
  core: { dependencies: new Set(), allowBuiltins: false },
  application: { dependencies: new Set(['@afk/core']), allowBuiltins: false },
  infrastructure: {
    dependencies: new Set([
      '@afk/core', '@afk/application',
      '@octokit/rest', '@gitbeaker/node',
      'simple-git', 'js-yaml', 'zod', 'pino', 'pino-pretty',
    ]),
    allowBuiltins: true,
  },
  execution: {
    dependencies: new Set([
      '@afk/core', '@afk/application', '@afk/infrastructure', '@afk/workflow-graph',
      'simple-git', 'js-yaml', 'zod', 'pino', 'pino-pretty', 'ws', 'open',
    ]),
    allowBuiltins: true,
  },
};
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
const desktopRoot = option('--desktop-client-root', resolve(new URL('../desktop-client/', import.meta.url).pathname));
const repoRoot = resolve(new URL('../', import.meta.url).pathname);
const buildOutputDirectories = new Set(['dist', 'dist-electron', 'node_modules', 'coverage', 'release', 'test-results', 'screenshots']);
const backlogStateKeys = new Set(['ready', 'rework', 'in_progress', 'verification', 'merge_ready', 'done', 'blocked']);
const requiredStateMappingKeys = ['in_progress', 'verification', 'merge_ready'];
const stateMappingLiteralPattern = /\{([^{}]*)\}/g;
// A machine-readable state projection (`in_progress: 'implementing'`) maps onto
// bare lowercase tokens; i18n labels and CSS class names never look like that.
const stateMappingPairPattern = /^\s*([A-Za-z_$][\w$]*)\s*:\s*(['"])([a-z][a-z0-9_]*)\2\s*$/;
const importPattern = /(?:from\s+|import\s*(?:\(\s*)?)(['"`])([^'"`]+)\1/g;

const sourceFiles = [];
const violations = new Set();
const observedLegacyFiles = new Set();
const observedLegacyImports = new Map();
const observedLegacyPatterns = new Map();
const observedStateMappings = new Map();
const observedLegacyStateMappings = new Map();
const skippedPackageRoots = [];
const desktopSourceFiles = [];
const dependencyFieldLabels = {
  dependencies: 'a dependency',
  devDependencies: 'a devDependency',
  optionalDependencies: 'an optional dependency',
};

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
        if (buildOutputDirectories.has(entry)) continue;
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

/**
 * Structural fingerprint of a backlog->core state mapping: an object literal
 * whose entries are all `identifier: 'token'` pairs keyed by the canonical
 * backlog state vocabulary and valued by machine-readable core state tokens.
 * Matching on the key set (not on file names or on the mapped values) means a
 * drifted copy is still recognised as a copy, while plain `BacklogState[]`
 * enumeration lists, i18n label tables and the smaller execution-mode mapping
 * are not mistaken for it.
 */
function stateMappingSignatures(source) {
  const signatures = [];
  for (const match of source.matchAll(stateMappingLiteralPattern)) {
    const pairs = match[1]
      .split(',')
      .map(entry => entry.trim())
      .filter(entry => entry.length > 0)
      .map(entry => stateMappingPairPattern.exec(entry));
    if (pairs.length < requiredStateMappingKeys.length || pairs.some(pair => !pair)) continue;
    const keys = new Set(pairs.map(pair => pair[1]));
    if (keys.size !== pairs.length) continue;
    if (!requiredStateMappingKeys.every(key => keys.has(key))) continue;
    if (![...keys].every(key => backlogStateKeys.has(key))) continue;
    signatures.push([...keys].sort().join(','));
  }
  return signatures;
}

function recordStateMappings(fullPath, source) {
  for (const signature of stateMappingSignatures(source)) {
    const declaringFiles = observedStateMappings.get(signature) ?? new Set();
    declaringFiles.add(fullPath);
    observedStateMappings.set(signature, declaringFiles);
  }
}

function checkStateMappingDuplicates() {
  for (const [signature, declaringFiles] of observedStateMappings) {
    if (declaringFiles.size < 2) continue;

    const files = [...declaringFiles].sort();
    const message = `duplicate backlog->core state mapping (${signature}) declared in ${files.join(', ')}; define it once and import it`;
    if (files.every(file => isLegacy(file))) {
      const key = files.map(sourcePath).sort().join(', ');
      observedLegacyStateMappings.set(key, files.length);
      if (files.length > (legacyStateMappings[key] ?? 0)) addViolation(`${files[0]}: unapproved legacy duplicate state mapping: ${message}`);
      continue;
    }
    addViolation(`${files[0]}: ${message}`);
  }
}

/**
 * A rule with two homes.
 *
 * Two functions with the same name and the same body are the same rule
 * written out twice, and the copies drift: the desktop's run validation
 * had a second and weaker copy in the electron process, both credential
 * stores carried their own atomic write while the key-value store's test
 * said the opposite, and the tmux session name was rewritten on both
 * sides of the package line.
 *
 * A body short enough to be an idiom — "is this a plain object" — is not
 * a rule, so only bodies with some substance in them are reported.  The
 * bodies compared here are the ones a rule would be written in: a branch
 * name, a credential file, a session name.
 */
const duplicateRuleMinimumLength = 120;
const functionDeclarationPattern = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*(?::[^{]+?)?\{/g;
// A rule written as a bound constant is the same rule as one written as a
// function; the shape of the declaration does not change what it says.
const arrowDeclarationPattern = /(?:export\s+)?const\s+(\w+)\s*(?::[^=;]*)?=\s*(?:async\s+)?(?:function\s*)?\(/g;
const observedRuleBodies = new Map();

function recordFunctionBodies(source, file) {
  // A test file's helper is not a rule the product declares twice; two
  // suites building the same fixture is ordinary.
  if (isTestFile(file)) return;
  for (const match of source.matchAll(functionDeclarationPattern)) recordRuleBody(source, match, file);
  for (const match of source.matchAll(arrowDeclarationPattern)) recordRuleBody(source, match, file);
}

function recordRuleBody(source, match, file) {
  const start = match.index + match[0].length - 1;
  let depth = 0;
  let end = -1;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end < 0) return;
  const body = source.slice(start, end + 1);
  const normalized = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length < duplicateRuleMinimumLength) return;
  const key = `${match[1]}\u0000${normalized}`;
  const entry = observedRuleBodies.get(key) ?? { name: match[1], files: new Set() };
  entry.files.add(file);
  observedRuleBodies.set(key, entry);
}

function checkDuplicateRules() {
  for (const entry of observedRuleBodies.values()) {
    if (entry.files.size < 2) continue;
    const files = [...entry.files].map(sourcePath).sort();
    addViolation(`${files[0]}: the rule '${entry.name}' is written out in ${files.length} files (${files.join(', ')}); define it once and import it`);
  }
}

/**
 * The layers a package may carry inside its own source tree.
 *
 * A package that has domain/application/infrastructure sub-trees names
 * them the way the root tree does, so the root tree's direction applies
 * inside it: the domain holds types and seams and reaches for nothing
 * else, the infrastructure implements what the domain describes and
 * points inwards, and an application may reach outward for the I/O it
 * orchestrates.  Before this rule existed, a package's internal layers
 * were a convention with nothing behind it — a domain file could reach
 * into the infrastructure beside it and the check said nothing.
 */
const packageLayerNames = ['domain', 'core', 'application', 'infrastructure', 'shared'];

function packageLayerOf(sourceRoot, filePath) {
  const pathFromPackage = relative(sourceRoot, filePath);
  const firstSegment = pathFromPackage.split(/[\\/]/)[0];
  return packageLayerNames.includes(firstSegment) ? firstSegment : null;
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

  recordStateMappings(fullPath, source);
  recordFunctionBodies(source, fullPath);

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

/**
 * The desktop client keeps its own dependency contract: it may consume the
 * shared @afk/* packages, but it must not reach into the root package's src/
 * tree. A relative import that escapes the desktop root into src/ sidesteps
 * every package boundary the guard enforces elsewhere, so it is reported
 * here — the same rule that stops a package from importing outside its own
 * root (see checkPackage).
 *
 * The desktop must also not spawn an AFK CLI process. It calls the shared use
 * cases in process, through its composition root; a subprocess running `afk`
 * would reintroduce the boundary the packages were split to remove — a second
 * process, a second copy of the domain rules, and a JSON envelope to translate
 * between them.
 */
const afkSpawnPattern = /\b(?:spawn|spawnSync|exec|execFile|execFileSync|execSync)\s*\(\s*['"`]afk['"`]/;

function checkDesktopImports(fullPath) {
  const source = stripComments(readFileSync(fullPath, 'utf8'));
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[2];
    if (match[1] === '`' && specifier.includes('${')) continue;
    if (!specifier.startsWith('.')) continue;

    const resolved = resolveImport(fullPath, specifier);
    if (!resolved) continue;
    if (isWithin(resolved, root)) {
      addViolation(`${fullPath}: desktop client must not import the root package src/ tree via '${specifier}'; depend on @afk/application or @afk/infrastructure instead`);
    }
  }
  if (afkSpawnPattern.test(source)) {
    addViolation(`${fullPath}: desktop client must not spawn an afk CLI process; call the shared use cases in process instead`);
  }
}

/**
 * The desktop's renderer runs in a browser. A module the renderer loads
 * that reaches a node builtin cannot be bundled: the bundler
 * externalizes the builtin and the build fails on the first use of it.
 *
 * The desktop's shared contract is loaded by both sides of the process
 * seam, so a shared vocabulary that lives in a module which reads files
 * drags the filesystem into the renderer. The vocabulary belongs in a
 * module the renderer can load - the pure part of a package - and this
 * rule is what says so before the bundler does.
 */
function isNodeBuiltinSpecifier(specifier) {
  if (specifier.startsWith('node:')) return true;
  const name = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  return nodeBuiltins.has(name.split('/')[0]);
}

/**
 * The imports of a module that survive compilation.
 *
 * `import type` and a named import whose every binding is `type` are
 * erased, so a module that only names a type never loads. The two
 * forms are the difference between a shared type and a shared value.
 */
function runtimeImportSpecifiers(source) {
  const specifiers = [];
  for (const match of source.matchAll(/import\s+([\s\S]*?)\s+from\s+(['"`])([^'"`]+)\2\s*;?/g)) {
    const clause = match[1].trim();
    if (/^type\b/.test(clause)) continue;
    const named = clause.match(/\{([\s\S]*?)\}/);
    if (named) {
      const bindings = named[1].split(',').map(binding => binding.trim()).filter(Boolean);
      if (bindings.length > 0 && bindings.every(binding => /^type\s/.test(binding))) continue;
    }
    specifiers.push(match[3]);
  }
  for (const match of source.matchAll(/import\s+(['"`])([^'"`]+)\1\s*;?/g)) {
    specifiers.push(match[2]);
  }
  return specifiers;
}

/** The source file a package specifier names, so the rule reads source. */
function packageSourceFile(specifier) {
  const match = specifier.match(/^@afk\/([a-z-]+)(?:\/(.*))?$/);
  if (!match) return null;
  const packageRoot = join(repoRoot, 'packages', `afk-${match[1]}`);
  const sourceRoot = join(packageRoot, 'src');
  if (match[2] === undefined) {
    const entry = join(sourceRoot, 'index.ts');
    return existsSync(entry) ? entry : null;
  }
  const base = join(sourceRoot, match[2]);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')];
  return candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

function resolveSourceImport(fromFile, specifier) {
  if (specifier.startsWith('.')) return resolveImport(fromFile, specifier);
  return packageSourceFile(specifier);
}

const builtinReachCache = new Map();

/** The first node builtin a module reaches, or null when it reaches none. */
function reachesNodeBuiltin(file, seen = new Set()) {
  if (builtinReachCache.has(file)) return builtinReachCache.get(file);
  if (seen.has(file)) return null;
  seen.add(file);
  const source = stripComments(readFileSync(file, 'utf8'));
  let hit = null;
  for (const specifier of runtimeImportSpecifiers(source)) {
    if (isNodeBuiltinSpecifier(specifier)) {
      hit = { file, specifier };
      break;
    }
    const resolved = resolveSourceImport(file, specifier);
    if (!resolved) continue;
    hit = reachesNodeBuiltin(resolved, seen);
    if (hit) break;
  }
  builtinReachCache.set(file, hit);
  return hit;
}

function checkDesktopRendererImports() {
  for (const fullPath of desktopSourceFiles) {
    if (isTestFile(fullPath)) continue;
    const relativePath = relative(desktopRoot, fullPath).split(sep).join('/');
    if (!relativePath.startsWith('src/') && !relativePath.startsWith('shared/')) continue;
    const hit = reachesNodeBuiltin(fullPath);
    if (hit) {
      addViolation(`${fullPath}: the desktop renderer must not load node builtin '${hit.specifier}' via ${sourcePath(hit.file)}; keep a shared vocabulary in a module the renderer can load`);
    }
  }
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

function packageRules(packageName) {
  return packageDependencyRules[packageName] ?? { dependencies: new Set(), allowBuiltins: false };
}

/**
 * A package may import its own subpath exports, and any dependency it is
 * allowed to use may be reached through one of its subpaths.
 */
function dependencyAllowed(packageName, rules, specifier) {
  const own = `@afk/${packageName}`;
  if (specifier === own || specifier.startsWith(`${own}/`)) return true;
  for (const dependency of rules.dependencies) {
    if (specifier === dependency || specifier.startsWith(`${dependency}/`)) return true;
  }
  return false;
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

  const allowedDependencies = packageRules(packageName).dependencies;
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
  const rules = packageRules(packageName);
  const allowedExternalDependencies = rules.dependencies;
  const packageFiles = collectSourceFiles(sourceRoot).filter(file => !isTestFile(file));
  for (const fullPath of packageFiles) {
    const source = stripComments(readFileSync(fullPath, 'utf8'));
    recordFunctionBodies(source, fullPath);
    for (const globalName of domGlobals) {
      // A local binding that happens to share the name — a tmux window, a
      // document being parsed — is not the DOM global, so the file is exempt
      // from the check for that name.
      const declaresLocal = new RegExp(
        `(?<![.\\w$])(?:const|let|var|function|class)\\s+${globalName}\\b|(?<![.\\w$])${globalName}\\s*:`,
      );
      if (declaresLocal.test(source)) continue;
      const usage = new RegExp(`(?<![.\\w$])\\b${globalName}\\b`);
      if (usage.test(source)) addViolation(`${packageName} package must not use DOM global '${globalName}'`);
    }
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[2];
      if (match[1] === '`' && specifier.includes('${')) continue;

      // A package must not import its own modules by its own name: that
      // specifier resolves to the built output, so the module is loaded a
      // second time and a mock of it never applies.
      const ownName = `@afk/${packageName}`;
      if (specifier === ownName || specifier.startsWith(`${ownName}/`)) {
        addViolation(`${fullPath}: ${packageName} package must not import itself as '${specifier}'; use a relative path`);
        continue;
      }

      if (specifier.startsWith('.')) {
        const resolved = resolveImport(fullPath, specifier);
        if (!resolved) {
          addViolation(`${fullPath}: unresolved relative import '${specifier}'`);
          continue;
        }
        if (!isWithin(resolved, packageRoot)) {
          addViolation(`${fullPath}: ${packageName} package must not import outside its package root via '${specifier}'`);
        }
        // The layers inside a package are held to the same direction as the
        // layers of the root tree.
        const fromLayer = packageLayerOf(sourceRoot, fullPath);
        const toLayer = packageLayerOf(sourceRoot, resolved);
        if (fromLayer && toLayer && !dependencyLayer(fromLayer, toLayer)) {
          addViolation(`${fullPath}: forbidden internal dependency ${fromLayer} -> ${toLayer} via '${specifier}'`);
        }
        continue;
      }

      const builtinName = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
      const builtinRoot = builtinName.split('/')[0];
      const isElectronImport = specifier === 'electron' || specifier.startsWith('electron/');
      const isReactImport = specifier === 'react' || specifier.startsWith('react/');
      if (isElectronImport || isReactImport) {
        packageDependencyViolation(packageName, specifier);
        continue;
      }
      const isBuiltin = specifier.startsWith('node:') || nodeBuiltins.has(builtinRoot);
      if (isBuiltin) {
        // Builtins are the runtime this package exists to wrap; only the pure
        // packages forbid them.
        if (!rules.allowBuiltins) packageDependencyViolation(packageName, specifier);
        continue;
      }
      if (!dependencyAllowed(packageName, rules, specifier)) packageDependencyViolation(packageName, specifier);
    }
  }
}

if (!existsSync(root)) {
  console.error(`Missing source root: ${root}`);
  process.exit(1);
}

/**
 * The workspace package graph must be acyclic.
 *
 * pnpm builds its task graph from the package graph, devDependencies
 * included: a package that depends on a sibling which depends back on it
 * makes `pnpm -r <task>` fail with ERR_PNPM_TASK_CYCLE before it runs a
 * single task. A test-only back-edge is still an edge — the application
 * package reaching for an infrastructure implementation in one test file
 * was enough to make the whole workspace impossible to run recursively.
 */
function checkPackageGraph() {
  const candidates = [];
  const packagesDirectory = join(repoRoot, 'packages');
  if (existsSync(packagesDirectory) && statSync(packagesDirectory).isDirectory()) {
    for (const entry of readdirSync(packagesDirectory)) {
      const manifestPath = join(packagesDirectory, entry, 'package.json');
      if (existsSync(manifestPath)) candidates.push(manifestPath);
    }
  }
  const desktopManifest = join(repoRoot, 'desktop-client', 'package.json');
  if (existsSync(desktopManifest)) candidates.push(desktopManifest);

  const manifests = new Map();
  for (const manifestPath of candidates) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      continue;
    }
    if (!manifest?.name) continue;
    const edges = new Map();
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const specifier of Object.keys(manifest[field] ?? {})) {
        if (specifier.startsWith('@afk/')) edges.set(specifier, field);
      }
    }
    manifests.set(manifest.name, { path: manifestPath, edges });
  }

  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const walk = name => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      const cycle = stack.slice(stack.indexOf(name));
      const edges = [];
      for (let index = 0; index < cycle.length; index += 1) {
        const from = cycle[index];
        const to = cycle[(index + 1) % cycle.length];
        const field = manifests.get(from)?.edges.get(to);
        if (field) edges.push(`${from} -> ${to} as ${dependencyFieldLabels[field] ?? field}`);
      }
      addViolation(
        `workspace package graph has a cycle: ${cycle.join(' -> ')} -> ${cycle[0]}; ${edges.join(', ')}. pnpm builds its task graph from this graph, so 'pnpm -r' fails with ERR_PNPM_TASK_CYCLE.`,
      );
      return;
    }
    visiting.add(name);
    stack.push(name);
    for (const dependency of manifests.get(name)?.edges.keys() ?? []) walk(dependency);
    stack.pop();
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of manifests.keys()) walk(name);
}

/**
 * Every build-script approval must be a decision.
 *
 * pnpm writes an undecided approval as the literal text "set this to true or
 * false". pnpm reads that text as "not allowed", so the install ends with
 * ERR_PNPM_IGNORED_BUILDS and a fresh checkout cannot be installed at all —
 * a failure that looks like a broken registry rather than a placeholder
 * somebody left in a config file.
 */
function checkBuildApprovals() {
  const manifestPath = join(repoRoot, 'pnpm-workspace.yaml');
  if (!existsSync(manifestPath)) return;
  const lines = readFileSync(manifestPath, 'utf8').split(/\r?\n/);
  let inside = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (/^allowBuilds\s*:/.test(trimmed)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (!/^\s/.test(line)) {
      inside = false;
      continue;
    }
    const entry = /^\s+(['"]?)([^:'"\s]+)\1\s*:\s*(.*?)\s*$/.exec(line);
    if (!entry) continue;
    const value = entry[3].replace(/^['"]|['"]$/g, '');
    if (value !== 'true' && value !== 'false') {
      addViolation(
        `${relative(repoRoot, manifestPath)}: allowBuilds entry '${entry[2]}' is '${value}'; pnpm reads a non-boolean as "not allowed" and refuses to install.`,
      );
    }
  }
}

walk(root);
for (const sourceFile of sourceFiles) checkFile(sourceFile);
// The desktop client is a separate source tree that the layering rules above
// do not govern, but it is exactly where a second copy of a shared mapping
// table tends to appear, so it feeds the duplicate-mapping rule only.
if (existsSync(desktopRoot) && statSync(desktopRoot).isDirectory()) {
  desktopSourceFiles.push(...collectSourceFiles(desktopRoot));
  for (const sourceFile of desktopSourceFiles) {
    const desktopSource = stripComments(readFileSync(sourceFile, 'utf8'));
    recordStateMappings(sourceFile, desktopSource);
    recordFunctionBodies(desktopSource, sourceFile);
    checkDesktopImports(sourceFile);
  }
}
checkStateMappingDuplicates();
checkDuplicateRules();
checkPackageGraph();
checkBuildApprovals();
checkDesktopRendererImports();
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
for (const [key, count] of Object.entries(legacyStateMappings)) {
  if ((observedLegacyStateMappings.get(key) ?? 0) < count) addViolation(`stale legacy state mapping baseline: ${key}`);
}

if (violations.size > 0) {
  console.error(`Architecture guard failed with ${violations.size} violation(s):`);
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

for (const packageRoot of skippedPackageRoots) console.log(`Skipped optional package root: ${packageRoot}`);
console.log(`Architecture guard passed: ${sourceFiles.length} source files and ${desktopSourceFiles.length} desktop client files checked; ${observedLegacyFiles.size} legacy files, ${observedLegacyImports.size} imports and ${observedLegacyPatterns.size} patterns quarantined.`);
