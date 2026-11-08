import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packages = ['core', 'application', 'workflow-graph', 'runtime'];
const sourceRoots = [...packages.map(name => `packages/${name}/src`), 'apps/cli/src'];
const alias = packages.flatMap(name => {
  const packageRoot = new URL(`./packages/${name}/`, import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8'));
  return Object.entries(manifest.exports).map(([subpath, target]) => ({
    find: new RegExp(`^@afk/${name}${subpath === '.' ? '' : subpath.slice(1)}$`),
    replacement: fileURLToPath(new URL(
      (target as { import: string }).import.replace('./dist/', './src/').replace(/\.js$/, '.ts'),
      packageRoot,
    )),
  }));
});

export default defineConfig({
  resolve: { alias },
  test: {
    environment: 'node',
    setupFiles: [fileURLToPath(new URL('./scripts/test-home.ts', import.meta.url))],
    env: { GIT_CONFIG_NOSYSTEM: '1' },
    include: [],
    exclude: ['**/node_modules/**', 'tests/pty/**'],
    testTimeout: 60000,
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    coverage: {
      provider: 'v8',
      all: true,
      include: sourceRoots.map(root => `${root}/**/*.{ts,tsx}`),
      exclude: ['**/*.d.ts', '**/*.{test,spec}.{ts,tsx}'],
      reportsDirectory: 'coverage',
      clean: true,
      reportOnFailure: true,
      processingConcurrency: 2,
      reporter: ['text-summary', 'json-summary', 'lcovonly', 'html'],
    },
  },
});
