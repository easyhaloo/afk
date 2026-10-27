// Build the Electron main process, execution worker and preload.
//
// Why bundle at all: the @afk/* workspace packages are pnpm symlinks, and
// electron-builder does not follow workspace links, so a packaged app would
// have no node_modules/@afk/application to resolve at runtime. Bundling here
// keeps the source a single-module-system ESM tree while making the packaged
// main self-contained.
//
//   main.js    ESM, with @afk/* inlined
//   execution-worker.js ESM, shared runtime in a separate process
//   preload.cjs CommonJS, because sandboxed preloads must be CJS
//
// `electron` and `node-pty` stay external: the first is provided by the
// runtime, the second is a native module that electron-builder rebuilds.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const { build } = createRequire(new URL('../package.json', import.meta.url))('esbuild');

const watch = process.argv.includes('--watch');
const e2e = process.argv.includes('--e2e');
const output = join(desktop, 'dist-electron', ...(e2e ? ['e2e'] : []));

// Drop previous per-file tsc output so a stale unbundled tree cannot be
// packaged alongside the bundle. Both `electron/` and `shared/` are now fully
// inlined into main.js, so neither has a place in dist-electron.
if (!watch) {
  rmSync(join(output, 'electron'), { recursive: true, force: true });
  rmSync(join(output, 'shared'), { recursive: true, force: true });
}

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  logLevel: 'warning',
  external: ['electron', 'node-pty', 'electron-updater'],
  ...(e2e ? { alias: {
    '@afk/runtime/backlog': join(desktop, 'tests/e2e/fixtures/runtime.ts'),
    '@afk/runtime/execution': join(desktop, 'tests/e2e/fixtures/runtime.ts'),
  } } : {}),
};

const configs = [
  {
    ...common,
    entryPoints: [join(desktop, 'electron/main.ts')],
    outfile: join(output, 'electron/main.js'),
    format: 'esm',
    banner: { js: "import { createRequire as createBundleRequire } from 'node:module'; const require = createBundleRequire(import.meta.url);" },
  },
  {
    ...common,
    entryPoints: [join(desktop, 'electron/worker/execution-worker.ts')],
    outfile: join(output, 'execution-worker.js'),
    format: 'esm',
    banner: { js: "import { createRequire as createBundleRequire } from 'node:module'; const require = createBundleRequire(import.meta.url);" },
  },
  {
    ...common,
    entryPoints: [join(desktop, 'electron/preload.cts')],
    outfile: join(output, 'electron/preload.cjs'),
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
