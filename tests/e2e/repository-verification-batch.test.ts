import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { resolveE2eRuntime } from './installed-runtime.js';
import { branch, prepareRepositoryRun, startRepositoryServer } from './repository-managed-local.fixture.js';

const entry = process.env.AFK_E2E_CLI_ENTRY;

type Check = { cwd: string; head: string; content: string; passed: boolean };

async function publicationReceipts(runtime: string, root: string, runId: string, workItemId: string, command: string[]) {
  const moduleUrl = (name: string) => pathToFileURL(join(runtime, 'infrastructure/observability', `${name}.js`)).href;
  const { JsonlEventStore } = await import(moduleUrl('jsonl-event-store'));
  const { createLocalEncryptedEvidenceStore } = await import(moduleUrl('local-evidence-store'));
  const events = new JsonlEventStore({ root: join(root, '.afk', 'events') });
  const evidence = await createLocalEncryptedEvidenceStore(root);
  const receipts = [];
  for await (const event of events.read(runId)) {
    if (event.data.kind !== 'effect.completed' || event.data.effectKind !== 'verification') continue;
    expect(event.evidence).toHaveLength(1);
    const receipt = JSON.parse(Buffer.from(await evidence.get(event.evidence[0])).toString());
    if (receipt.phase !== 'before-publish') continue;
    expect(receipt).toMatchObject({ protocol: 'capability-verification-v1', provider: 'test-runner',
      executionId: event.idempotencyKey, observation: { runId, workItemId },
      result: { execution: { command, closed: true, cwd: receipt.workspace } } });
    expect(receipt.revision.after).toEqual(receipt.revision.before);
    receipts.push({ cwd: receipt.workspace, ...receipt.revision.before, passed: receipt.result.passed,
      exitCode: receipt.result.execution.exitCode, observedAt: event.observedAt, sequence: event.sequence });
  }
  return receipts;
}

it.skipIf(!entry).each(['reject-web', 'allow-both'] as const)('verifies both repositories before the first push: %s', async policy => {
  const installation = resolveE2eRuntime(entry);
  if (installation.mode !== 'installed') throw new Error('Installed CLI required');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'afk-verify-batch-')));
  const journal = join(root, 'checks.jsonl');
  const checks = (): Check[] => existsSync(journal) ? readFileSync(journal, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line)) : [];
  let firstPush: { at: number; request: string; checks: Check[] } | undefined;
  let seeded = false;
  const server = await startRepositoryServer(root, request => {
    if (seeded) firstPush ??= { at: Date.now(), request, checks: checks() };
  });
  try {
    const command = [process.execPath, '-e', `
      const { appendFileSync, readFileSync } = require('node:fs');
      const content = readFileSync('shared.txt', 'utf8').trimEnd();
      const passed = content === 'applied api' || (process.argv[2] === 'allow-both' && content === 'applied web');
      const head = require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      appendFileSync(process.argv[1], JSON.stringify({ cwd: process.cwd(), head, content, passed }) + '\\n');
      process.exitCode = passed ? 0 : 1;
    `, journal, policy];
    const { cli, git, repositories, workItemId, manifest } = await prepareRepositoryRun(root, server.host, installation.binary, false, command);
    server.requests.length = 0;
    seeded = true;
    const run = cli('run', '--template', 'issue-implementation', '--agent', 'claude-code', '--execution-mode', 'batch',
      '--backlog-id', workItemId, '--execution-manifest', manifest, '--hard-timeout', '35000');
    const rejectWeb = policy === 'reject-web';
    if (rejectWeb) await expect(run).rejects.toMatchObject({ stderr: expect.stringContaining('Capability verification failed') });
    else await run;
    const runs = JSON.parse(await cli('observe', 'runs', '--json'));
    expect(runs).toHaveLength(1);
    const integrity = JSON.parse(await cli('observe', 'verify', runs[0], '--json'));
    expect(integrity.valid).toBe(true);
    const receipts = await publicationReceipts(installation.runtime, root, runs[0], workItemId, command);
    const refs = [];
    for (const { name, bare, seed } of repositories) {
      const cwd = (await readFile(join(root, `${name}.path`), 'utf8')).trimEnd();
      const passed = !rejectWeb || name === 'api';
      const check = checks().find(result => result.cwd === cwd && result.content === `applied ${name}`);
      expect(check).toMatchObject({ passed, head: expect.stringMatching(/^[a-f0-9]{40}$/) });
      expect(check!.head).not.toBe(seed);
      const beforePush = receipts.filter(receipt => !firstPush || Date.parse(receipt.observedAt) <= firstPush.at);
      expect(beforePush).toContainEqual(expect.objectContaining({ cwd, branch, head: check!.head, passed, exitCode: passed ? 0 : 1 }));
      const heads = await git('-C', bare, 'show-ref', '--heads');
      refs.push({ name, seed, heads });
      expect(await git('-C', bare, 'rev-parse', 'main')).toBe(seed);
      if (rejectWeb) expect(heads).toBe(`${seed} refs/heads/main`);
      else {
        const published = await git('-C', bare, 'rev-parse', branch);
        expect(published).toBe(check!.head);
        expect(firstPush?.checks).toContainEqual(check);
        expect(await git('-C', bare, 'show', `${published}:shared.txt`)).toBe(`applied ${name}`);
      }
    }
    const publicationRequests = server.requests.filter(request => request.startsWith('POST') && /git-receive-pack|merge_requests$/.test(request));
    if (rejectWeb) {
      expect(firstPush).toBeUndefined();
      expect(publicationRequests).toEqual([]);
    } else {
      expect(JSON.parse(await cli('observe', runs[0], '--json')).state.run.status).toBe('awaiting_human');
      expect(publicationRequests.filter(request => request.endsWith('/merge_requests'))).toHaveLength(1);
    }
    if (process.env.AFK_E2E_KEEP_REPOSITORY === '1') {
      await writeFile(join(root, 'receipt.json'), JSON.stringify({ installation, policy, workItemId, runId: runs[0],
        integrity, receipts, checks: checks(), firstPush: firstPush ?? null, publicationRequests, refs }, null, 2));
      console.info(`Batch verification receipt (${policy}): ${join(root, 'receipt.json')}`);
    }
  } finally {
    await server.close();
    if (process.env.AFK_E2E_KEEP_REPOSITORY !== '1') await rm(root, { recursive: true, force: true });
  }
}, 90_000);
