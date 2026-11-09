import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildEvidencePack } from '../learning/evidence.js';
import { createBuiltinAgentPlugins } from './builtin-providers.js';
import { createConfiguredPlugins } from './configured.js';
import { builtinPluginManifests } from './builtin-manifests.js';
import { createLearningPlugin } from './learning.js';
import { PluginRuntime } from './runtime.js';

const runtimes: PluginRuntime[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function fixture(config: unknown = {}) {
  const homeDir = mkdtempSync(join(realpathSync(tmpdir()), 'learning-plugin-'));
  directories.push(homeDir);
  const runtime = new PluginRuntime();
  runtimes.push(runtime);
  for (const plugin of createBuiltinAgentPlugins()) await runtime.activate(plugin);
  await runtime.activate(createLearningPlugin({ homeDir, config }));
  return { runtime, homeDir };
}

describe('optional learning plugin', () => {
  it('is discoverable and defaults to disabled without starting analysis', async () => {
    const { runtime, homeDir } = await fixture();
    expect(builtinPluginManifests(homeDir).find(manifest => manifest.id === 'learning.distiller')?.provides).toContain('workflow.action');
    expect(await runtime.dispatchSystemAction('learning.settings', {})).toMatchObject({ enabled: false, provider: 'claude-code' });
    await expect(runtime.dispatchSystemAction('learning.distill', {})).rejects.toThrow('learning_disabled');
    await expect(runtime.dispatchSystemAction('learning.worker.once', {})).rejects.toThrow('learning_disabled');
  });

  it('accepts typed evidence requests through the standard action and exposes scoped state', async () => {
    const { runtime, homeDir } = await fixture({ enabled: true });
    const file = join(homeDir, 'session.txt');
    writeFileSync(file, 'A policy requires approval.');
    const pack = await buildEvidencePack({ sources: [{ id: 'session-1', kind: 'journal', path: file, allowedRoot: homeDir, format: 'text' }] });
    const request = { version: 1, scope: 'github:acme/api', sourceId: 'session:one',
      evidenceDigest: pack.digest, analyzerVersion: '1', reason: 'import' };
    const accepted = await runtime.dispatchSystemAction('learning.distill', { request, pack });
    expect(accepted).toMatchObject({ request });
    expect(await runtime.dispatchSystemAction('learning.jobs', { scope: request.scope })).toMatchObject([{ status: 'pending' }]);
    expect(await runtime.dispatchSystemAction('learning.jobs', { scope: 'github:other/api' })).toEqual([]);
    await expect(runtime.dispatchSystemAction('learning.jobs', {})).rejects.toThrow();
    await expect(runtime.dispatchSystemAction('learning.distill', { request, pack, state: 'published' })).rejects.toThrow();
  });

  it('uses the existing configured plugin loader and rejects unknown configuration fields', async () => {
    const plugins = await createConfiguredPlugins({ configurations: [{ id: 'learning.distiller', config: { enabled: false, dailyCalls: 0 } }] });
    expect(plugins[0]?.manifest.id).toBe('learning.distiller');
    await expect(createConfiguredPlugins({ configurations: [{ id: 'learning.distiller', config: { dangerouslySkipPermissions: true } }] })).rejects.toThrow(/invalid configuration/i);
    expect(() => createLearningPlugin({ config: { dailyCalls: -1 } })).toThrow();
  });

  it('reports unsupported analysis providers rather than granting development permissions', async () => {
    const { runtime } = await fixture({ enabled: true, provider: 'cursor' });
    expect(await runtime.diagnostics('learning.distiller')).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'analysis_unsupported' })]));
    await expect(runtime.dispatchSystemAction('learning.worker.once', {})).rejects.toThrow('analysis_unsupported');
  });
});
