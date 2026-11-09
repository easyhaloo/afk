import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const sourceRoots = {
  core: 'packages/core/src',
  application: 'packages/application/src',
  'workflow-graph': 'packages/workflow-graph/src',
  runtime: 'packages/runtime/src',
  cli: 'apps/cli/src',
};
export const metrics = ['lines', 'statements', 'functions', 'branches'];

export function sourcePackage(path) {
  if (!/\.(ts|tsx)$/.test(path) || /(?:\.d|\.test|\.spec)\.(ts|tsx)$/.test(path)) return;
  return Object.keys(sourceRoots).find(name => path.startsWith(`${sourceRoots[name]}/`));
}

function sourceFiles(root, directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? sourceFiles(root, path) : sourcePackage(path) ? [path] : [];
  });
}

export function summarize(entries) {
  return Object.fromEntries(metrics.map(metric => {
    let total = 0;
    let covered = 0;
    for (const entry of entries) {
      const value = entry[metric];
      if (!value || !Number.isSafeInteger(value.total) || !Number.isSafeInteger(value.covered)
        || value.total < 0 || value.covered < 0 || value.covered > value.total) {
        throw new Error(`Invalid coverage counts for ${metric}`);
      }
      total += value.total;
      covered += value.covered;
    }
    return [metric, { total, covered, pct: total === 0 ? null : Math.floor(covered * 10000 / total) / 100 }];
  }));
}

export function aggregate(summary, expectedFiles, { root, changedFiles = [], thresholds = {} }) {
  for (const [metric, minimum] of Object.entries(thresholds)) {
    if (!metrics.includes(metric) || !Number.isFinite(minimum) || minimum < 0 || minimum > 100) {
      throw new Error(`Invalid changed-file threshold: ${metric}=${minimum}`);
    }
  }
  const files = new Map();
  for (const [path, entry] of Object.entries(summary)) {
    if (path === 'total') continue;
    const normalized = relative(root, isAbsolute(path) ? path : resolve(root, path)).replaceAll('\\', '/');
    if (!sourcePackage(normalized)) throw new Error(`Out-of-scope coverage entry: ${normalized}`);
    if (files.has(normalized)) throw new Error(`Duplicate coverage entry: ${normalized}`);
    files.set(normalized, summarize([entry]));
  }
  if (new Set(expectedFiles).size !== expectedFiles.length) throw new Error('Duplicate source inventory entries');
  const missing = expectedFiles.filter(path => !files.has(path));
  const extra = [...files.keys()].filter(path => !expectedFiles.includes(path));
  if (missing.length || extra.length) {
    throw new Error(`Incomplete source coverage: missing ${missing.length} [${missing.join(', ')}]; unexpected ${extra.length} [${extra.join(', ')}]`);
  }
  const packages = Object.fromEntries(Object.entries(sourceRoots).map(([name, path]) => {
    const entries = [...files].filter(([file]) => sourcePackage(file) === name);
    if (!entries.length) throw new Error(`Missing package coverage: ${name}`);
    return [name, {
      path,
      files: entries.length,
      nonExecutableFiles: entries.filter(([, entry]) => entry.lines.total === 0).map(([file]) => file),
      untestedFiles: entries.filter(([, entry]) => entry.lines.total > 0 && entry.lines.covered === 0).map(([file]) => file),
      ...summarize(entries.map(([, entry]) => entry)),
    }];
  }));
  const changed = [...new Set(changedFiles)].filter(path => files.has(path)).map(path => ({ path, ...files.get(path) }));
  const violations = changed.flatMap(file => Object.entries(thresholds).flatMap(([metric, minimum]) => {
    const actual = file[metric].pct;
    return actual !== null && actual < minimum ? [`${file.path}: ${metric} ${actual}% < ${minimum}%`] : [];
  }));
  return {
    scope: sourceRoots,
    excluded: ['apps/desktop (separate Vitest/Electron toolchain)', 'PTY opt-in tests', 'test files', 'type declarations', 'generated output', 'skills and scripts'],
    limitations: ['V8 measurements cover the Vitest workers; separately spawned CLI/agent/container processes are not instrumented.', 'Sources omitted by V8 are accepted only if TypeScript emits no runtime code; they are listed as non-executable, with no covered lines added.', 'Whole-file changed-source coverage is reported; this is not changed-line coverage.', 'Passing tests alone do not establish coverage. No whole-repository or 80% coverage claim is made.'],
    policy: { missingReports: 'fail', packageBaselines: null, changedFileThresholds: thresholds },
    total: summarize([...files.values()]),
    packages,
    changed,
    violations,
    lowestCoverage: [...files].filter(([, entry]) => entry.lines.total > 0)
      .sort(([leftPath, left], [rightPath, right]) => left.lines.pct - right.lines.pct || leftPath.localeCompare(rightPath))
      .slice(0, 15).map(([path, entry]) => ({ path, ...entry })),
  };
}

export function markdown(report) {
  const percentage = metric => metric.pct === null ? 'n/a (no executable code)' : `${metric.pct.toFixed(2)}% (${metric.covered}/${metric.total})`;
  const row = (name, entry) => `| ${name} | ${metrics.map(metric => percentage(entry[metric])).join(' | ')} |`;
  return [
    '# Source coverage',
    '',
    'Scope: core, application, workflow-graph, runtime, CLI. Desktop uses a separate toolchain and is excluded.',
    '',
    `Test result: ${report.measurement?.tests || 'not checked by report-only command'}.`,
    `Test selection: ${report.measurement?.testSelection || 'not checked by report-only command'}.`,
    '',
    '| Package | Lines | Statements | Functions | Branches |',
    '| --- | --- | --- | --- | --- |',
    ...Object.entries(report.packages).map(([name, entry]) => row(name, entry)),
    row('TOTAL (scoped source only)', report.total),
    '',
    ...Object.entries(report.packages).map(([name, entry]) => `- ${name}: ${entry.files} source files; ${entry.nonExecutableFiles.length} non-executable; ${entry.untestedFiles.length} files with executable lines and zero covered lines.`),
    '',
    '## Changed source files (whole-file coverage)',
    '',
    '| File | Lines | Statements | Functions | Branches |',
    '| --- | --- | --- | --- | --- |',
    ...report.changed.map(entry => row(entry.path, entry)),
    ...(report.changed.length ? [] : ['No changed source files selected.']),
    '',
    `Changed-file thresholds: ${JSON.stringify(report.policy.changedFileThresholds)}. Missing reports/files fail. Package baselines: ${report.policy.packageBaselines ? 'enforced from the checked-in measured baseline' : 'not configured'}.`,
    '',
    '## Lowest line coverage',
    '',
    ...report.lowestCoverage.map(entry => `- ${entry.path}: ${percentage(entry.lines)}`),
    '',
    '## Limits',
    '',
    ...report.limitations.map(limit => `- ${limit}`),
    '',
    ...report.violations.map(violation => `FAIL: ${violation}`),
    '',
  ].join('\n');
}

export function enforceBaseline(report, baseline) {
  if (baseline?.version !== 1 || !baseline.provenance || typeof baseline.provenance !== 'object'
    || !baseline.total || !baseline.packages
    || Object.keys(baseline.packages).sort().join(',') !== Object.keys(sourceRoots).sort().join(',')) throw new Error('Invalid coverage baseline');
  const scopes = { total: report.total, ...report.packages };
  const minimums = { total: baseline.total, ...baseline.packages };
  for (const [name, expected] of Object.entries(minimums)) {
    if (Object.keys(expected).sort().join(',') !== [...metrics].sort().join(',')) throw new Error(`Invalid baseline metrics for ${name}`);
    for (const [metric, minimum] of Object.entries(expected)) {
      if (!Number.isFinite(minimum) || minimum < 0 || minimum > 100) throw new Error(`Invalid baseline minimum for ${name}.${metric}`);
      const actual = scopes[name][metric].pct;
      if (actual === null || actual < minimum) report.violations.push(`${name}: ${metric} ${actual ?? 'n/a'}% < baseline ${minimum}%`);
    }
  }
  report.policy.packageBaselines = baseline;
  return report;
}

export function main(root = process.cwd(), environment = process.env) {
  const directory = join(root, 'coverage');
  for (const artifact of ['coverage-summary.json', 'lcov.info', 'index.html']) {
    const path = join(directory, artifact);
    if (!statSync(path).isFile() || statSync(path).size === 0) throw new Error(`Missing or empty coverage artifact: ${artifact}`);
  }
  const thresholds = Object.fromEntries(metrics.flatMap(metric => {
    const value = environment[`COVERAGE_CHANGED_${metric.toUpperCase()}`];
    return value === undefined || value === '' ? [] : [[metric, value.trim() === '' ? NaN : Number(value)]];
  }));
  const base = environment.COVERAGE_BASE_REF && !/^0+$/.test(environment.COVERAGE_BASE_REF) ? environment.COVERAGE_BASE_REF : undefined;
  if (Object.keys(thresholds).length && !base) throw new Error('COVERAGE_BASE_REF is required when changed-file thresholds are configured');
  const changedFiles = base ? [
    ...execFileSync('git', ['diff', '--name-only', '-z', '--diff-filter=ACMR', base, '--', ...Object.values(sourceRoots)], { cwd: root, encoding: 'utf8' }).split('\0'),
    ...execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', ...Object.values(sourceRoots)], { cwd: root, encoding: 'utf8' }).split('\0'),
  ].filter(Boolean) : [];
  const expectedFiles = Object.values(sourceRoots).flatMap(path => sourceFiles(root, path));
  const summary = JSON.parse(readFileSync(join(directory, 'coverage-summary.json'), 'utf8'));
  const reportedFiles = new Set(Object.keys(summary).map(path => relative(root, resolve(root, path)).replaceAll('\\', '/')));
  for (const path of expectedFiles.filter(path => !reportedFiles.has(path))) {
    const { outputText } = ts.transpileModule(readFileSync(join(root, path), 'utf8'), {
      fileName: path, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext, removeComments: true },
    });
    if (outputText.replace(/export\s*\{\s*\}\s*;?/g, '').trim() === '') {
      summary[join(root, path)] = Object.fromEntries(metrics.map(metric => [metric, { total: 0, covered: 0 }]));
    }
  }
  const report = aggregate(summary, expectedFiles, { root, changedFiles, thresholds });
  const baselinePath = resolve(root, environment.COVERAGE_BASELINE || 'scripts/coverage-baseline.json');
  if (environment.COVERAGE_BASELINE || existsSync(baselinePath)) enforceBaseline(report, JSON.parse(readFileSync(baselinePath, 'utf8')));
  report.measurement = { provider: 'v8', node: process.version, platform: process.platform, arch: process.arch,
    tests: environment.COVERAGE_TEST_STATUS || 'not checked by report-only command; see Vitest/CI results',
    testSelection: environment.COVERAGE_TEST_SELECTION || 'not checked by report-only command' };
  const text = markdown(report);
  writeFileSync(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(directory, 'report.md'), text);
  if (environment.GITHUB_STEP_SUMMARY) appendFileSync(environment.GITHUB_STEP_SUMMARY, text);
  console.log(text);
  if (report.violations.length) throw new Error(`${report.violations.length} changed-file coverage threshold(s) or baseline gate(s) failed`);
  return report;
}

export function run(root = process.cwd(), testArguments = []) {
  const directory = mkdtempSync(join(tmpdir(), 'source-coverage-'));
  try {
    const config = join(root, 'vitest.coverage.config.ts');
    const workspace = join(directory, 'vitest.workspace.json');
    const setup = join(directory, 'working-directory.mjs');
    writeFileSync(setup, 'process.chdir(process.env.COVERAGE_PROJECT_ROOT);\n');
    writeFileSync(workspace, JSON.stringify([
      ...Object.entries(sourceRoots).map(([name, path]) => ({
        extends: config,
        root: resolve(root, path, '..'),
        test: { name, include: ['src/**/*.test.{ts,tsx}'], setupFiles: [setup], env: { COVERAGE_PROJECT_ROOT: resolve(root, path, '..') } },
      })),
      { extends: config, root, test: { name: 'repository', include: ['tests/**/*.test.ts'], setupFiles: [setup], env: { COVERAGE_PROJECT_ROOT: root } } },
    ]));
    const result = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--workspace', workspace, '--coverage', ...testArguments], {
      cwd: root, stdio: 'inherit',
    });
    if (result.error) throw result.error;
    try {
      main(root, { ...process.env, COVERAGE_TEST_STATUS: result.status === 0 ? 'passed' : 'failed',
        COVERAGE_TEST_SELECTION: testArguments.length ? JSON.stringify(testArguments) : 'all configured package and repository tests' });
    } finally {
      if (result.status !== 0) process.exitCode = result.status || 1;
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--run') run(process.cwd(), process.argv.slice(3));
    else main();
  } catch (error) {
    console.error(`Coverage report failed: ${error.message}`);
    process.exitCode = 1;
  }
}
