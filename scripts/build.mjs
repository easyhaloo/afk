/**
 * Build script using esbuild with ESM extension fix plugin
 */
import { build } from 'esbuild';
import { globSync } from 'glob';
import { readFileSync, writeFileSync } from 'fs';
import { extname } from 'path';

const entryPoints = globSync('src/**/*.{ts,tsx}', {
  ignore: ['src/**/*.d.ts', 'src/**/*.test.ts', 'src/**/*.spec.ts']
});

// Plugin to fix ESM imports after build
const fixESMPlugin = {
  name: 'fix-esm-imports',
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length > 0) return;

      const outputFiles = globSync('dist/**/*.js');
      let fixedCount = 0;

      for (const file of outputFiles) {
        let content = readFileSync(file, 'utf8');
        const original = content;

        // Fix relative imports: './foo' -> './foo.js'
        content = content.replace(/from ['"](\.[^'"]+)['"]/g, (match, path) => {
          if (path.startsWith('.') && extname(path) === '') {
            return `from '${path}.js'`;
          }
          return match;
        });

        if (content !== original) {
          writeFileSync(file, content);
          fixedCount++;
        }
      }

      if (fixedCount > 0) {
        console.log(`✓ Fixed ESM imports in ${fixedCount} file(s)`);
      }
    });
  }
};

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
    plugins: [fixESMPlugin],
    logLevel: 'info',
  });

  console.log('✓ Build completed successfully');
} catch (error) {
  console.error('Build failed:', error);
  process.exit(1);
}
