#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const skill = path.join(root, 'skills', 'jev-agent-guard');
const marker = 'jev-agent-guard';
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const skipSdk = args.includes('--skip-sdk');
const hostArg = args.find(value => value.startsWith('--host='))?.slice(7) ?? 'all';
const hosts = hostArg === 'all' ? ['claude-code', 'codex', 'opencode'] : hostArg.split(',');

function log(message) { console.log(`[jev-agent-guard] ${message}`); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function command(host, event = 'before-action') {
  return `node skills/jev-agent-guard/scripts/adapters/${host}.mjs ${event}`;
}
function apply(file, value) {
  if (dryRun) { log(`would update ${path.relative(root, file)}`); return; }
  writeJson(file, value); log(`updated ${path.relative(root, file)}`);
}
function installClaude() {
  const file = path.join(root, '.claude', 'settings.json');
  const settings = readJson(file, {});
  const hooks = settings.hooks ?? {};
  const current = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  if (!current.some(item => item?.command?.includes(marker))) current.push({ type: 'command', command: command('claude-code', 'before-action') });
  hooks.PreToolUse = current;
  const post = Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : [];
  if (!post.some(item => item?.command?.includes(marker))) post.push({ type: 'command', command: command('claude-code', 'after-action') });
  hooks.PostToolUse = post;
  const stop = Array.isArray(hooks.Stop) ? hooks.Stop : [];
  if (!stop.some(item => item?.command?.includes(marker))) stop.push({ type: 'command', command: command('claude-code', 'stop') });
  hooks.Stop = stop;
  settings.hooks = hooks;
  apply(file, settings);
}
function installCodex() {
  const file = path.join(root, '.codex', 'jev-agent-guard.json');
  apply(file, { version: 1, command: command('codex', 'before-action'), after_action: command('codex', 'after-action'), stop: command('codex', 'stop') });
  log('Codex uses the generated wrapper manifest; connect these commands through the Codex hook/wrapper mechanism available in your installed version.');
}
function installOpenCode() {
  const file = path.join(root, '.opencode', 'config.json');
  const config = readJson(file, {});
  const plugins = Array.isArray(config.plugins) ? config.plugins : [];
  if (!plugins.some(item => item?.name === marker)) plugins.push({ name: marker, entry: './skills/jev-agent-guard/scripts/adapters/opencode.mjs' });
  config.plugins = plugins;
  apply(file, config);
  log('OpenCode plugin entry is installed; the adapter exposes a stdin JSON bridge and plugin factory.');
}
if (!fs.existsSync(path.join(skill, 'package.json'))) { console.error('Run from the repository root.'); process.exit(2); }
if (!skipSdk && !dryRun) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: skill, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
for (const host of hosts) {
  if (host === 'claude-code') installClaude();
  else if (host === 'codex') installCodex();
  else if (host === 'opencode') installOpenCode();
  else { console.error(`Unsupported host: ${host}`); process.exit(2); }
}
log(dryRun ? 'dry-run complete' : 'installation complete');
