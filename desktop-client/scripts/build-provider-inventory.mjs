import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const { build } = createRequire(new URL('../../package.json', import.meta.url))('esbuild');

// Only the provider snapshot is bundled. The Application/Core use cases are
// plain ESM workspace packages that Electron main imports directly, so they
// need no CommonJS artifact.
await build({
  entryPoints: [join(desktop, 'scripts/provider-inventory-entry.ts')],
  outfile: join(desktop, 'dist-electron/provider-inventory.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
});
