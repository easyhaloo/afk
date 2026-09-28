import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeHookConfig, opencodePluginSource, supportsOpenCodePlugin } from '../scripts/hosts.mjs';

const command = '"/tmp/node bin" "/tmp/data with spaces/jev-agent-guard/current/scripts/adapters/codex.mjs" before-action';

test('Claude Code hooks use native nested groups without removing existing handlers', () => {
  const existing = { statusLine: { type: 'command', command: 'status' }, hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'existing-check' }] }],
  } };
  const result = mergeHookConfig(existing, 'claude-code', event => command.replace('before-action', event));
  assert.deepEqual(result.hooks.PreToolUse[0], existing.hooks.PreToolUse[0]);
  assert.equal(result.hooks.PreToolUse[1].hooks[0].command, command);
  assert.equal(result.hooks.PreToolUse[1].hooks[0].type, 'command');
  assert.match(result.hooks.UserPromptSubmit[0].hooks[0].command, /prompt$/);
  assert.equal(result.hooks.SessionStart[0].matcher, 'compact');
  assert.match(result.hooks.SessionStart[0].hooks[0].command, /resume-context$/);
  assert.match(result.hooks.PostToolUseFailure[0].hooks[0].command, /after-failure$/);
  assert.deepEqual(result.statusLine, existing.statusLine);
  assert.deepEqual(mergeHookConfig(result, 'claude-code', event => command.replace('before-action', event)), result);
});

test('Codex hooks use user-level native hook groups, not an inert manifest', () => {
  const result = mergeHookConfig({ description: 'original' }, 'codex', event => command.replace('before-action', event));
  assert.equal(result.description, 'original');
  assert.equal(result.hooks.PreToolUse[0].hooks[0].command, command);
  assert.equal(result.hooks.Stop[0].hooks[0].type, 'command');
  assert.match(result.hooks.UserPromptSubmit[0].hooks[0].command, /prompt$/);
  assert.equal(result.hooks.PostToolUseFailure, undefined);
});

test('OpenCode global shim re-exports a native ESM plugin using a file URL', () => {
  const source = opencodePluginSource('/tmp/runtime with spaces/scripts/adapters/opencode.mjs');
  assert.match(source, /^export \{ JevAgentGuard \} from "file:\/\/\/tmp\/runtime%20with%20spaces\/scripts\/adapters\/opencode\.mjs";\n$/);
});

test('OpenCode plugin registration rejects unknown or incompatible versions', () => {
  assert.equal(supportsOpenCodePlugin('1.18.31'), true);
  assert.equal(supportsOpenCodePlugin('1.18.28'), false);
  assert.equal(supportsOpenCodePlugin('2.0.0'), false);
  assert.equal(supportsOpenCodePlugin('unknown'), false);
});
