import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));
const sdkInstaller = fileURLToPath(new URL('../scripts/install-sdk.mjs', import.meta.url));

test('global dry run from another project does not write to the user home', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev home '));
  const output = execFileSync(process.execPath, [installer, '--global', '--dry-run', '--host=claude-code'], {
    cwd: os.tmpdir(),
    env: { ...process.env, HOME: home, XDG_DATA_HOME: path.join(home, 'data') },
    encoding: 'utf8',
  });
  assert.match(output, /would install.*jev-agent-guard/i);
  assert.equal(fs.existsSync(path.join(home, '.claude')), false);
});

test('standalone SDK installer looks for package.json in its own Skill directory', () => {
  const source = fs.readFileSync(sdkInstaller, 'utf8');
  assert.match(source, /fileURLToPath\(new URL\('\.\.', import\.meta\.url\)\)/);
  assert.doesNotMatch(source, /path\.resolve\(new URL\('\.\.', import\.meta\.url\)\.pathname, '\.\.'\)/);
});

test('global install preserves unrelated user hooks across repeated runs', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev global '));
  const claudeConfig = path.join(home, '.claude', 'settings.json');
  const codexConfig = path.join(home, '.codex', 'hooks.json');
  fs.mkdirSync(path.dirname(claudeConfig), { recursive: true });
  fs.mkdirSync(path.dirname(codexConfig), { recursive: true });
  fs.writeFileSync(claudeConfig, JSON.stringify({ hooks: { PreToolUse: [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'existing-check' }] },
  ] } }));
  fs.writeFileSync(codexConfig, JSON.stringify({ description: 'unrelated' }));
  const env = { ...process.env, HOME: home, XDG_DATA_HOME: path.join(home, 'data'), XDG_CONFIG_HOME: path.join(home, 'config') };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    execFileSync(process.execPath, [installer, '--global', '--skip-sdk'], {
      cwd: os.tmpdir(), env, encoding: 'utf8',
    });
  }
  const claude = JSON.parse(fs.readFileSync(claudeConfig, 'utf8'));
  const codex = JSON.parse(fs.readFileSync(codexConfig, 'utf8'));
  assert.equal(fs.statSync(`${claudeConfig}.jev-agent-guard.bak`).mode & 0o777, 0o600);
  assert.equal(fs.statSync(`${codexConfig}.jev-agent-guard.bak`).mode & 0o777, 0o600);
  assert.equal(claude.hooks.PreToolUse.length, 2);
  assert.equal(claude.hooks.PreToolUse[0].hooks[0].command, 'existing-check');
  assert.equal(codex.description, 'unrelated');
  assert.equal(codex.hooks.PreToolUse.length, 1);
  const runtime = path.join(home, 'data', 'jev-agent-guard', 'current');
  assert.equal(fs.existsSync(path.join(runtime, 'scripts', 'jev.mjs')), true);
  assert.equal(fs.existsSync(path.join(runtime, 'node_modules')), false);
  assert.match(fs.readFileSync(path.join(home, 'config', 'opencode', 'plugins', 'jev-agent-guard.js'), 'utf8'), /JevAgentGuard/);
});

test('invalid existing host settings fail without replacing them', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev invalid '));
  const config = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, '{invalid');
  assert.throws(() => execFileSync(process.execPath, [installer, '--global', '--skip-sdk', '--host=claude-code'], {
    cwd: os.tmpdir(), env: { ...process.env, HOME: home, XDG_DATA_HOME: path.join(home, 'data') }, stdio: 'pipe',
  }));
  assert.equal(fs.readFileSync(config, 'utf8'), '{invalid');
  assert.equal(fs.existsSync(path.join(home, 'data', 'jev-agent-guard', 'current')), false);
});

test('doctor reports configured versus unverified runtime state', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev doctor '));
  const env = { ...process.env, HOME: home, XDG_DATA_HOME: path.join(home, 'data') };
  const output = execFileSync(process.execPath, [installer, 'doctor', '--host=claude-code'], {
    cwd: os.tmpdir(), env, encoding: 'utf8',
  });
  const report = JSON.parse(output);
  assert.equal(report.runtime.exists, false);
  assert.equal(report.hosts['claude-code'].configured, false);
  assert.equal(report.hosts['claude-code'].triggered, 'unverified');
});

test('uninstall removes only own hooks, preserving existing handlers', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev uninstall '));
  const config = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, JSON.stringify({ hooks: { PreToolUse: [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'existing-check' }] },
  ] } }));
  const env = { ...process.env, HOME: home, XDG_DATA_HOME: path.join(home, 'data') };
  const invoke = (...flags) => execFileSync(process.execPath, [installer, ...flags, '--host=claude-code', '--skip-sdk'], {
    cwd: os.tmpdir(), env, encoding: 'utf8',
  });
  invoke('--global');
  invoke('uninstall');
  const hooks = JSON.parse(fs.readFileSync(config, 'utf8')).hooks.PreToolUse;
  assert.deepEqual(hooks, [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'existing-check' }] }]);
});
