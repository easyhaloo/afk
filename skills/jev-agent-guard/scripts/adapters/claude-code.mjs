#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const SCRIPT_DIR = path.join(root, 'skills', 'jev-agent-guard', 'scripts');

function ensureAdapter(host) {
  const file = path.join(SCRIPT_DIR, 'adapters', `${host}.mjs`);
  if (!fs.existsSync(file)) {
    throw new Error(`Missing adapter: ${file}`);
  }
  return file;
}

function main() {
  const argv = process.argv.slice(2);
  const host = argv[0] || 'claude-code';
  const dryRun = argv.includes('--dry-run');
  const adapter = ensureAdapter(host.replace(/-code$/, '-code'));

  const summary = {
    host,
    adapter,
    dryRun,
    installTargets: [
      '.claude/settings.json',
      '.codex/config.json',
      '.opencode/config.json',
    ],
    action: 'create a minimal host configuration entry for the local agent guard',
  };

  if (dryRun) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(JSON.stringify({ ...summary, status: 'ready' }, null, 2));
}

main();
