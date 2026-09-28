#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hasOwnHook, mergeHookConfig, opencodePluginSource, removeHookConfig, supportsOpenCodePlugin } from './hosts.mjs';
import { resolveHostPaths, resolveRuntimeRoot } from './paths.mjs';

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const operation = args.find(argument => !argument.startsWith('--')) ?? 'install';
const dryRun = args.includes('--dry-run');
const skipSdk = args.includes('--skip-sdk');
const hostArg = args.find(argument => argument.startsWith('--host='))?.slice(7) ?? 'all';
const hosts = hostArg === 'all' ? ['claude-code', 'codex', 'opencode'] : hostArg.split(',');
const supported = new Set(['claude-code', 'codex', 'opencode']);
const runtimeRoot = resolveRuntimeRoot();
const runtime = path.join(runtimeRoot, 'current');

function quote(value) {
  if (process.platform === 'win32') return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function commandFor(host, event) {
  return `${quote(process.execPath)} ${quote(path.join(runtime, 'scripts', 'adapters', `${host}.mjs`))} ${event}`;
}

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid object in ${file}`);
  return value;
}

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && !fs.existsSync(`${file}.jev-agent-guard.bak`)) {
    fs.writeFileSync(`${file}.jev-agent-guard.bak`, fs.readFileSync(file), { flag: 'wx', mode: 0o600 });
  }
  const staged = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(staged, content, { mode: 0o600 });
    fs.renameSync(staged, file);
  } finally {
    if (fs.existsSync(staged)) fs.unlinkSync(staged);
  }
}

function hostChanges() {
  const locations = resolveHostPaths();
  return hosts.map(host => {
    const file = locations[host];
    if (host === 'opencode') {
      const version = spawnSync('opencode', ['--version'], { encoding: 'utf8', timeout: 4000 });
      if (!version.error && (version.status !== 0 || !supportsOpenCodePlugin(version.stdout))) {
        throw new Error(`Unsupported OpenCode plugin API version: ${version.stdout.trim() || version.stderr.trim()}`);
      }
      if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').includes('JevAgentGuard')) {
        throw new Error(`Refusing to replace an unrelated plugin: ${file}`);
      }
      return { file, content: opencodePluginSource(path.join(runtime, 'scripts', 'adapters', 'opencode.mjs')) };
    }
    const config = mergeHookConfig(readJson(file), host, event => commandFor(host, event));
    return { file, content: `${JSON.stringify(config, null, 2)}\n` };
  });
}

function stageRuntime() {
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const staged = fs.mkdtempSync(path.join(runtimeRoot, '.staging-'));
  try {
    for (const name of ['SKILL.md', 'package.json', 'npm-shrinkwrap.json', 'rules', 'references', 'scripts']) {
      const source = path.join(sourceRoot, name);
      if (fs.existsSync(source)) fs.cpSync(source, path.join(staged, name), { recursive: true });
    }
    if (!skipSdk) {
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const result = spawnSync(npm, ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: staged, stdio: 'inherit' });
      if (result.status !== 0) throw new Error(`SDK installation failed: ${result.error?.message ?? result.status}`);
    }
    const previous = path.join(runtimeRoot, 'previous');
    if (fs.existsSync(previous)) fs.rmSync(previous, { recursive: true });
    if (fs.existsSync(runtime)) fs.renameSync(runtime, previous);
    try { fs.renameSync(staged, runtime); }
    catch (error) {
      if (fs.existsSync(previous)) fs.renameSync(previous, runtime);
      throw error;
    }
  } finally {
    if (fs.existsSync(staged)) fs.rmSync(staged, { recursive: true });
  }
}

function main() {
  if (!['install', 'doctor', 'uninstall'].includes(operation)) throw new Error(`Unsupported operation: ${operation}`);
  if (hosts.length === 0 || hosts.some(host => !supported.has(host))) throw new Error(`Unsupported host selection: ${hostArg}`);
  if (!fs.existsSync(path.join(sourceRoot, 'package.json'))) throw new Error(`Missing Skill package in ${sourceRoot}`);
  if (operation === 'doctor') {
    const locations = resolveHostPaths();
    const report = { runtime: { path: runtime, exists: fs.existsSync(runtime), sdk: fs.existsSync(path.join(runtime, 'node_modules', '@typesafe-ai', 'sdk')) }, hosts: {} };
    for (const host of hosts) {
      const file = locations[host];
      const configured = host === 'opencode'
        ? fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('JevAgentGuard')
        : hasOwnHook(readJson(file));
      report.hosts[host] = { path: file, configured, loaded: 'unverified', triggered: 'unverified' };
    }
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (operation === 'uninstall') {
    const locations = resolveHostPaths();
    for (const host of hosts) {
      const file = locations[host];
      if (!fs.existsSync(file)) continue;
      if (host === 'opencode') {
        if (fs.readFileSync(file, 'utf8').includes('JevAgentGuard') && !dryRun) fs.unlinkSync(file);
      } else {
        const config = readJson(file);
        if (hasOwnHook(config) && !dryRun) writeAtomic(file, `${JSON.stringify(removeHookConfig(config), null, 2)}\n`);
      }
    }
    console.log(dryRun ? 'would remove Jev hooks' : 'Removed Jev hooks; runtime retained for other consumers.');
    return;
  }
  const changes = hostChanges();
  if (dryRun) {
    console.log(`would install jev-agent-guard in ${runtime}`);
    for (const change of changes) console.log(`would update ${change.file}`);
    return;
  }
  stageRuntime();
  for (const change of changes) writeAtomic(change.file, change.content);
  console.log(`Installed jev-agent-guard in ${runtime}`);
  if (skipSdk) console.warn('SDK installation skipped; runtime requires @typesafe-ai/sdk before use.');
}

try { main(); }
catch (error) { console.error(error.message); process.exitCode = 2; }
