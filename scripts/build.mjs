/**
 * Build script: transpile src/ to dist/ with esbuild, one output file per
 * source file (`bundle: false`).
 *
 * esbuild preserves each import specifier verbatim, so source must already be
 * Node-ESM valid: relative specifiers carry an explicit `.js` extension. There
 * used to be a post-build `fixESMPlugin` codemod that appended the missing
 * extensions; it was removed so that what ships matches what is committed.
 * Root `tsconfig.json` uses moduleResolution "bundler" and will NOT catch a
 * missing extension — a mistake surfaces only when Node loads dist/.
 */
import { build } from 'esbuild';
import { globSync } from 'glob';
import { rmSync } from 'fs';
import { resolve } from 'path';

const entryPoints = globSync('src/**/*.{ts,tsx}', {
  ignore: ['src/**/*.d.ts', 'src/**/*.test.ts', 'src/**/*.spec.ts']
});

rmSync(resolve('dist'), { recursive: true, force: true });

try {
  await build({
    entryPoints,
    outdir: 'dist',
    format: 'esm',
    platform: 'node',
    target: 'node18',
    sourcemap: true,
    jsx: 'automatic',
    outExtension: { '.js': '.js' },
    bundle: false,
    logLevel: 'warning',
  });

  console.log('✓ Build completed successfully');
} catch (error) {
  console.error('Build failed:', error);
  process.exit(1);
}
