import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { aggregate, main, markdown, metrics, sourcePackage, sourceRoots, summarize } from './coverage-report.mjs';

const root = '/workspace';
const entry = (covered, total) => Object.fromEntries(metrics.map(metric => [metric, { covered, total, pct: 99 }]));
const expected = Object.values(sourceRoots).map(path => `${path}/index.ts`);
const summary = () => Object.fromEntries(expected.map(path => [join(root, path), entry(1, 2)]));

test('aggregates raw counters, including untested files, instead of averaging rounded percentages', () => {
  const input = summary();
  input[join(root, expected[0])] = entry(0, 100);
  input.total = entry(999, 1000);
  const report = aggregate(input, expected, { root });
  assert.deepEqual(report.total.lines, { covered: 4, total: 108, pct: 3.7 });
  assert.deepEqual(report.packages.core.untestedFiles, [expected[0]]);
  assert.equal(report.packages.cli.lines.pct, 50);
  assert.equal(summarize([entry(57, 100)]).lines.pct, 57);
  assert.equal(report.policy.packageBaselines, null);
  assert.match(markdown(report), /Desktop.*excluded/);
});

test('rejects missing files, entire missing packages, extra paths and out-of-scope sources', () => {
  const input = summary();
  delete input[join(root, expected[0])];
  assert.throws(() => aggregate(input, expected, { root }), /missing 1/);
  assert.throws(() => aggregate(input, expected.slice(1), { root }), /Missing package coverage: core/);
  assert.throws(() => aggregate(summary(), expected.slice(1), { root }), /unexpected 1/);
  assert.throws(() => aggregate({ ...summary(), '/workspace/apps/desktop/src/index.ts': entry(1, 2) }, expected, { root }), /Out-of-scope/);
});

test('validates counters and treats sources without executable code as n/a', () => {
  assert.throws(() => summarize([{ ...entry(1, 2), branches: { total: 2, covered: 3 } }]), /Invalid coverage counts/);
  assert.throws(() => summarize([{ ...entry(1, 2), lines: { total: NaN, covered: 0 } }]), /Invalid coverage counts/);
  assert.deepEqual(summarize([entry(0, 0)]).lines, { total: 0, covered: 0, pct: null });
  assert.equal(sourcePackage('packages/core/src/value.test.ts'), undefined);
  assert.equal(sourcePackage('packages/core/src/value.d.ts'), undefined);
  assert.equal(sourcePackage('apps/cli/src/view.tsx'), 'cli');
});

test('changed-file gates apply only to selected source files and configured metrics', () => {
  const report = aggregate(summary(), expected, {
    root, changedFiles: [expected[0], expected[0], 'README.md', 'deleted.ts'], thresholds: { lines: 60, branches: 50 },
  });
  assert.equal(report.changed.length, 1);
  assert.deepEqual(report.violations, [`${expected[0]}: lines 50% < 60%`]);
  assert.equal(aggregate(summary(), expected, { root, changedFiles: expected, thresholds: { lines: 50 } }).violations.length, 0);
  for (const thresholds of [{ lines: -1 }, { lines: 101 }, { lines: NaN }, { misspelled: 50 }]) {
    assert.throws(() => aggregate(summary(), expected, { root, thresholds }), /Invalid changed-file threshold/);
  }
});

test('requires nonempty artifacts, inventories real source, and writes JSON/Markdown reports', context => {
  context.mock.method(console, 'log', () => {});
  const directory = mkdtempSync(join(tmpdir(), 'coverage-report-'));
  try {
    mkdirSync(join(directory, 'coverage'));
    for (const path of Object.values(sourceRoots)) {
      mkdirSync(join(directory, path), { recursive: true });
      writeFileSync(join(directory, path, 'index.ts'), 'export const value = 1;\n');
      writeFileSync(join(directory, path, 'index.test.ts'), '');
      writeFileSync(join(directory, path, 'types.d.ts'), '');
      writeFileSync(join(directory, path, 'type-only.ts'), 'export interface Options { enabled: boolean }\n');
    }
    assert.throws(() => main(directory, {}), /ENOENT/);
    writeFileSync(join(directory, 'coverage', 'coverage-summary.json'), JSON.stringify(Object.fromEntries(expected.map(path => [join(directory, path), entry(1, 2)]))));
    writeFileSync(join(directory, 'coverage', 'lcov.info'), '');
    writeFileSync(join(directory, 'coverage', 'index.html'), '<html>coverage</html>');
    assert.throws(() => main(directory, {}), /Missing or empty.*lcov/);
    writeFileSync(join(directory, 'coverage', 'lcov.info'), 'TN:\n');
    assert.throws(() => main(directory, { COVERAGE_CHANGED_LINES: '80' }), /COVERAGE_BASE_REF/);
    const report = main(directory, {});
    assert.equal(report.total.lines.pct, 50);
    const saved = JSON.parse(readFileSync(join(directory, 'coverage', 'report.json'), 'utf8'));
    assert.equal(saved.packages.runtime.files, 2);
    assert.deepEqual(saved.packages.runtime.nonExecutableFiles, [`${sourceRoots.runtime}/type-only.ts`]);
    assert.match(readFileSync(join(directory, 'coverage', 'report.md'), 'utf8'), /not changed-line coverage/);
    execFileSync('git', ['init', '--quiet', directory]);
    const base = execFileSync('git', ['hash-object', '-w', '-t', 'tree', '--stdin'], {
      cwd: directory, input: '', encoding: 'utf8',
    }).trim();
    assert.throws(() => main(directory, { COVERAGE_BASE_REF: base, COVERAGE_CHANGED_LINES: '60' }), /5 changed-file coverage threshold/);
    const gated = JSON.parse(readFileSync(join(directory, 'coverage', 'report.json'), 'utf8'));
    assert.equal(gated.changed.length, 10);
    assert.equal(gated.violations.length, 5);
    writeFileSync(join(directory, sourceRoots.cli, 'untested.ts'), 'export const untested = true;\n');
    assert.throws(() => main(directory, {}), /missing 1.*untested.ts/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
