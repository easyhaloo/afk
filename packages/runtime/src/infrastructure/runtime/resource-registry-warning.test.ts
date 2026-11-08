import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

it('loads the resource registry quietly and preserves unrelated runtime warnings', async () => {
  const moduleUrl = new URL('./resource-registry.ts', import.meta.url).href;
  const { stderr } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval',
    `await import(${JSON.stringify(moduleUrl)}); process.emitWarning('unrelated fixture warning', 'ExperimentalWarning');`,
  ]);
  expect(stderr).not.toContain('SQLite is an experimental feature');
  expect(stderr).toContain('unrelated fixture warning');
});
