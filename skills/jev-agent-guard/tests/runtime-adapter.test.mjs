import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAdapter } from '../scripts/adapters/runtime-adapter.mjs';
import { recordAction, recordSkill } from '../scripts/skill-ledger.mjs';

test('safe local command skips Jev and allows host-native permissions', async () => {
  let calls = 0;
  const result = await runAdapter({ host: 'claude-code', event: 'before-action', payload: {
    tool_name: 'Bash', tool_input: { command: 'git status --short' },
  }, evaluate: async () => { calls += 1; } });
  assert.equal(result.decision, 'allow');
  assert.equal(calls, 0);
});

test('destructive command is denied locally before any provider call', async () => {
  let calls = 0;
  const result = await runAdapter({ host: 'codex', event: 'before-action', payload: {
    tool_name: 'shell_command', tool_input: { command: 'git reset --hard HEAD' },
  }, evaluate: async () => { calls += 1; } });
  assert.equal(result.decision, 'deny');
  assert.equal(calls, 0);
});

test('read tool cannot bypass credential path checks', async () => {
  const result = await runAdapter({ host: 'claude-code', event: 'before-action', payload: {
    tool_name: 'Read', tool_input: { file_path: '/home/user/.ssh/id_ed25519' },
  }, evaluate: async () => { throw new Error('provider should not be called'); } });
  assert.equal(result.decision, 'deny');
});

test('Jev receives only bounded, structured, non-secret state', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev privacy '));
  try {
  let transmitted;
  const payload = {
    session_id: 'privacy-session', cwd: '/project',
    tool_name: 'Bash',
    tool_input: { command: 'curl https://example.com --header "Authorization: Bearer secret-value"' },
    context: { source: 'private file body' },
  };
  const result = await runAdapter({ host: 'claude-code', event: 'before-action', payload,
    env: { HOME: home, XDG_STATE_HOME: path.join(home, 'state') },
    evaluate: async (_rule, state) => { transmitted = state; return { decision: 'confirm', reason: 'Network access needs review.' }; },
  });
  assert.equal(result.decision, 'advise');
  assert.doesNotMatch(JSON.stringify(transmitted), /secret-value|private file body|Authorization|raw_summary/);
  assert.equal(transmitted.action.tool, 'Bash');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('network risk advisory never asks for Jev-specific confirmation', async () => {
  const result = await runAdapter({ host: 'claude-code', event: 'before-action', payload: {
    tool_name: 'Bash', tool_input: { command: 'sleep 45 && curl -s https://example.com/api/json' },
  }, evaluate: async () => ({ decision: 'warn', reason: 'Native permissions apply.' }) });
  assert.equal(result.decision, 'advise');
});

test('no active Skill does not claim stop compliance or call Jev', async () => {
  let calls = 0;
  const result = await runAdapter({ host: 'claude-code', event: 'stop', payload: {},
    evaluate: async () => { calls += 1; },
  });
  assert.equal(result.decision, 'allow');
  assert.equal(calls, 0);
});

test('Skill without structured steps gets a review hint without a provider claim', async () => {
  const result = await runAdapter({ host: 'codex', event: 'stop', payload: {
    session_id: 'no-steps', activeSkill: { name: 'unstructured', steps: [], constraints: ['MUST check output'] },
  }, evaluate: async () => { throw new Error('No verifiable steps'); } });
  assert.equal(result.decision, 'advise');
  assert.match(result.nextStep, /Review the Skill instructions/);
});

test('provider outage does not turn ordinary actions into a blanket denial', async () => {
  const result = await runAdapter({ host: 'claude-code', event: 'before-action', payload: {
    tool_name: 'Bash', tool_input: { command: 'curl https://example.com' },
  }, evaluate: async () => { throw new Error('offline'); } });
  assert.equal(result.decision, 'advise');
});

test('ordinary ambiguous tools do not create a provider round trip', async () => {
  let calls = 0;
  const result = await runAdapter({ host: 'codex', event: 'before-action', payload: {
    tool_name: 'shell_command', tool_input: { command: 'echo hello' },
  }, evaluate: async () => { calls += 1; } });
  assert.equal(result.decision, 'advise');
  assert.equal(calls, 0);
});

test('network and stop checks continue after six Jev calls in a session', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev unlimited '));
  try {
    const env = { HOME: home, XDG_STATE_HOME: path.join(home, 'state') };
    let calls = 0;
    const payload = { session_id: 'unlimited-session', cwd: '/project', tool_name: 'Bash', tool_input: { command: 'curl https://example.com' } };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await runAdapter({ host: 'claude-code', event: 'before-action', payload, env,
        evaluate: async () => { calls += 1; return { decision: 'allow', reason: 'bounded' }; },
      });
    }
    const stop = await runAdapter({ host: 'claude-code', event: 'stop', payload: {
      session_id: payload.session_id, cwd: payload.cwd, activeSkill: { name: 'debug', steps: ['Verify behavior'] },
    }, env, evaluate: async () => { calls += 1; return { decision: 'finish', reason: 'Checked' }; } });
    assert.equal(stop.decision, 'allow');
    assert.equal(calls, 9);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('prompt routing recommends a Skill without exposing raw task content', async () => {
  const result = await runAdapter({ host: 'claude-code', event: 'prompt', payload: {
    prompt: 'Diagnose failed test password=super-secret', cwd: '/project', session_id: 'session',
  }, catalog: [{ name: 'systematic-debugging', description: 'Diagnose failed tests.' }],
  });
  assert.equal(result.decision, 'advise');
  assert.match(result.nextStep, /systematic-debugging/);
  assert.doesNotMatch(JSON.stringify(result), /super-secret/);
});

test('a named missing Skill step blocks once and is checked again after new evidence', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev skill runtime '));
  try {
    const env = { HOME: home, XDG_STATE_HOME: path.join(home, 'state') };
    const project = path.join(home, 'project');
    const directory = path.join(project, '.claude', 'skills', 'debug');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'SKILL.md'), [
      '---', 'name: debug', 'description: Debug failures.', '---',
      '## Steps', '1. Reproduce the issue', '2. Run validation',
    ].join('\n'));
    const session = { cwd: project, session_id: 'session' };
    await runAdapter({ host: 'claude-code', event: 'after-action', payload: {
      ...session, tool_name: 'Skill', tool_input: { skill: 'debug' }, tool_response: {},
    }, env });
    await runAdapter({ host: 'claude-code', event: 'after-action', payload: {
      ...session, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { is_error: true },
    }, env });
    let calls = 0;
    const evaluate = async (rule, state) => {
      calls += 1;
      assert.equal(rule, 'skill-compliance');
      assert.deepEqual(state.skill.steps, ['Reproduce the issue', 'Run validation']);
      assert.equal(state.evidence[0].success, false);
      assert.doesNotMatch(JSON.stringify(state), /npm test/);
      return { decision: 'redirect', reason: 'Missing validation evidence.',
        nextStep: 'Complete Skill step: Run validation.' };
    };
    const first = await runAdapter({ host: 'claude-code', event: 'stop', payload: session, env, evaluate });
    const second = await runAdapter({ host: 'claude-code', event: 'stop', payload: session, env, evaluate });
    await runAdapter({ host: 'claude-code', event: 'after-action', payload: {
      ...session, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: {},
    }, env });
    const third = await runAdapter({ host: 'claude-code', event: 'stop', payload: session, env, evaluate });
    assert.equal(first.decision, 'deny');
    assert.match(first.nextStep, /Run validation/);
    assert.equal(second.decision, 'allow');
    assert.equal(third.decision, 'deny');
    assert.equal(calls, 2);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('stop refreshes an older Skill contract with newly recognized Playbook steps', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev refresh skill '));
  try {
    const env = { HOME: home, XDG_STATE_HOME: path.join(home, 'state') };
    const project = path.join(home, 'project');
    const skill = path.join(project, '.agents', 'skills', 'build');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: build\ndescription: Build.\n---\n## Playbook\n1. Run validation\n');
    const key = { host: 'codex', sessionId: 'old-session', projectRoot: project };
    recordSkill(key, { name: 'build', steps: [], constraints: [] }, env);
    recordAction(key, { tool: 'Bash', success: false }, env);
    const result = await runAdapter({ host: 'codex', event: 'stop', payload: {
      cwd: project, session_id: key.sessionId,
    }, env, evaluate: async (_rule, state) => {
      assert.deepEqual(state.skill.steps, ['Run validation']);
      return { decision: 'redirect', reason: 'Missing validation.', nextStep: 'Complete Skill step: Run validation.' };
    } });
    assert.equal(result.decision, 'deny');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('three repeated failures trigger one Jev trajectory recommendation', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev trajectory '));
  try {
    const env = { HOME: home, XDG_STATE_HOME: path.join(home, 'state') };
    let calls = 0;
    const payload = { cwd: '/project', session_id: 'trajectory', tool_name: 'Bash',
      tool_input: { command: 'npm test password=super-secret' }, tool_response: { is_error: true } };
    let result;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      result = await runAdapter({ host: 'claude-code', event: 'after-action', payload, env,
        evaluate: async (rule, state) => {
          calls += 1;
          assert.equal(rule, 'trajectory-state');
          assert.doesNotMatch(JSON.stringify(state), /super-secret|npm test/);
          return { decision: 'redirect', reason: 'Change approach.', action: 'inspect_failure' };
        },
      });
      if (attempt === 2) assert.equal(result.nextStep, 'inspect_failure');
    }
    assert.equal(calls, 1);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('compaction resumes with bounded active Skill and evidence summary', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev resume '));
  try {
    const env = { HOME: home, XDG_STATE_HOME: path.join(home, 'state') };
    const key = { host: 'codex', sessionId: 'resume-session', projectRoot: '/project' };
    const { recordSkill, recordAction } = await import('../scripts/skill-ledger.mjs');
    recordSkill(key, { name: 'debug', steps: ['Reproduce issue', 'Run tests'], constraints: [] }, env);
    recordAction(key, { tool: 'Bash', success: false, command: 'password=super-secret' }, env);
    const response = await runAdapter({ host: 'codex', event: 'resume-context', payload: {
      session_id: 'resume-session', cwd: '/project',
    }, env });
    assert.match(response.nextStep, /Active Skill: debug/);
    assert.match(response.nextStep, /Run tests/);
    assert.doesNotMatch(JSON.stringify(response), /super-secret/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
