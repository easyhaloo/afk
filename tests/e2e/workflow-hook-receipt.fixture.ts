import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunEvent } from '@afk/core';
import { expect } from 'vitest';

type Cli = (...args: string[]) => Promise<{ stdout: string }>;
const name = 'w07-optional';
const canary = 'private-fixture-error-text';

export async function installFailingHook(root: string, cli: Cli) {
  const directory = join(root, name);
  await mkdir(directory);
  const manifest = { id: 'test.optional-hook', version: '1.0.0', apiVersion: 1, provides: ['workflow.lifecycle'], trusted: true, entry: 'index.js' };
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module' }));
  await writeFile(join(directory, 'plugin.json'), JSON.stringify(manifest));
  await writeFile(join(directory, 'index.js'), `import { appendFile } from 'node:fs/promises';
    export default { manifest: ${JSON.stringify(manifest)}, activate(context) {
      context.registerLifecycle({ name: '${name}', purposes: ['execution', 'learning'], failureMode: 'best-effort',
        async onBeforeAgent(ctx) {
          await appendFile(${JSON.stringify(join(root, 'hook.calls'))}, JSON.stringify(ctx.observation.context.runId) + '\\n');
          throw new Error('${canary}');
        } });
    } };`);
  await cli('plugin', 'install', directory);
}

export async function checkHookReceipt(root: string, cli: Cli, workItemId: string,
  template: 'issue-implementation' | 'merge-conflict-resolution' | 'success-review-preview', eventRoot = join(root, '.afk', 'events')) {
  const purpose = template === 'success-review-preview' ? 'learning' : 'execution';
  const milestones = template === 'issue-implementation' ? ['implementation.completed', 'qa.passed']
    : template === 'merge-conflict-resolution' ? ['qa.passed'] : ['run.finished'];
  const calls = (await readFile(join(root, 'hook.calls'), 'utf8')).trim().split('\n');
  expect(calls).toHaveLength(milestones.length);
  expect(new Set(calls).size).toBe(1);
  const runId: string = JSON.parse(calls[0]!);
  const verification = JSON.parse((await cli('observe', 'verify', runId, '--root', eventRoot, '--json')).stdout);
  const timeline = await readFile(join(eventRoot, `${Buffer.from(runId).toString('base64url')}.jsonl`), 'utf8');
  expect(timeline).not.toContain(canary);
  const events: RunEvent[] = timeline.trim().split('\n').map(line => JSON.parse(line));
  expect(verification).toMatchObject({ valid: true, lastSequence: events.length, lastHash: events.at(-1)!.integrity.hash });
  if (template !== 'merge-conflict-resolution') expect(events.map(event => event.data)).toContainEqual(
    expect.objectContaining({ kind: 'workflow.recorded', name: template }));
  expect(events.at(-1)?.data).toMatchObject(template === 'issue-implementation' ? { kind: 'human_gate.opened' }
    : { kind: 'run.finished', outcome: 'succeeded' });
  const receipts = events.filter(event => event.data.kind === 'effect.completed' && event.data.effectKind === 'workflow.lifecycle.before-agent');
  expect(receipts).toHaveLength(milestones.length);
  for (const [index, receipt] of receipts.entries()) {
    expect(receipt).toMatchObject({ context: { runId, workItemId }, data: { outcome: 'failed', summary: 'optional_lifecycle_hook_failed',
      idempotencyKey: JSON.stringify([runId, 'lifecycle', 'before-agent', 'module', name]) } });
    expect(receipt.context.purpose ?? 'execution').toBe(purpose);
    expect(events.slice(receipt.sequence, receipts[index + 1]?.sequence).some(event => event.data.kind === milestones[index])).toBe(true);
  }
  console.info(JSON.stringify({ template, workItemId, runId, purpose, milestones, receipts, verification, last: events.at(-1)?.data }));
}
