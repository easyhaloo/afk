import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../src/', import.meta.url).pathname;
const forbiddenDirectories = ['lib', 'core'];
const forbiddenImports = ['/lib/', '/core/', '../lib/', '../core/', './lib/', './core/'];
const forbiddenPatterns = [
  { pattern: /Record<string,\s*unknown>/g, message: 'generic Record<string, unknown> used in source' },
  { pattern: /from ['"]\.\.?\/.*client-factory['"]/g, message: 'legacy client-factory import remains' },
];

const violations = [];

function walk(directory) {
  for (const entry of readdirSync(directory)) {
    const fullPath = join(directory, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (forbiddenDirectories.includes(entry)) {
        violations.push(`${fullPath}: forbidden architecture directory`);
        continue;
      }
      walk(fullPath);
      continue;
    }
    if (!fullPath.endsWith('.ts') && !fullPath.endsWith('.tsx')) continue;

    const source = readFileSync(fullPath, 'utf8');
    for (const forbidden of forbiddenImports) {
      if (source.includes(forbidden)) {
        violations.push(`${fullPath}: forbidden import pattern '${forbidden}'`);
      }
    }
    for (const rule of forbiddenPatterns) {
      if (rule.pattern.test(source)) {
        violations.push(`${fullPath}: ${rule.message}`);
      }
      rule.pattern.lastIndex = 0;
    }
  }
}

if (!existsSync(root)) {
  console.error(`Missing source root: ${root}`);
  process.exit(1);
}

walk(root);

if (violations.length > 0) {
  console.error('Architecture guard failed:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log('Architecture guard passed.');
