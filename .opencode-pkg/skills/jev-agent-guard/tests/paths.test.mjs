import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveHostPaths, resolveRuntimeRoot } from '../scripts/paths.mjs';

test('global runtime does not depend on the project or current directory', () => {
  const env = { HOME: '/tmp/home with spaces', XDG_DATA_HOME: '/tmp/data with spaces' };
  assert.equal(resolveRuntimeRoot(env, 'darwin'), '/tmp/data with spaces/jev-agent-guard');
  assert.equal(resolveRuntimeRoot({ HOME: env.HOME }, 'linux'), path.join(env.HOME, '.local/share/jev-agent-guard'));
});

test('host config paths honor explicit user-level locations', () => {
  const env = {
    HOME: '/tmp/home with spaces',
    CLAUDE_CONFIG_DIR: '/tmp/claude config',
    CODEX_HOME: '/tmp/codex config',
    XDG_CONFIG_HOME: '/tmp/xdg config',
  };
  assert.deepEqual(resolveHostPaths(env, 'darwin'), {
    'claude-code': '/tmp/claude config/settings.json',
    codex: '/tmp/codex config/hooks.json',
    opencode: '/tmp/xdg config/opencode/plugins/jev-agent-guard.js',
  });
});

test('Windows runtime uses LOCALAPPDATA', () => {
  assert.equal(resolveRuntimeRoot({ LOCALAPPDATA: 'C:\\Users\\User Name\\AppData\\Local' }, 'win32'),
    'C:\\Users\\User Name\\AppData\\Local\\jev-agent-guard');
});
