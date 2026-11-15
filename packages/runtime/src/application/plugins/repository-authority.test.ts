import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultPluginRuntime } from './default-runtime.js';
import { invokeCapability } from './operations.js';
import type { RepositoryProvider, RepositoryWorkspace, VerificationProvider } from '../../plugin-sdk/capabilities.js';

const roots: string[] = [];
const runtimes: Awaited<ReturnType<typeof createDefaultPluginRuntime>>[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(path?: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'repository-authority-')));
  roots.push(root);
  const runtime = await createDefaultPluginRuntime({ homeDir: root, workspaceRoot: root });
  runtimes.push(runtime);
  const workspace: RepositoryWorkspace = { id: 'owned', repository: { url: 'repo', ref: 'main' }, runId: 'authority-run',
    snapshot: { commit: 'a'.repeat(40), branch: 'feat/task', dirty: false }, ...(path === undefined ? {} : { path }) };
  const verify = vi.fn(async () => ({ passed: true, durationMs: 1 }));
  const publish = vi.fn(async () => ({ commit: workspace.snapshot.commit, branch: workspace.snapshot.branch }));
  const cleanup = vi.fn(async () => ({ removed: true }));
  const repository: RepositoryProvider = { id: 'fixture', capabilities: { read: true, clone: true, push: true, prepare: true, checkout: true, publish: true, cleanup: true },
    snapshot: async () => workspace.snapshot, prepare: async () => workspace, checkout: async () => workspace, publish, cleanup };
  const verification: VerificationProvider = { id: 'fixture', capabilities: { 'static-analysis': false, 'test-execution': true, 'custom-script': false }, verify };
  await runtime.activate({ id: 'fixture.authority', version: '1.0.0', setup(context) {
    context.registerRepositoryProvider('fixture', repository);
    context.registerVerificationProvider('fixture', verification);
    context.registerSystemAction('fixture.inspect', async () => 'handled');
  } });
  const request = { capability: 'verification.provider', provider: 'fixture', operation: 'verify', input: { target: root } };
  const run = (action = 'capability.invoke', input: unknown = request) => invokeCapability(runtime, { capability: 'repository.provider', provider: 'fixture', operation: 'run',
    input: { repository: workspace.repository, runId: workspace.runId, action, input } });
  return { root, runtime, verify, publish, cleanup, request, run };
}

describe('Repository-bound verification authority', () => {
  it('refuses startup-workspace verification when checkout supplies no local authority', async () => {
    const f = await fixture();
    await expect(f.run()).rejects.toThrow(/authorized.*workspace/i);
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });

  it('preserves direct startup verification without a Repository binding', async () => {
    const f = await fixture();
    expect(await invokeCapability(f.runtime, f.request)).toMatchObject({ passed: true });
    expect(f.verify).toHaveBeenCalledTimes(1);
  });

  it('preserves unrelated Repository callbacks without requiring a local path', async () => {
    const f = await fixture();
    expect(await f.run('fixture.inspect', {})).toMatchObject({ value: 'handled' });
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.publish).toHaveBeenCalledTimes(1);
  });

  it('passes a concrete checkout authority through verification before publication', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'repository-authority-checkout-')));
    roots.push(root);
    const f = await fixture(root);
    expect(await f.run('capability.invoke', { ...f.request, input: { target: root } })).toMatchObject({ value: { passed: true } });
    expect(f.verify).toHaveBeenCalledWith(expect.objectContaining({ target: root }), expect.objectContaining({ authorizedWorkspace: root }));
    expect(f.publish).toHaveBeenCalledTimes(1);
  });
});
