import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { recallCases } from './recall-v1.js';

const driver = fileURLToPath(new URL('../../fixtures/w11/process-01.mjs', import.meta.url));
const counter = new URL('../../fixtures/w11/process-01-counter.mjs', import.meta.url);
const entry = process.env.AFK_W11_PROCESS01_CLI_ENTRY;
const evidence = process.env.AFK_W11_PROCESS01_AUDIT;
const published = process.env.AFK_W11_PROCESS01_PUBLISHED;
const processHits = recallCases.filter(row => row.kind === 'process' && row.expected === 'hit');
const liveCases = recallCases.filter(row => row.kind === 'process');

it('counts committed SQLite transitions independently of proposed steps', async () => {
  const { initialize, perform, checkAssertions } = await import(counter.href);
  const directory = mkdtempSync(join(tmpdir(), 'process-01-counter-'));
  const file = join(directory, 'register.sqlite');
  try {
    initialize(file, 'R-test');
    const count = (expected: string) => checkAssertions(file, 'R-test', [{ node: 'process.stepCount', expected }])[0];
    expect(() => perform(file, 'R-test-pickup', '核对袋号')).toThrow();
    expect(() => perform(file, 'R-test', '登记签收')).toThrow();
    expect(count('0').actual).toBe('0');
    perform(file, 'R-test', '核对袋号');
    perform(file, 'R-test', '登记签收');
    expect(count('1')).toMatchObject({ expected: '1', actual: '2', status: 'observed' });
    expect(checkAssertions(file, 'R-test', [{ node: 'process.steps.1.stateChange' }, { node: 'process.completion' }]))
      .toMatchObject([{ actual: '已核对 -> 已签收' }, { actual: '已签收' }]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it.skipIf(!entry || !evidence)('reconciles the retained 0.2.135 blocked candidate against its native evidence and SQLite register', () => {
  const report = JSON.parse(execFileSync(process.execPath, [driver, 'audit', entry!, evidence!], { encoding: 'utf8' }));
  expect(report).toMatchObject({ version: '0.2.135', job: 'processed', stepCount: 2, payloadMatches: true,
    validation: { status: 'blocked', code: 'insufficient_evidence' }, runtimeCheckerInvoked: false, publication: null, consumerRun: null });
  expect(report.references).toContainEqual(expect.objectContaining({ level: 'candidate', authority: 'observed', completeness: 'complete' }));
  for (const level of new Set(report.references.map((ref: { level: string }) => ref.level))) {
    expect(report.references).toContainEqual(expect.objectContaining({ level, authority: 'declared', locator: 'source:session-1/messages/2' }));
  }
});

it.skipIf(!entry || !published || evidence).each(processHits)('consumes a supplied real publication with the frozen $id query', frozen => {
  execFileSync(process.execPath, [driver, 'consume', entry!, frozen.query.prompt, published!, frozen.id], { stdio: 'inherit', timeout: 195_000 });
}, 205_000);

it.skipIf(!entry || evidence || published).each(liveCases)('publishes a real process and checks a fresh managed agent answer for $id', frozen => {
  execFileSync(process.execPath, [driver, frozen.id === 'process-01' ? 'review' : 'run', entry!, frozen.query.prompt, '', frozen.id], { stdio: 'inherit', timeout: 520_000 });
}, 530_000);
