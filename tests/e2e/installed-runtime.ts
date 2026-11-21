import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));

export function resolveE2eRuntime(cli?: string, runtimeOverride?: string) {
  if (cli === undefined) return { mode: 'workspace' as const, runtime: runtimeOverride ?? join(workspace, 'packages/runtime/dist') };
  if (!isAbsolute(cli)) throw new Error('Expected absolute installed CLI entry');
  const binary = realpathSync(cli);
  const release = dirname(dirname(binary));
  assert.ok(!binary.startsWith(workspace + sep) && binary === join(release, 'dist/index.js'), 'Expected installed dist/index.js outside the workspace');
  const version: string = JSON.parse(readFileSync(join(workspace, 'apps/cli/package.json'), 'utf8')).version;
  assert.equal(JSON.parse(readFileSync(join(release, 'release.json'), 'utf8')).version, version, 'Installed CLI version differs from workspace');
  const runtime = realpathSync(join(release, 'node_modules/@afk/runtime/dist'));
  assert.ok(runtime.startsWith(release + sep), 'Runtime is outside the CLI installation');
  if (runtimeOverride !== undefined) assert.equal(realpathSync(runtimeOverride), runtime, 'Runtime does not belong to the selected CLI installation');
  return { mode: 'installed' as const, binary, runtime, version };
}
