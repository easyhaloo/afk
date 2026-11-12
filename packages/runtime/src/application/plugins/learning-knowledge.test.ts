import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CandidateStore } from '../learning/candidate-store.js';
import { buildEvidencePack } from '../learning/evidence.js';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import type { VerificationProvider } from '../../plugin-sdk/capabilities.js';
import { knowledgeFixture } from '../learning/knowledge.fixture.spec.js';
import { createLearningPlugin, learningPluginManifest } from './learning.js';
import { validatePluginConfig } from './configuration.js';
import { PluginRuntime } from './runtime.js';
import { prepareExperienceContext } from '../learning/runtime.js';

const fixtures: ReturnType<typeof knowledgeFixture>[] = [];
const runtimes: PluginRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

async function setup(enabled = true, script?: (fixture: ReturnType<typeof knowledgeFixture>) => string) {
  const fixture = knowledgeFixture();
  fixtures.push(fixture);
  const homeDir = join(fixture.root, 'home');
  const file = join(homeDir, '.afk', 'learning', 'candidates.sqlite');
  const store = new CandidateStore({ file });
  try {
    const source = fixture.store.getRequest(fixture.candidate.requestKey)!;
    const request = store.submitRequest({ request: source.request, evidence: source.evidence });
    const processed = store.completeRequest(request.key, { version: 1, candidates: [fixture.candidate.proposal], warnings: [] });
    const candidate = store.getCandidate(processed.candidateIds[0]!)!;
    store.recordValidation(candidate.id, candidate.version, { candidateDigest: candidate.digest, evidenceDigest: candidate.evidenceDigest,
      validatorVersion: 'knowledge-v1', passed: true, results: ['independent fixture validation'] });
  } finally { store.close(); }
  const runtime = new PluginRuntime();
  runtimes.push(runtime);
  await runtime.activate(createLearningPlugin({ homeDir, config: { enabled, dailyCalls: 0,
    knowledge: { wikiScript: script?.(fixture) ?? fixture.wikiScript, grants: [fixture.authorizationFile] } } }));
  return { ...fixture, homeDir, file, runtime };
}

describe('learning knowledge plugin integration', () => {
  it('validates an imported fact with a registered checker, publishes it and withdraws it after invalidation', async () => {
    const fixture = knowledgeFixture();
    fixtures.push(fixture);
    const homeDir = join(fixture.root, 'home');
    const file = join(homeDir, '.afk', 'learning', 'candidates.sqlite');
    const eventRoot = join(fixture.root, 'events');
    const events = new JsonlEventStore({ root: eventRoot });
    await events.append([{ id: 'observed-approval', schemaVersion: 1, type: 'agent.session_recorded',
      occurredAt: '2026-11-11T00:00:00Z', correlationId: 'approval-source',
      context: { runId: 'approval-source', traceId: 'approval-trace', workItemId: `${fixture.policy.scope}#42`,
        profileId: 'default', attempt: 1, actor: { kind: 'system', id: 'fixture' } },
      data: { kind: 'agent.session_recorded', sessionId: 'approval-session' } }]);
    const audit = { id: 'audit-1', kind: 'audit' as const, path: events.pathFor('approval-source'),
      allowedRoot: eventRoot, runId: 'approval-source' };
    const pack = await buildEvidencePack({ sources: [audit] });
    const store = new CandidateStore({ file });
    const source = store.submitRequest({ request: { version: 1, scope: fixture.policy.scope, sourceId: 'run:approval-source',
      sourceRunId: 'approval-source', evidenceDigest: pack.digest, analyzerVersion: '1', reason: 'import' },
      evidence: pack.entries.map(entry => entry.ref) }, pack);
    const receipt = store.completeRequest(source.key, { version: 1, warnings: [],
      candidates: [{ ...fixture.candidate.proposal, evidenceIds: pack.entries.map(entry => entry.ref.id) }] });
    const candidate = store.getCandidate(receipt.candidateIds[0]!)!;
    store.close();
    const identity = { scope: fixture.policy.scope, checkerId: 'approval-rules', providerId: 'approval-oracle', version: '1' };
    const targetRoot = join(fixture.root, 'business');
    mkdirSync(targetRoot);
    const targetFile = join(targetRoot, 'approval.json');
    writeFileSync(targetFile, JSON.stringify({ subject: 'approval', rule: 'Approve before publishing',
      authority: pack.entries.map(entry => entry.ref.locator) }));
    const configurationFile = join(fixture.root, 'checkers.json');
    writeFileSync(configurationFile, JSON.stringify({ version: 1, checkers: [{ ...identity,
      authorizationFile: fixture.authorizationFile, target: { ref: 'wiki:approval', root: targetRoot, path: 'approval.json' },
      evidence: [{ digest: pack.digest, sources: [audit] }] }] }), { mode: 0o600 });
    const provider: VerificationProvider = { id: identity.providerId,
      capabilities: { 'test-execution': true, 'static-analysis': false, 'custom-script': false },
      doctor: async () => [{ check: 'learning-validation-v1', ok: true, detail: JSON.stringify(identity) }],
      verify: async request => {
        const observed = JSON.parse(readFileSync(targetFile, 'utf8')) as { subject: string; rule: string; authority: string[] };
        const values = new Map<string, string | string[]>([['fact.subject', observed.subject],
          ['fact.rule', observed.rule], ['fact.authority', observed.authority]]);
        const envelope = JSON.parse(request.target) as { binding: unknown; assertions: { node: string; evidence: unknown }[] };
        return { passed: true, durationMs: 1, output: JSON.stringify({ protocol: 'learning-validation-v1', binding: envelope.binding,
          assertions: envelope.assertions.map(assertion => ({ ...assertion, actual: values.get(assertion.node), status: 'observed' })) }) };
      } };
    const runtime = new PluginRuntime();
    runtimes.push(runtime);
    await runtime.activate({ manifest: { id: 'verification.approval-rules', version: '1.0.0', apiVersion: 1,
      trusted: true, provides: ['verification.provider'] }, activate: context => context.registerVerificationProvider(identity.providerId, provider) });
    await runtime.activate(createLearningPlugin({ homeDir, config: { enabled: true, dailyCalls: 0,
      validation: { configurationFile }, knowledge: { wikiScript: fixture.wikiScript, grants: [fixture.authorizationFile] } } }));
    const validated = await runtime.dispatchSystemAction('learning.validate', { scope: fixture.policy.scope,
      candidateId: candidate.id, expectedVersion: 1, checkerId: identity.checkerId });
    expect(validated).toMatchObject({ status: 'validated', candidateId: candidate.id, validatedVersion: 2 });
    const prepared = await runtime.dispatchSystemAction('learning.knowledge.prepare', { scope: fixture.policy.scope,
      candidateId: candidate.id, expectedVersion: 2 }) as { key: string };
    await runtime.dispatchSystemAction('learning.knowledge.publish', { scope: fixture.policy.scope, key: prepared.key });
    const query = { scope: fixture.policy.scope, prompt: 'approval', applicability: { version: 'abc' } };
    const context = runtime.getContextProvider('context.knowledge')!;
    expect(await context.gather(query)).toEqual([expect.objectContaining({ content: expect.stringContaining('Approve before publishing') })]);
    const restarted = new CandidateStore({ file });
    try {
      expect(restarted.getValidation(candidate.id)?.passed).toBe(true);
      restarted.invalidateRequestSource(source.key);
    } finally { restarted.close(); }
    await runtime.dispatchSystemAction('learning.knowledge.reconcile', { scope: fixture.policy.scope });
    expect(await context.gather(query)).toEqual([]);
    expect(readFileSync(join(fixture.vault, '知识/Approval.md'), 'utf8')).toContain('knowledge_status: revoked');
  });

  it('injects published knowledge into two real task worktrees and removes stale context after invalidation', async () => {
    const fixture = await setup();
    const prepared = await fixture.runtime.dispatchSystemAction('learning.knowledge.prepare', { scope: fixture.policy.scope,
      candidateId: fixture.candidate.id, expectedVersion: fixture.candidate.version }) as { key: string };
    await fixture.runtime.dispatchSystemAction('learning.knowledge.publish', { scope: fixture.policy.scope, key: prepared.key });
    const repository = join(fixture.root, 'repository');
    mkdirSync(repository);
    const git = simpleGit(repository);
    await git.init();
    await git.addConfig('user.name', 'Learning Test');
    await git.addConfig('user.email', 'learning@example.test');
    writeFileSync(join(repository, 'README.md'), '# Approval workflow\n');
    await git.add('README.md');
    await git.commit('Initialize task fixture');
    const tasks = [join(fixture.root, 'task-one'), join(fixture.root, 'task-two')];
    for (const path of tasks) await git.raw(['worktree', 'add', '--detach', path, 'HEAD']);
    const gather = (worktreePath: string, task: number) => prepareExperienceContext({
      workItemId: `${fixture.policy.scope}#${task}`, worktreePath, prompt: 'Approval workflow',
      plugins: fixture.runtime, applicability: { version: 'abc' },
    });
    for (const [index, path] of tasks.entries()) {
      const context = await gather(path, index + 1);
      expect(context).toBeDefined();
      expect(readFileSync(join(path, context!), 'utf8')).toContain('Approve before publishing');
      expect(readFileSync(join(path, context!), 'utf8')).toContain(`knowledge:${prepared.key}`);
    }
    const store = new CandidateStore({ file: fixture.file });
    try { store.invalidateRequestSource(fixture.candidate.requestKey); } finally { store.close(); }
    for (const [index, path] of tasks.entries()) {
      expect(await gather(path, index + 1)).toBeUndefined();
      expect(existsSync(join(path, '.afk', 'experience-context.md'))).toBe(false);
    }
    await fixture.runtime.dispatchSystemAction('learning.knowledge.reconcile', { scope: fixture.policy.scope });
    expect(readFileSync(join(fixture.vault, '知识/Approval.md'), 'utf8')).toContain('knowledge_status: revoked');
  });

  it('propagates reconciliation cancellation without recording a configuration failure', async () => {
    const fixture = await setup();
    await fixture.runtime.dispatchSystemAction('learning.knowledge.prepare', { scope: fixture.policy.scope,
      candidateId: fixture.candidate.id, expectedVersion: fixture.candidate.version });
    await fixture.runtime.close();
    const marker = join(fixture.root, 'reconcile.pid');
    const script = join(fixture.root, 'reconcile-waiting.py');
    writeFileSync(script, `import os, time\nwith open(${JSON.stringify(marker)}, 'w') as marker:\n    marker.write(str(os.getpid()))\ntime.sleep(60)\n`);
    const runtime = new PluginRuntime();
    runtimes.push(runtime);
    const plugin = createLearningPlugin({ homeDir: fixture.homeDir, config: { enabled: true,
      knowledge: { wikiScript: script, grants: [fixture.authorizationFile] } } });
    await runtime.activate(plugin);
    const running = runtime.dispatchSystemAction('learning.knowledge.reconcile', { scope: fixture.policy.scope });
    const rejected = expect(running).rejects.toThrow('learning_plugin_closed');
    await vi.waitFor(() => expect(readFileSync(marker, 'utf8')).toMatch(/^\d+$/));
    const pid = Number(readFileSync(marker, 'utf8'));
    await runtime.close();
    await rejected;
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
    expect(await plugin.diagnostics?.()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'knowledge_publication_degraded' }),
    ]));
  });

  it('advertises knowledge context only when saved knowledge configuration is present', async () => {
    expect(createLearningPlugin().manifest.provides).not.toContain('context.provider');
    const fixture = await setup(false);
    expect(createLearningPlugin({ config: { knowledge: { wikiScript: fixture.wikiScript,
      grants: [fixture.authorizationFile] } } }).manifest.provides).toContain('context.provider');
  });

  it('cancels in-flight Wiki work on disposal and keeps old provider references closed', async () => {
    const fixture = await setup(true, context => {
      const script = join(context.root, 'waiting.py');
      writeFileSync(script, `import os, time\nwith open(${JSON.stringify(join(context.root, 'python.pid'))}, 'w') as marker:\n    marker.write(str(os.getpid()))\ntime.sleep(60)\n`);
      return script;
    });
    const provider = fixture.runtime.getContextProvider('context.knowledge')!;
    const running = fixture.runtime.dispatchSystemAction('learning.knowledge.prepare', { scope: fixture.policy.scope,
      candidateId: fixture.candidate.id, expectedVersion: fixture.candidate.version });
    const rejected = expect(running).rejects.toThrow();
    await vi.waitFor(() => expect(readFileSync(join(fixture.root, 'python.pid'), 'utf8')).toMatch(/^\d+$/));
    const pid = Number(readFileSync(join(fixture.root, 'python.pid'), 'utf8'));
    await fixture.runtime.close();
    await rejected;
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
    await expect(provider.gather({ scope: fixture.policy.scope, prompt: 'Approval' }, { signal: new AbortController().signal }))
      .rejects.toThrow('learning_plugin_closed');
    const store = new CandidateStore({ file: fixture.file });
    try { expect(store.listPublications()).toEqual([]); } finally { store.close(); }
  });

  it('declares the same grant-array bounds in manifest validation', () => {
    const validate = (grants: string[]) => validatePluginConfig(learningPluginManifest.configSchema,
      { knowledge: { wikiScript: '/private/wiki.py', grants } });
    expect(() => validate([])).toThrow();
    expect(() => validate(['/private/grant.json', '/private/grant.json'])).toThrow();
    expect(() => validate(Array.from({ length: 65 }, (_, index) => `/private/grant-${index}.json`))).toThrow();
    expect(() => validate(['/private/grant.json'])).not.toThrow();
  });

  it('uses saved authorization for preview, publication and actual withdrawal during source reconciliation', async () => {
    const fixture = await setup();
    const scope = fixture.policy.scope;
    const prepared = await fixture.runtime.dispatchSystemAction('learning.knowledge.prepare', {
      scope, candidateId: fixture.candidate.id, expectedVersion: fixture.candidate.version,
    }) as { key: string };
    expect(() => readFileSync(join(fixture.vault, '知识/Approval.md'))).toThrow();
    expect(await fixture.runtime.dispatchSystemAction('learning.knowledge.publish', { scope, key: prepared.key }))
      .toMatchObject({ publication: { phase: 'committed' } });
    expect(fixture.runtime.getContextProvider('context.knowledge')).toBeDefined();
    const store = new CandidateStore({ file: fixture.file });
    try { store.invalidateRequestSource(fixture.candidate.requestKey); } finally { store.close(); }
    await fixture.runtime.dispatchSystemAction('learning.reconcile', { scope });
    expect(readFileSync(join(fixture.vault, '知识/Approval.md'), 'utf8')).toContain('knowledge_status: revoked');
    expect(await fixture.runtime.getContextProvider('context.knowledge')!.gather({ scope, prompt: 'Approval' })).toEqual([]);
  });

  it('rejects action path overrides, cross-project access and disabled publication', async () => {
    const fixture = await setup();
    const input = { scope: fixture.policy.scope, candidateId: fixture.candidate.id, expectedVersion: fixture.candidate.version };
    await expect(fixture.runtime.dispatchSystemAction('learning.knowledge.prepare', { ...input, authorizationFile: '/other/grant.json' })).rejects.toThrow();
    await expect(fixture.runtime.dispatchSystemAction('learning.knowledge.prepare', { ...input, vault: '/other' })).rejects.toThrow();
    await expect(fixture.runtime.dispatchSystemAction('learning.knowledge.prepare', { ...input, scope: 'github:other/api' })).rejects.toThrow(/scope/);
    const disabled = await setup(false);
    await expect(disabled.runtime.dispatchSystemAction('learning.knowledge.prepare', input)).rejects.toThrow('learning_disabled');
  });

  it('exposes configuration degradation without making audit reconciliation fail and clears it after repair', async () => {
    const fixture = await setup();
    chmodSync(fixture.authorizationFile, 0o644);
    await expect(fixture.runtime.dispatchSystemAction('learning.reconcile', { scope: fixture.policy.scope })).resolves.toBeDefined();
    expect(await fixture.runtime.diagnostics('learning.distiller')).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'knowledge_publication_degraded' }),
    ]));
    chmodSync(fixture.authorizationFile, 0o600);
    await fixture.runtime.dispatchSystemAction('learning.reconcile', { scope: fixture.policy.scope });
    expect(await fixture.runtime.diagnostics('learning.distiller')).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'knowledge_publication_degraded' }),
    ]));
  });
});
