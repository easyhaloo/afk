#!/usr/bin/env node
// ============================================================
// api-workflow Skill Validator
// ============================================================
// Self-contained structural validation. Uses only Node built-ins.
// Run from: skills/api-workflow/
// ============================================================

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { resolve, dirname, basename, extname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(__dirname, '..');
const OK = '✓';
const FAIL = '✗';

let failures = 0;

function fail(msg) {
  console.error(`  ${FAIL} ${msg}`);
  failures++;
}

function ok(msg) {
  console.log(`  ${OK} ${msg}`);
}

function readText(relPath) {
  const p = resolve(SKILL_DIR, relPath);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf-8');
}

function listFiles(dirRel) {
  const p = resolve(SKILL_DIR, dirRel);
  if (!existsSync(p)) return [];
  const result = [];
  const entries = readdirSync(p, { withFileTypes: true });
  for (const e of entries) {
    const full = join(p, e.name);
    if (e.isDirectory()) {
      result.push(...listFiles(join(dirRel, e.name)));
    } else {
      result.push(join(dirRel, e.name));
    }
  }
  return result;
}

// ── Frontmatter & SKILL.md ──────────────────────────────────

console.log('\n=== SKILL.md ===');

const skillMd = readText('SKILL.md');
if (!skillMd) {
  fail('SKILL.md not found');
  process.exit(1);
}

const frontmatterMatch = skillMd.match(/^---\n([\s\S]*?)\n---/);
if (!frontmatterMatch) {
  fail('Missing YAML frontmatter');
} else {
  ok('YAML frontmatter present');
  const fm = frontmatterMatch[1];
  if (fm.includes('name:')) ok('name field present');
  else fail('Missing name field');
  if (fm.includes('description:')) ok('description field present');
  else fail('Missing description field');
}

const lines = skillMd.split('\n');
if (lines.length <= 500) ok(`Line count: ${lines.length} (≤500)`);
else fail(`Line count: ${lines.length} (>500)`);

// ── Mode IDs ────────────────────────────────────────────────

console.log('\n=== Mode IDs ===');

const MODES = ['storage-state', 'localhost-cdp'];
for (const mode of MODES) {
  if (skillMd.includes(mode)) ok(`Mode '${mode}' referenced in SKILL.md`);
  else fail(`Mode '${mode}' not found in SKILL.md`);
}

const authModesRef = readText('references/hybrid-patterns/browser-auth-modes.md');
if (authModesRef) {
  for (const mode of MODES) {
    if (authModesRef.includes(mode)) ok(`Mode '${mode}' documented in browser-auth-modes.md`);
    else fail(`Mode '${mode}' not found in browser-auth-modes.md`);
  }
} else {
  fail('browser-auth-modes.md not found');
}

// ── Required files ──────────────────────────────────────────

console.log('\n=== Required Files ===');

const REQUIRED = [
  'SKILL.md',
  'references/hybrid-patterns/browser-auth-modes.md',
  'templates/fixtures/browser-session.storage-state.ts',
  'templates/fixtures/browser-session.localhost-cdp.ts',
  'templates/fixtures/api-context.ts',
  'templates/utils/require-env.ts',
  'templates/utils/cdp-endpoint.ts',
  'templates/setup/auth-api.setup.ts',
  'templates/setup/auth-ui.setup.ts',
  'templates/browser-auth-runbook.md',
  'templates/auth-artifacts.gitignore',
  'templates/auth.env.example',
  'templates/package.json',
  'templates/playwright.config.ts',
  'templates/scenarios/index.ts',
  'templates/scenarios/order-flow.spec.ts',
  'examples/combined-flows.md',
];

for (const f of REQUIRED) {
  if (existsSync(resolve(SKILL_DIR, f))) ok(f);
  else fail(`Missing: ${f}`);
}

// ── No credential fallbacks ─────────────────────────────────

console.log('\n=== Credential Fallbacks ===');

const SECRET_PATTERNS = [
  /'dev-api-key-\d+'/,
  /'password'/,
  /'test@example\.com'/,
  /\|\| 'dev-api-key-\d+'/,
  /\|\| 'password'/,
  /\|\| 'test@example\.com'/,
];

const allFiles = listFiles('.');
for (const f of allFiles) {
  if (f.startsWith('scripts/')) continue; // skip validator itself
  if (f.endsWith('.md') || f.endsWith('.json') || f.endsWith('.gitignore') || f.endsWith('.example')) continue;
  const content = readText(f);
  if (!content) continue;
  for (const pat of SECRET_PATTERNS) {
    if (pat.test(content)) {
      fail(`Hardcoded credential in ${f}: ${pat.source}`);
    }
  }
}
ok('No hardcoded credential fallbacks detected');

// ── Selected-only guidance ───────────────────────────────────

console.log('\n=== Selected-Only Guidance ===');

if (skillMd.includes('Copy only the selected mode') || skillMd.includes('only the selected mode')) {
  ok('Selected-only generation rule in SKILL.md');
} else {
  fail('Missing selected-only generation rule in SKILL.md');
}

// ── Auth mode fixture naming ─────────────────────────────────

console.log('\n=== Fixture Naming ===');

for (const mode of MODES) {
  const fixturePath = `templates/fixtures/browser-session.${mode}.ts`;
  const content = readText(fixturePath);
  if (!content) continue;
  if (content.includes('sessionContext')) ok(`${mode}: exports sessionContext`);
  else fail(`${mode}: missing sessionContext`);
  if (content.includes('sessionPage')) ok(`${mode}: exports sessionPage`);
  else fail(`${mode}: missing sessionPage`);
}

// ── CDP endpoint validator ───────────────────────────────────

console.log('\n=== CDP Endpoint Validator ===');

// Dynamically import ESM. We use a small inline test.
const cdpSrc = readText('templates/utils/cdp-endpoint.ts');
if (cdpSrc) {
  ok('cdp-endpoint.ts exists');
  // Check for key safety patterns
  for (const pat of ['ALLOWED_HOSTS', 'localhost', '127.0.0.1', '::1', 'username', 'password', 'search', 'hash']) {
    if (cdpSrc.includes(pat)) ok(`cdp-endpoint.ts contains '${pat}'`);
    else fail(`cdp-endpoint.ts missing '${pat}'`);
  }
} else {
  fail('cdp-endpoint.ts not found');
}

// ── gitignore and env guidance ───────────────────────────────

console.log('\n=== Target Project Guidance ===');

const gi = readText('templates/auth-artifacts.gitignore');
if (gi) {
  if (gi.includes('playwright/.auth')) ok('gitignore includes playwright/.auth');
  else fail('gitignore missing playwright/.auth');
  if (gi.includes('playwright/.profiles')) ok('gitignore includes playwright/.profiles');
  else fail('gitignore missing playwright/.profiles');
}

const envEx = readText('templates/auth.env.example');
if (envEx) {
  for (const v of ['AUTH_STATE_FILE', 'AUTH_PROFILE_DIR', 'CDP_ENDPOINT']) {
    if (envEx.includes(v)) ok(`.env.example references ${v}`);
    else fail(`.env.example missing ${v}`);
  }
}

// ── No root/CLI dependency assumptions ───────────────────────

console.log('\n=== Root/CLI Independence ===');

for (const f of allFiles) {
  if (f.startsWith('scripts/')) continue; // skip validator itself
  const content = readText(f);
  if (!content) continue;
  // Check for imports of AFK CLI modules
  if (content.includes("from 'afk") || content.includes("require('afk")) {
    fail(`${f} imports from 'afk'`);
  }
  if (content.includes("from '../../src/") || content.includes("require('../../src/")) {
    fail(`${f} imports from AFK src/`);
  }
}
ok('No AFK CLI/root dependency references');

// ── Result ───────────────────────────────────────────────────

console.log(`\n${failures === 0 ? OK : FAIL} ${failures} failure(s)`);
process.exit(failures > 0 ? 1 : 0);