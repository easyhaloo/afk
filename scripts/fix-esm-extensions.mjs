/**
 * Post-build ESM extension fix
 * Adds .js extensions to relative imports for Node.js v24 ESM compatibility
 */
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, extname } from 'path';

const distDir = './dist';

function fixFile(filepath) {
  let content = readFileSync(filepath, 'utf8');
  const original = content;

  // Fix relative imports: './foo' -> './foo.js' but not './foo.js'
  content = content.replace(/from ['"](\.[^'"]+)['"]/g, (match, path) => {
    // Skip if already has extension (except for bare specifiers)
    if (path.startsWith('.')) {
      const hasExt = extname(path) !== '';
      if (!hasExt) {
        return `from '${path}.js'`;
      }
    }
    return match;
  });

  if (content !== original) {
    writeFileSync(filepath, content);
    console.log(`Fixed: ${filepath}`);
  }
}

function walkDir(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full);
    } else if (entry.name.endsWith('.js')) {
      fixFile(full);
    }
  }
}

walkDir(distDir);
console.log('ESM extensions fixed.');
