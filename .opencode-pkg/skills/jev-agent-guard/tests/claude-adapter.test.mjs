import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { toClaudeResponse } from '../scripts/adapters/claude-code.mjs';

test('Claude Code leaves native permissions unchanged for Jev network advice', () => {
  assert.deepEqual(toClaudeResponse({ decision: 'advise', reason: 'Native permissions apply.' }, 'before-action'), {});
  assert.deepEqual(toClaudeResponse({ decision: 'needs-user', reason: 'Legacy Jev review' }, 'before-action'), {});
});

test('Claude Code stop block uses native feedback rather than tool denial', () => {
  assert.deepEqual(toClaudeResponse({ decision: 'deny', reason: 'Missing test evidence' }, 'stop'), {
    decision: 'block', reason: 'Missing test evidence',
  });
});

test('Claude Code stop feedback includes an actionable Skill step', () => {
  assert.deepEqual(toClaudeResponse({ decision: 'deny', reason: 'Skill step needs completion.',
    nextStep: 'Complete Skill step: Run validation.' }, 'stop'), {
    decision: 'block', reason: 'Skill step needs completion. Next: Complete Skill step: Run validation.',
  });
});

test('a safe decision does not grant permission on behalf of the host', () => {
  assert.deepEqual(toClaudeResponse({ decision: 'allow', reason: 'Locally safe' }, 'before-action'), {});
});

test('entrypoint emits a response when launched through a symlink', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-adapter-link-'));
  try {
    const adapter = fileURLToPath(new URL('../scripts/adapters/claude-code.mjs', import.meta.url));
    const alias = path.join(directory, 'claude-code.mjs');
    fs.symlinkSync(adapter, alias);
    const result = spawnSync(process.execPath, [alias, 'before-action'], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status --short' } }),
      env: { ...process.env, TYPESAFE_API_KEY: '' }, encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), {});
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Claude PostToolUse replaces only a safe successful dependency log', () => {
  const output = Array.from({ length: 300 }, (_, index) => `downloaded package-${index}`).join('\n');
  const response = toClaudeResponse({ decision: 'allow' }, 'after-action', {
    tool_name: 'Bash', tool_input: { command: 'npm ci' }, tool_response: output,
  });
  assert.ok(response.hookSpecificOutput.updatedToolOutput.length < output.length / 2);
});

test('Claude retains Bash output shape when compacting stdout', () => {
  const stdout = Array.from({ length: 300 }, (_, index) => `downloaded package-${index}`).join('\n');
  const tool_response = { stdout, stderr: '', interrupted: false, isImage: false };
  const response = toClaudeResponse({ decision: 'allow' }, 'after-action', {
    tool_name: 'Bash', tool_input: { command: 'npm ci' }, tool_response,
  });
  assert.ok(response.hookSpecificOutput.updatedToolOutput.stdout.length < stdout.length / 2);
  assert.equal(response.hookSpecificOutput.updatedToolOutput.stderr, '');
  assert.equal(tool_response.stdout, stdout);
});

test('Claude failure feedback uses the native failure event', () => {
  assert.deepEqual(toClaudeResponse({ decision: 'advise', reason: 'Repeated failures', nextStep: 'inspect_failure' }, 'after-failure'), {
    hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: 'Repeated failures Next: inspect_failure' },
  });
});
