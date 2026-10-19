import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const { build } = createRequire(new URL('../../package.json', import.meta.url))('esbuild');

// The desktop's runtime bindings are bundled as CommonJS: the provider
// catalog, the management provider and the work item execution. Electron main
// loads this module so the end-to-end suite can replace it with a fixture.
//
// A CommonJS output has no import.meta, so a bundled module that reads
// import.meta.url — createRequire(import.meta.url) is the common case — would
// see an empty string. Point it at the bundle's own location instead. esbuild
// only accepts an identifier as a define value, so the expression lives in
// the banner and the define names it.
await build({
  entryPoints: [join(desktop, 'scripts/provider-inventory-entry.ts')],
  outfile: join(desktop, 'dist-electron/provider-inventory.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  banner: {
    js: 'const importMetaUrl = require("node:url").pathToFileURL(__filename).href;',
  },
  define: {
    'import.meta.url': 'importMetaUrl',
  },
});
