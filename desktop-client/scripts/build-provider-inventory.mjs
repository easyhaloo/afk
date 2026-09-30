import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const { build } = createRequire(new URL('../../package.json', import.meta.url))('esbuild');
await build({
  entryPoints: [join(desktop, 'scripts/provider-inventory-entry.ts')],
  outfile: join(desktop, 'dist-electron/provider-inventory.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
});
await build({
  entryPoints: [join(desktop, '..', 'packages/afk-application/src/index.ts')],
  outfile: join(desktop, 'dist-electron/application.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
});
