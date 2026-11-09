import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { toCodexResponse } from '../scripts/adapters/codex.mjs';
import { JevAgentGuard } from '../scripts/adapters/opencode.mjs';
import { jevAgentGuardV2 } from '../scripts/adapters/opencode-v2.mjs';
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
    const skill = path.join(home, '.opencode', 'skills', 'debug');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: debug\ndescription: Debug failures.\n---\n## Steps\n1. Reproduce failure\n');
    const plugin = await JevAgentGuard({ directory: home, env });
    await plugin['tool.execute.after']({ tool: 'skill', sessionID: 'session' }, {
      args: { name: 'debug' }, output: 'loaded', metadata: {},
    });
    const ledger = loadLedger({ host: 'opencode', sessionId: 'session', projectRoot: home }, env);
    assert.equal(ledger.skill.name, 'debug');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// --- OpenCode V2 plugin (opencode-v2.mjs) ---

const RUNTIME_STUB = `export const calls = [];
export const behavior = {};
export async function runAdapter(input) {
  calls.push(input);
  const decision = behavior[input.event];
  if (decision instanceof Error) throw decision;
  return decision ?? { decision: 'allow', reason: 'ok' };
}`;

function makeScriptsRoot({ withRuntime = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev v2 scripts '));
  if (withRuntime) {
    fs.mkdirSync(path.join(root, 'adapters'), { recursive: true });
    fs.writeFileSync(path.join(root, 'adapters', 'runtime-adapter.mjs'), RUNTIME_STUB);
    fs.writeFileSync(path.join(root, 'context-filter.mjs'),
      `export function compactToolOutput({ output }) { return \`compact:\${output}\`; }\n`);
  }
  return root;
}

async function loadRuntimeStub(root) {
  return import(`${pathToFileURL(path.join(root, 'adapters', 'runtime-adapter.mjs')).href}`);
}

function fakeCtx(directory) {
  const registered = {};
  return {
    location: { directory },
    session: { hook: async (name, fn) => { registered[`session:${name}`] = fn; } },
    tool: { hook: async (name, fn) => { registered[`tool:${name}`] = fn; } },
    registered,
  };
}

test('OpenCode V2 setup registers the four domain hooks', async () => {
  const root = makeScriptsRoot();
  const ctx = fakeCtx('/project');
  await jevAgentGuardV2({ scriptsRoot: root, env: {} }).setup(ctx);
  assert.equal(typeof ctx.registered['session:prompt'], 'function');
  assert.equal(typeof ctx.registered['session:context'], 'function');
  assert.equal(typeof ctx.registered['tool:execute.before'], 'function');
  assert.equal(typeof ctx.registered['tool:execute.after'], 'function');
});

test('OpenCode V2 prompt stashes a recommendation that the next context injects once', async () => {
  const root = makeScriptsRoot();
  const runtime = await loadRuntimeStub(root);
  runtime.behavior.prompt = { decision: 'advise', reason: 'routing', nextStep: 'Suggested Skill: debug' };
  const ctx = fakeCtx('/project');
  await jevAgentGuardV2({ scriptsRoot: root, env: {} }).setup(ctx);
  await ctx.registered['session:prompt']({ sessionID: 's1', prompt: { text: 'diagnose the failing test' } });
  const system = [];
  await ctx.registered['session:context']({ sessionID: 's1', system });
  assert.deepEqual(system, [{ type: 'text', text: 'Suggested Skill: debug' }]);
  const second = [];
  await ctx.registered['session:context']({ sessionID: 's1', system: second });
  assert.deepEqual(second, []);
});

test('OpenCode V2 before-action throws only on a deny decision', async () => {
  const root = makeScriptsRoot();
  const runtime = await loadRuntimeStub(root);
  runtime.behavior['before-action'] = { decision: 'deny', reason: 'Destructive action' };
  const ctx = fakeCtx('/project');
  await jevAgentGuardV2({ scriptsRoot: root, env: {} }).setup(ctx);
  await assert.rejects(() => ctx.registered['tool:execute.before']({
    tool: 'bash', sessionID: 's1', input: { command: 'git reset --hard HEAD' },
  }), /Destructive action/);
});

test('OpenCode V2 swallows non-deny adapter errors so legit tool calls proceed', async () => {
  const root = makeScriptsRoot();
  const runtime = await loadRuntimeStub(root);
  runtime.behavior['before-action'] = new Error('adapter offline');
  const ctx = fakeCtx('/project');
  await jevAgentGuardV2({ scriptsRoot: root, env: {} }).setup(ctx);
  await ctx.registered['tool:execute.before']({ tool: 'read', sessionID: 's1', input: {} });
  const call = runtime.calls.at(-1);
  assert.equal(call.payload.tool_name, 'read');
  assert.equal(call.payload.cwd, '/project');
});

test('OpenCode V2 after-action records outcome and compacts successful output', async () => {
  const root = makeScriptsRoot();
  const runtime = await loadRuntimeStub(root);
  const ctx = fakeCtx('/project');
  await jevAgentGuardV2({ scriptsRoot: root, env: {} }).setup(ctx);
  const event = { tool: 'bash', sessionID: 's1', status: 'success', input: { command: 'npm ci' },
    result: { content: 'a'.repeat(3000) } };
  await ctx.registered['tool:execute.after'](event);
  assert.match(event.result.content, /^compact:aaaa/);
  const call = runtime.calls.at(-1);
  assert.equal(call.event, 'after-action');
  assert.deepEqual(call.payload.outcome, { success: true });
});

test('OpenCode V2 skips hook registration when the adapter cannot load', async () => {
  const root = makeScriptsRoot({ withRuntime: false });
  const ctx = fakeCtx('/project');
  await jevAgentGuardV2({ scriptsRoot: root, env: {} }).setup(ctx);
  assert.deepEqual(Object.keys(ctx.registered), []);
});
