/**
 * Build script using esbuild with ESM extension fix plugin
 */
import { build } from 'esbuild';
import { globSync } from 'glob';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { extname, resolve, dirname } from 'path';

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

        // Fix relative imports: './foo' -> './foo.js' or './foo/index.js'
        // Only processes paths that don't already have an extension
        content = content
          .replace(/from\s+(['"])(\.[^'"]+)\1/g, (match, quote, path) => {
            if (extname(path)) return match; // already has extension
            const dir = dirname(file);
            const withJs = resolve(dir, path + '.js');
            const asIndex = resolve(dir, path, 'index.js');
            if (existsSync(withJs)) return `from ${quote}${path}.js${quote}`;
            if (existsSync(asIndex)) return `from ${quote}${path}/index.js${quote}`;
            return `from ${quote}${path}.js${quote}`;
          })
          // Fix side-effect imports: import './foo' -> import './foo.js'
          .replace(/import\s+(['"])(\.[^'"]+)\1\s*;/g, (match, quote, path) => {
            if (extname(path)) return match; // already has extension
            const dir = dirname(file);
            const withJs = resolve(dir, path + '.js');
            const asIndex = resolve(dir, path, 'index.js');
            if (existsSync(withJs)) return `import ${quote}${path}.js${quote};`;
            if (existsSync(asIndex)) return `import ${quote}${path}/index.js${quote};`;
            return `import ${quote}${path}.js${quote};`;
          })
          .replace(/import\s*\(\s*(['"])(\.[^'"]+)\1\s*\)/g, (match, quote, path) => {
            if (extname(path)) return match; // already has extension
            const dir = dirname(file);
            const withJs = resolve(dir, path + '.js');
            const asIndex = resolve(dir, path, 'index.js');
            if (existsSync(withJs)) return `import(${quote}${path}.js${quote})`;
            if (existsSync(asIndex)) return `import(${quote}${path}/index.js${quote})`;
            return `import(${quote}${path}.js${quote})`;
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
    logLevel: 'warning',
  });

  console.log('✓ Build completed successfully');
} catch (error) {
  console.error('Build failed:', error);
  process.exit(1);
}
