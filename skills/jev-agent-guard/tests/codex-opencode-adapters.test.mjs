import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { toCodexResponse } from '../scripts/adapters/codex.mjs';
import { JevAgentGuard } from '../scripts/adapters/opencode.mjs';
import { loadLedger } from '../scripts/skill-ledger.mjs';

test('Codex maps local denial to supported native PreToolUse output', () => {
  assert.deepEqual(toCodexResponse({ decision: 'deny', reason: 'Destructive action' }, 'before-action'), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Destructive action' },
  });
});

test('Codex leaves native permissions unchanged for Jev network advice', () => {
  assert.deepEqual(toCodexResponse({ decision: 'advise', reason: 'Native permissions apply.' }, 'before-action'), {});
  assert.deepEqual(toCodexResponse({ decision: 'needs-user', reason: 'Legacy Jev review' }, 'before-action'), {});
});

test('Codex sends a trajectory hint as model-visible PostToolUse context', () => {
  assert.deepEqual(toCodexResponse({ decision: 'advise', reason: 'Repeated failures', nextStep: 'inspect_failure' }, 'after-action'), {
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'Repeated failures Next: inspect_failure' },
  });
});

test('Codex exposes a Skill recommendation as bounded prompt context', () => {
  assert.deepEqual(toCodexResponse({ decision: 'advise', reason: 'Recommended', nextStep: 'Suggested Skill: debug' }, 'prompt'), {
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Suggested Skill: debug' },
  });
});

test('Codex resumes compacted Skill context through SessionStart', () => {
  assert.deepEqual(toCodexResponse({ decision: 'advise', nextStep: 'Active Skill: debug' }, 'resume-context'), {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Active Skill: debug' },
  });
});

test('Codex stop feedback tells the agent which Skill step to complete', () => {
  assert.deepEqual(toCodexResponse({ decision: 'deny', reason: 'Skill step needs completion.',
    nextStep: 'Complete Skill step: Run validation.' }, 'stop'), {
    decision: 'block', reason: 'Skill step needs completion. Next: Complete Skill step: Run validation.',
  });
});

test('Codex stop advice provides a next action without blocking', () => {
  const response = toCodexResponse({ decision: 'advise', reason: 'No step can be verified.',
    nextStep: 'Run the required validation.' }, 'stop');
  assert.equal(response.continue, true);
  assert.match(response.systemMessage, /Next: Run the required validation/);
});

test('OpenCode plugin exposes native tool lifecycle handlers', async () => {
  const plugin = await JevAgentGuard({});
  assert.equal(typeof plugin['tool.execute.before'], 'function');
  assert.equal(typeof plugin['tool.execute.after'], 'function');
  await assert.rejects(() => plugin['tool.execute.before']({ tool: 'bash', sessionID: 'session' }, {
    args: { command: 'git reset --hard HEAD' },
  }), /Local policy blocks/);
});

test('OpenCode replaces only model-facing successful install output', async () => {
  const plugin = await JevAgentGuard({});
  const original = Array.from({ length: 250 }, (_, index) => `downloaded package-${index}`).join('\n');
  const output = { args: { command: 'npm ci' }, output: original, metadata: { exitCode: 0 } };
  await plugin['tool.execute.after']({ tool: 'bash', sessionID: 'session' }, output);
  assert.ok(output.output.length < original.length / 2);
});

test('OpenCode routes a relevant Skill in system context without editing the user prompt', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'jev opencode prompt '));
  try {
    const skill = path.join(project, '.opencode', 'skills', 'debug');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: debug\ndescription: Diagnose failing tests.\n---\n## Steps\n1. Reproduce failure\n');
    const plugin = await JevAgentGuard({ directory: project });
    const message = { parts: [{ type: 'text', text: 'Diagnose this failing test' }] };
    await plugin['chat.message']({ sessionID: 'session' }, message);
    assert.equal(message.parts.length, 1);
    const context = { system: ['Existing instructions'] };
    await plugin['experimental.chat.system.transform']({ sessionID: 'session' }, context);
    assert.match(context.system.join('\n'), /Suggested Skill: debug/);
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test('OpenCode records a successful Skill invocation even without an exit code', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev opencode skill '));
  try {
    const env = { HOME: home, XDG_STATE_HOME: path.join(home, 'state') };
    const plugin = await JevAgentGuard({ directory: home, env });
    await plugin['tool.execute.after']({ tool: 'skill', sessionID: 'session' }, {
      args: { name: 'debug' }, output: 'loaded', metadata: {},
    });
    const ledger = loadLedger({ host: 'opencode', sessionId: 'session', projectRoot: home }, env);
    assert.equal(ledger.skill.name, 'debug');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
