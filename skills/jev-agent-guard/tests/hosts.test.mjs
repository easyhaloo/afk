import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeHookConfig, opencodePluginSource, opencodePluginSourceV2, supportsOpenCodePlugin, supportsOpenCodeV2 } from '../scripts/hosts.mjs';

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

test('OpenCode V2 plugin gate accepts 2.x and rejects older or unknown versions', () => {
  assert.equal(supportsOpenCodeV2('2.0.0'), true);
  assert.equal(supportsOpenCodeV2('2.2.2'), true);
  assert.equal(supportsOpenCodeV2('opencode v2.2.2'), true);
  assert.equal(supportsOpenCodeV2('1.18.29'), false);
  assert.equal(supportsOpenCodeV2('1.19.0'), false);
  assert.equal(supportsOpenCodeV2('1.18.28'), false);
  assert.equal(supportsOpenCodeV2('0.4.0'), false);
  assert.equal(supportsOpenCodeV2('unknown'), false);
});

test('OpenCode V2 shim re-exports a default plugin using a file URL and keeps the guard marker', () => {
  const source = opencodePluginSourceV2('/tmp/runtime with spaces/scripts/adapters/opencode-v2.mjs');
  assert.match(source, /export \{ default \} from "file:\/\/\/tmp\/runtime%20with%20spaces\/scripts\/adapters\/opencode-v2\.mjs";\n$/);
  assert.match(source, /JevAgentGuard/);
});
