import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeContextProvider, knowledgeConfigurationSchema, prepareConfiguredKnowledge, publishConfiguredKnowledge,
  reconcileConfiguredKnowledge } from './knowledge-runtime.js';
import { knowledgeFixture } from './knowledge.fixture.spec.js';
import { runWikiIngest } from './knowledge.js';
import { candidateProposalSchema } from './contracts.js';
import { output } from './ledger-data.fixture.spec.js';

const fixtures: ReturnType<typeof knowledgeFixture>[] = [];
const open = () => { const fixture = knowledgeFixture(); fixtures.push(fixture); return fixture; };
const options = (fixture: ReturnType<typeof open>) => ({ file: join(fixture.root, 'ledger.sqlite'), recoveryDirectory: fixture.recoveryDirectory,
  config: { wikiScript: fixture.wikiScript, grants: [fixture.authorizationFile] } });
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.cleanup(); });

describe('configured knowledge application use cases', () => {
  it.each(['applicability', 'target'] as const)('does not promote inherited %s through the knowledge provider', async field => {
    const fixture = knowledgeFixture(candidateProposalSchema.parse({ ...output.candidates[0], targetRef: 'wiki:approval',
      applicability: { ...output.candidates[0]!.applicability, preconditions: ['approvalCondition'] } }));
    fixtures.push(fixture);
    const input = options(fixture);
    const publication = await prepareConfiguredKnowledge({ ...input, scope: fixture.policy.scope,
      candidateId: fixture.candidate.id, expectedVersion: fixture.candidate.version });
    await publishConfiguredKnowledge({ ...input, scope: fixture.policy.scope, key: publication.key });
    const context = { applicability: { version: 'abc' },
      target: { project: fixture.policy.scope, conditions: { approvalCondition: true } } };
    const query = { scope: fixture.policy.scope, prompt: 'Approval', ...context };
    const provider = new KnowledgeContextProvider(input);
    expect(await provider.gather(query)).toHaveLength(1);
    const inherited = Object.assign(Object.create({ [field]: context[field] }), query);
    delete inherited[field];
    expect(await provider.gather(inherited)).toEqual([]);
  });

  it.each(['preconditions', 'exclusions', 'invalidationConditions'] as const)(
    'checks known trusted %s before returning published content', async field => {
      const fixture = knowledgeFixture(candidateProposalSchema.parse({ ...output.candidates[0], targetRef: 'wiki:approval',
        applicability: { ...output.candidates[0]!.applicability, [field]: ['approvalCondition'] } }));
      fixtures.push(fixture);
      const input = options(fixture);
      const publication = await prepareConfiguredKnowledge({ ...input, scope: fixture.policy.scope,
        candidateId: fixture.candidate.id, expectedVersion: fixture.candidate.version });
      await publishConfiguredKnowledge({ ...input, scope: fixture.policy.scope, key: publication.key });
      const provider = new KnowledgeContextProvider(input);
      const query = { scope: fixture.policy.scope, prompt: 'approvalCondition=true', applicability: { version: 'abc' } };
      expect(await provider.gather(query)).toEqual([]);
      const allowed = field === 'preconditions';
      expect(await provider.gather({ ...query, target: { project: query.scope, conditions: { approvalCondition: !allowed } } })).toEqual([]);
      expect(await provider.gather({ ...query, target: { project: query.scope, conditions: Object.create({ approvalCondition: allowed }) } })).toEqual([]);
      expect(await provider.gather({ ...query, target: { project: query.scope, conditions: { approvalCondition: allowed } } }))
        .toMatchObject([{ content: expect.stringContaining('Approve before publishing') }]);
    });

  it('cancels its actual Wiki process without publishing or changing prepared receipts', async () => {
    const fixture = open();
    const controller = new AbortController();
    const marker = join(fixture.root, 'python.pid');
    const script = join(fixture.root, 'waiting.py');
    writeFileSync(script, `import os, time\nwith open(${JSON.stringify(marker)}, 'w') as marker:\n    marker.write(str(os.getpid()))\ntime.sleep(60)\n`);
    const running = runWikiIngest(script, fixture.vault, { version: 1, summary: 'cancel', evidence: ['test'], changes: [] }, false, undefined, controller.signal);
    const rejected = expect(running).rejects.toThrow();
    await vi.waitFor(() => expect(readFileSync(marker, 'utf8')).toMatch(/^\d+$/));
    const pid = Number(readFileSync(marker, 'utf8'));
    controller.abort(new Error('fixture cancellation'));
    await rejected;
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
    const aborted = new AbortController();
    aborted.abort(new Error('already cancelled'));
    await expect(prepareConfiguredKnowledge({ ...options(fixture), signal: aborted.signal, scope: fixture.policy.scope,
      candidateId: fixture.candidate.id, expectedVersion: fixture.candidate.version })).rejects.toThrow('already cancelled');
    expect(fixture.store.listPublications()).toEqual([]);
  });

  it('requires canonical saved paths and rejects duplicate or model-supplied configuration', () => {
    expect(() => knowledgeConfigurationSchema.parse({ wikiScript: '../wiki.py', grants: ['/private/grant.json'] })).toThrow();
    expect(() => knowledgeConfigurationSchema.parse({ wikiScript: '/private/wiki.py', grants: ['/private/grant.json', '/private/grant.json'] })).toThrow();
    expect(() => knowledgeConfigurationSchema.parse({ wikiScript: '/private/wiki.py', grants: ['/private/grant.json'], vault: '/other' })).toThrow();
  });

  it('publishes through a saved grant and reconciles actual committed content after source invalidation', async () => {
    const fixture = open();
    const input = options(fixture);
    const publication = await prepareConfiguredKnowledge({ ...input, scope: fixture.policy.scope,
      candidateId: fixture.candidate.id, expectedVersion: fixture.candidate.version });
    expect((await publishConfiguredKnowledge({ ...input, scope: fixture.policy.scope, key: publication.key })).publication.phase).toBe('committed');
    expect(readFileSync(join(fixture.vault, '知识/Approval.md'), 'utf8')).toContain('Approve before publishing');
    fixture.store.invalidateRequestSource(fixture.candidate.requestKey);
    expect(await reconcileConfiguredKnowledge(input)).toMatchObject({ blocked: [], results: [
      { publication: { key: publication.key }, withdrawal: { status: 'withdrawn' } },
    ] });
    expect(readFileSync(join(fixture.vault, '知识/Approval.md'), 'utf8')).toContain('knowledge_status: revoked');
  });

  it('rejects cross-project and caller-supplied vault or grant overrides', async () => {
    const fixture = open();
    const input = options(fixture);
    await expect(prepareConfiguredKnowledge({ ...input, scope: 'github:other/api', candidateId: fixture.candidate.id,
      expectedVersion: fixture.candidate.version })).rejects.toThrow(/scope|candidate/i);
    await expect(prepareConfiguredKnowledge({ ...input, scope: fixture.policy.scope, candidateId: fixture.candidate.id,
      expectedVersion: fixture.candidate.version, targetRef: 'wiki:unapproved' })).rejects.toThrow(/target/i);
    expect(fixture.store.listPublications()).toEqual([]);
  });

  it('blocks ambiguous target routes and reloads a grant revoked after preview', async () => {
    const fixture = open();
    const input = options(fixture);
    const duplicate = join(fixture.root, 'duplicate.json');
    writeFileSync(duplicate, readFileSync(fixture.authorizationFile), { mode: 0o600 });
    await expect(prepareConfiguredKnowledge({ ...input, config: { ...input.config, grants: [fixture.authorizationFile, duplicate] },
      scope: fixture.policy.scope, candidateId: fixture.candidate.id, expectedVersion: fixture.candidate.version })).rejects.toThrow(/target|ambiguous/i);
    const publication = await prepareConfiguredKnowledge({ ...input, scope: fixture.policy.scope,
      candidateId: fixture.candidate.id, expectedVersion: fixture.candidate.version });
    fixture.persistGrant(true, false);
    expect(await publishConfiguredKnowledge({ ...input, scope: fixture.policy.scope, key: publication.key }))
      .toMatchObject({ publication: { phase: 'conflict' }, withdrawal: { status: 'rollback_blocked' } });
    expect(() => readFileSync(join(fixture.vault, '知识/Approval.md'))).toThrow();
  });

  it('reports unavailable grants while recovering unrelated valid bindings', async () => {
    const fixture = open();
    const input = options(fixture);
    const publication = await prepareConfiguredKnowledge({ ...input, scope: fixture.policy.scope,
      candidateId: fixture.candidate.id, expectedVersion: fixture.candidate.version });
    const missing = join(fixture.root, 'missing.json');
    expect(await reconcileConfiguredKnowledge({ ...input, config: { ...input.config, grants: [missing, fixture.authorizationFile] } }))
      .toMatchObject({ blocked: [{ grantIndex: 0, code: 'knowledge_grant_unavailable' }], results: [{ publication: { key: publication.key, phase: 'committed' } }] });
  });

  it('reports orphaned publication routes and refused withdrawal as recovery blockers', async () => {
    const fixture = open();
    const input = options(fixture);
    const publication = await prepareConfiguredKnowledge({ ...input, scope: fixture.policy.scope,
      candidateId: fixture.candidate.id, expectedVersion: fixture.candidate.version });
    await publishConfiguredKnowledge({ ...input, scope: fixture.policy.scope, key: publication.key });
    const otherGrant = join(fixture.root, 'other.json');
    writeFileSync(otherGrant, JSON.stringify({ version: 1, revoked: false, allowWithdrawal: true,
      policy: { ...fixture.policy, targets: fixture.policy.targets.map(target => ({ ...target, ref: `${target.ref}-other` })) } }), { mode: 0o600 });
    expect(await reconcileConfiguredKnowledge({ ...input, config: { ...input.config, grants: [otherGrant] } }))
      .toMatchObject({ results: [], blocked: [{ key: publication.key, code: 'publication_recovery_blocked' }] });
    fixture.store.invalidateRequestSource(fixture.candidate.requestKey);
    fixture.persistGrant(true, false);
    expect(await reconcileConfiguredKnowledge(input)).toMatchObject({ blocked: [
      { key: publication.key, code: 'publication_recovery_blocked' },
    ], results: [{ withdrawal: { status: 'rollback_blocked' } }] });
    expect(readFileSync(join(fixture.vault, '知识/Approval.md'), 'utf8')).not.toContain('knowledge_status: revoked');
  });

  it('fails closed for missing trusted applicability, revoked sources, and non-private grants', async () => {
    const fixture = open();
    const input = options(fixture);
    const publication = await prepareConfiguredKnowledge({ ...input, scope: fixture.policy.scope,
      candidateId: fixture.candidate.id, expectedVersion: fixture.candidate.version });
    await publishConfiguredKnowledge({ ...input, scope: fixture.policy.scope, key: publication.key });
    const provider = new KnowledgeContextProvider(input);
    expect(await provider.gather({ scope: fixture.policy.scope, prompt: 'version abc Approval', limit: 5 })).toEqual([]);
    expect(await provider.gather({ scope: 'github:other/api', prompt: 'Approval' })).toEqual([]);
    expect(await provider.gather({ scope: fixture.policy.scope, prompt: 'Approval', applicability: { version: 'abc' },
      target: { project: 'github:other/api' } })).toEqual([]);
    expect(await provider.gather({ scope: fixture.policy.scope, prompt: 'Approval', applicability: { version: 'wrong' } })).toEqual([]);
    expect(await provider.gather({ scope: fixture.policy.scope, prompt: 'Approval', applicability: { version: 'abc' } }))
      .toMatchObject([{ content: expect.stringContaining('Approve before publishing') }]);
    chmodSync(fixture.authorizationFile, 0o644);
    expect(await provider.gather({ scope: fixture.policy.scope, prompt: 'Approval', applicability: { version: 'abc' } })).toEqual([]);
    chmodSync(fixture.authorizationFile, 0o600);
    fixture.store.invalidateRequestSource(fixture.candidate.requestKey);
    expect(await provider.gather({ scope: fixture.policy.scope, prompt: 'Approval', applicability: { version: 'abc' } })).toEqual([]);
  });
});
