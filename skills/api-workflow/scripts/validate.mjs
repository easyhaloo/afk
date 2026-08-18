#!/usr/bin/env node
// ============================================================
// api-workflow Skill Validator
// ============================================================
// Validates the skill contract and consistency of its reusable
// context. It does not require a particular authentication mode
// or generated project layout.
// Run from: skills/api-workflow/
// ============================================================

import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(__dirname, '..');
const OK = '✓';
const FAIL = '✗';
let failures = 0;

function fail(msg) { console.error(`  ${FAIL} ${msg}`); failures++; }
function ok(msg) { console.log(`  ${OK} ${msg}`); }
function readText(relPath) {
  const p = resolve(SKILL_DIR, relPath);
  return existsSync(p) ? readFileSync(p, 'utf-8') : null;
}
function listFiles(dirRel) {
  const p = resolve(SKILL_DIR, dirRel);
  if (!existsSync(p)) return [];
  const result = [];
  for (const entry of readdirSync(p, { withFileTypes: true })) {
    const rel = join(dirRel, entry.name);
    if (entry.isDirectory()) result.push(...listFiles(rel));
    else result.push(rel);
  }
  return result;
}

console.log('\n=== SKILL.md ===');
const skillMd = readText('SKILL.md');
if (!skillMd) {
  fail('SKILL.md not found');
  process.exit(1);
}
const frontmatter = skillMd.match(/^---\n([\s\S]*?)\n---/);
if (frontmatter) ok('YAML frontmatter present');
else fail('Missing YAML frontmatter');
if (/^name:\s*\S+/m.test(skillMd)) ok('name field present');
else fail('Missing name field');
if (/^description:\s*\S+/m.test(skillMd)) ok('description field present');
else fail('Missing description field');
if (skillMd.split('\n').length <= 500) ok('SKILL.md remains focused (≤500 lines)');
else fail('SKILL.md is too large (>500 lines)');

console.log('\n=== Skill Context ===');
for (const dir of ['references', 'templates', 'scripts', 'examples']) {
  if (existsSync(resolve(SKILL_DIR, dir))) ok(`${dir}/ present`);
  else ok(`${dir}/ not required`);
}

console.log('\n=== Context Consistency ===');
const contextFiles = listFiles('references').concat(listFiles('templates'), listFiles('examples'));
if (contextFiles.length > 0) ok(`${contextFiles.length} reference/template/example files discovered`);
else ok('No optional context files present');

const allFiles = listFiles('.');
const SECRET_PATTERNS = [
  /dev-api-key-\d+/i,
  /test@example\.com/i,
  /password\s*[:=]\s*['"][^'"]+['"]/i,
];
for (const file of allFiles) {
  if (file.startsWith('scripts/')) continue;
  const content = readText(file);
  if (!content) continue;
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(content)) fail(`Possible hardcoded credential in ${file}`);
  }
}
if (failures === 0) ok('No known hardcoded credential patterns detected');

console.log('\n=== References / Templates / Examples ===');
for (const dir of ['references', 'templates', 'examples']) {
  for (const file of listFiles(dir)) {
    const content = readText(file);
    if (!content) continue;
    if (content.includes('TEMPLATE_ONLY') || content.includes('TODO:REQUIRED')) {
      fail(`${file} contains unresolved placeholder markers`);
    }
  }
}
ok('No unresolved placeholder markers detected');

console.log('\n=== Script Independence ===');
for (const file of allFiles) {
  if (file === 'scripts/validate.mjs') continue;
  const content = readText(file);
  if (!content) continue;
  if (content.includes("from 'afk") || content.includes("require('afk")) {
    fail(`${file} imports from the AFK package`);
  }
}
if (failures === 0) ok('No AFK package dependency assumptions detected');

console.log(`\n${failures === 0 ? OK : FAIL} ${failures} failure(s)`);
process.exit(failures > 0 ? 1 : 0);
