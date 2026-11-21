import { build } from 'esbuild';
import { globSync } from 'glob';
import { chmodSync, rmSync, cpSync, existsSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
await build({
  entryPoints: globSync('src/**/*.{ts,tsx}', { ignore: ['src/**/*.d.ts', 'src/**/*.test.*', 'src/**/*.spec.*'] }),
  outdir: 'dist', format: 'esm', platform: 'node', target: 'node18',
  sourcemap: true, jsx: 'automatic', bundle: false, logLevel: 'warning',
});
if (process.cwd().endsWith('/apps/cli')) chmodSync('dist/index.js', 0o755);
if (existsSync('src/application/plugins/tool-assets/playwright')) cpSync('src/application/plugins/tool-assets/playwright', 'dist/application/plugins/tool-assets/playwright', { recursive: true });
