// Build the Electron main process as two self-contained artifacts.
//
// Why bundle at all: the @afk/* workspace packages are pnpm symlinks, and
// electron-builder does not follow workspace links, so a packaged app would
// have no node_modules/@afk/application to resolve at runtime. Bundling here
// keeps the source a single-module-system ESM tree while making the packaged
// main self-contained.
//
//   main.js    ESM, with @afk/* inlined
//   preload.cjs CommonJS, because sandboxed preloads must be CJS
//
// The preload source is an ES module: it shares the channel table with the
// main process, and that table lives in the ESM shared contract. esbuild
// lowers the module to CommonJS on the way out, so the artifact stays
// loadable by a sandboxed preload.
//
// `electron` and `node-pty` stay external: the first is provided by the
// runtime, the second is a native module that electron-builder rebuilds.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const { build } = createRequire(new URL('../../package.json', import.meta.url))('esbuild');

const watch = process.argv.includes('--watch');

// Drop previous per-file tsc output so a stale unbundled tree cannot be
// packaged alongside the bundle. Both `electron/` and `shared/` are now fully
// inlined into main.js, so neither has a place in dist-electron.
if (!watch) {
  rmSync(join(desktop, 'dist-electron/electron'), { recursive: true, force: true });
  rmSync(join(desktop, 'dist-electron/shared'), { recursive: true, force: true });
}

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  logLevel: 'warning',
  external: ['electron', 'node-pty'],
};

// A CommonJS dependency that calls require() at load time — simple-git pulls
// in @kwsites/file-exists, which does — cannot be bundled into an ESM
// output: esbuild's require shim has no synchronous require to fall back on
// in an ES module. Give the bundle a real one.
const esmRequireBanner = `import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);`;

const configs = [
  {
    ...common,
    entryPoints: [join(desktop, 'electron/main.ts')],
    outfile: join(desktop, 'dist-electron/electron/main.js'),
    format: 'esm',
    banner: { js: esmRequireBanner },
  },
  {
    ...common,
    entryPoints: [join(desktop, 'electron/preload.ts')],
    outfile: join(desktop, 'dist-electron/electron/preload.cjs'),
    format: 'cjs',
  },
];

if (watch) {
  const { context } = await import('esbuild');
  for (const config of configs) {
    const ctx = await context(config);
    await ctx.watch();
  }
  console.log('✓ watching electron main');
} else {
  await Promise.all(configs.map((config) => build(config)));
  console.log('✓ Electron main build completed');
}
