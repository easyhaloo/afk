import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { candidateProposalSchema } from './contracts.js';
import { output } from './ledger-data.fixture.spec.js';
import { hash, knowledgeFixture, page } from './knowledge.fixture.spec.js';
import { planKnowledgePublication, readKnowledgeAuthorization, readKnowledgeGrant, runWikiIngest, verifyKnowledgePlan } from './knowledge.js';

const reads = vi.hoisted(() => ({ file: '', descriptors: new Set<number>(), sizes: [] as number[], wholeFileSizes: [] as number[],
  afterRead: undefined as (() => void) | undefined }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual,
    openSync: (...parameters: Parameters<typeof actual.openSync>) => {
      const descriptor = actual.openSync(...parameters);
      if (parameters[0] === reads.file) reads.descriptors.add(descriptor);
      return descriptor;
    },
    closeSync: (descriptor: number) => {
      const result = actual.closeSync(descriptor);
      reads.descriptors.delete(descriptor);
      return result;
    },
    readSync: (descriptor: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
      const result = actual.readSync(descriptor, buffer, offset, length, position);
      if (reads.descriptors.has(descriptor)) {
        reads.sizes.push(length);
        const afterRead = reads.afterRead;
        reads.afterRead = undefined;
        afterRead?.();
      }
      return result;
    },
    readFileSync: (...parameters: Parameters<typeof actual.readFileSync>) => {
      const result = actual.readFileSync(...parameters);
      if (parameters[0] === reads.file || (typeof parameters[0] === 'number' && reads.descriptors.has(parameters[0]))) reads.wholeFileSizes.push(Buffer.byteLength(result));
      return result;
    },
  };
});

const fixtures: ReturnType<typeof knowledgeFixture>[] = [];
const open = (proposal?: Parameters<typeof knowledgeFixture>[0]) => {
  const fixture = knowledgeFixture(proposal);
  fixtures.push(fixture);
  return fixture;
};
afterEach(() => {
  reads.file = '';
  reads.afterRead = undefined;
  reads.sizes = [];
  reads.wholeFileSizes = [];
  reads.descriptors.clear();
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

describe('knowledge plan through the existing Python wiki CLI', () => {
  it('captures authorized file and missing directory-rule dependencies without changing the grant DTO', () => {
    const fixture = open();
    const readSet = new Map<string, string | null>();
    expect(readKnowledgeAuthorization(fixture.input, false, readSet)).toEqual(readKnowledgeGrant(fixture.authorizationFile));
    expect(readSet.get('AGENTS.md')).toBe(fixture.policy.rules['AGENTS.md']);
    expect([...readSet]).toEqual(expect.arrayContaining([['.tools/wiki-lint.py', null], ['知识/AGENTS.md', null], ['99-收件箱/AGENTS.md', null]]));
  });

  it('rejects oversized rule files before reading their content and closes the descriptor', () => {
    const fixture = open();
    reads.file = join(fixture.vault, 'AGENTS.md');
    truncateSync(reads.file, 64 * 1024 * 1024 + 1);
    expect(() => readKnowledgeAuthorization(fixture.input)).toThrow();
    expect(reads.sizes).toEqual([]);
    expect(reads.wholeFileSizes).toEqual([]);
    expect(reads.descriptors.size).toBe(0);
  });

  it('accepts an authorized multi-chunk rule through bounded FD reads', () => {
    const fixture = open();
    const content = '# Authorized rules\n'.repeat(6000);
    fixture.write('AGENTS.md', content);
    fixture.policy.rules['AGENTS.md'] = hash(content);
    fixture.persistGrant();
    reads.file = join(fixture.vault, 'AGENTS.md');
    expect(readKnowledgeAuthorization(fixture.input).policy).toEqual(fixture.policy);
    expect(reads.sizes.length).toBeGreaterThan(1);
    expect(reads.sizes.every(size => size <= 65536)).toBe(true);
    expect(reads.wholeFileSizes).toEqual([]);
    expect(reads.descriptors.size).toBe(0);
  });

  it.each(['directory', 'symlink'] as const)('rejects nonregular authorization rules before content reading: %s', kind => {
    const fixture = open();
    const rule = join(fixture.vault, 'AGENTS.md');
    fixture.write('rule-copy.md', readFileSync(rule, 'utf8'));
    rmSync(rule);
    if (kind === 'directory') mkdirSync(rule);
    else symlinkSync(join(fixture.vault, 'rule-copy.md'), rule);
    reads.file = rule;
    expect(() => readKnowledgeAuthorization(fixture.input)).toThrow(/regular|links/i);
    expect(reads.sizes).toEqual([]);
    expect(reads.wholeFileSizes).toEqual([]);
    expect(reads.descriptors.size).toBe(0);
  });

  it.each(['rule', 'grant'] as const)('rejects %s growth on the same read descriptor', kind => {
    const fixture = open();
    reads.file = kind === 'rule' ? join(fixture.vault, 'AGENTS.md') : fixture.authorizationFile;
    reads.afterRead = () => truncateSync(reads.file, statSync(reads.file).size + 1);
    expect(() => readKnowledgeAuthorization(fixture.input)).toThrow(/changed|unavailable/i);
    expect(reads.sizes.length).toBeGreaterThan(0);
    expect(reads.sizes.every(size => size <= 65536)).toBe(true);
    expect(reads.descriptors.size).toBe(0);
  });

  it('checks cancellation during rule reading, preserves a null reason, and closes the descriptor', () => {
    const fixture = open();
    const controller = new AbortController();
    reads.file = join(fixture.vault, 'AGENTS.md');
    reads.afterRead = () => controller.abort(null);
    let thrown: unknown = 'not aborted';
    try { readKnowledgeAuthorization({ ...fixture.input, signal: controller.signal }); } catch (error) { thrown = error; }
    expect(thrown).toBeNull();
    expect(reads.sizes.length).toBeGreaterThan(0);
    expect(reads.descriptors.size).toBe(0);
  });

  it('accepts explicit lesson publication grants without extending existing fact/process grants', () => {
    const fixture = open();
    expect(readKnowledgeGrant(fixture.authorizationFile).policy.targets[0].kinds).toEqual(['fact', 'process']);
    const grant = JSON.parse(readFileSync(fixture.authorizationFile, 'utf8'));
    grant.policy.targets[0].kinds = ['lesson'];
    writeFileSync(fixture.authorizationFile, JSON.stringify(grant), { mode: 0o600 });
    expect(readKnowledgeGrant(fixture.authorizationFile).policy.targets[0].kinds).toEqual(['lesson']);
    expect(() => readKnowledgeAuthorization(fixture.input)).toThrow('Persistent authorization policy scope, vault or target changed');
  });

  it('refuses legacy lesson publication without a complete source snapshot and independent QA receipt', async () => {
    const fixture = open(candidateProposalSchema.parse({ ...output.candidates[0], kind: 'lesson', targetRef: 'wiki:approval', payload: {
      trigger: 'Approval was bypassed', rootCause: 'Approval guard was absent', rootCauseStatus: 'confirmed',
      attempts: ['Retry publication'], fix: 'Enforce approval before publication', prevention: ['Test denied publication'],
    } }));
    fixture.policy.targets[0].kinds = ['lesson'];
    fixture.persistGrant();
    await expect(planKnowledgePublication(fixture.input)).rejects.toThrow('lesson_publication_storage_unavailable');
    expect(fixture.store.getCandidate(fixture.candidate.id)?.version).toBe(2);
    expect(fixture.store.listPublications()).toEqual([]);
  });

  it('loads trusted grant metadata without treating revoked publication permission as withdrawal permission', () => {
    const fixture = open();
    expect(readKnowledgeGrant(fixture.authorizationFile)).toMatchObject({ version: 1, revoked: false, policy: fixture.policy });
    fixture.persistGrant(true);
    expect(readKnowledgeGrant(fixture.authorizationFile).revoked).toBe(true);
    expect(() => readKnowledgeAuthorization(fixture.input)).toThrow(/revoked/i);
    expect(() => readKnowledgeAuthorization(fixture.input, true)).not.toThrow();
    fixture.persistGrant(true, false);
    expect(() => readKnowledgeAuthorization(fixture.input, true)).toThrow(/revoked/i);
  });

  it.each(['public', 'symbolic', 'inside-vault'] as const)('refuses unsafe trusted grant configuration (%s)', location => {
    const fixture = open();
    let path = fixture.authorizationFile;
    if (location === 'public') chmodSync(path, 0o644);
    if (location === 'symbolic') { path = join(fixture.root, 'grant-link.json'); symlinkSync(fixture.authorizationFile, path); }
    if (location === 'inside-vault') {
      path = join(fixture.vault, 'grant.json');
      writeFileSync(path, readFileSync(fixture.authorizationFile), { mode: 0o600 });
    }
    expect(() => readKnowledgeGrant(path)).toThrow(/private|link|ELOOP|vault/i);
  });

  it('keeps configured grant metadata readable when changed vault rules block publication and recovery', () => {
    const fixture = open();
    fixture.write('AGENTS.md', '# Changed rules\n');
    expect(readKnowledgeGrant(fixture.authorizationFile).policy).toEqual(fixture.policy);
    expect(() => readKnowledgeAuthorization(fixture.input)).toThrow(/rules.*differ/i);
    expect(() => readKnowledgeAuthorization(fixture.input, true)).toThrow(/rules.*differ/i);
  });

  it('ignores a lexical hit about a different business rule', async () => {
    const fixture = open();
    fixture.write('知识/Leave.md', page('Leave', 'Vacation approval is handled by HR'));
    const prepared = await planKnowledgePublication(fixture.input);
    expect(prepared.plan.changes[0]!.path).toBe('知识/Approval.md');
    expect(fixture.store.getCandidate(fixture.candidate.id)?.state).toBe('validated');
  });

  it('allows an unrelated lexical result added between preview and apply', async () => {
    const fixture = open();
    const prepared = await planKnowledgePublication(fixture.input);
    fixture.write('知识/Leave.md', page('Leave', 'Vacation approval is handled by HR'));
    await expect(verifyKnowledgePlan(prepared, fixture.policy, fixture.wikiScript)).resolves.toBeUndefined();
    expect(fixture.store.getCandidate(fixture.candidate.id)?.state).toBe('validated');
  });

  it('requests review for ordinary equivalent Markdown without permanently conflicting the candidate', async () => {
    const fixture = open();
    fixture.write('知识/Approval.md', page('Approval', 'Approve before publishing'));
    await expect(planKnowledgePublication(fixture.input)).rejects.toThrow(/review/i);
    expect(fixture.store.getCandidate(fixture.candidate.id)?.state).toBe('validated');
  });

  it('does not infer a contrary rule from a quoted negative example in a relevant page', async () => {
    const fixture = open();
    fixture.write('知识/Approval.md', page('Approval', 'The phrase "never approve before publishing" is a rejected example.'));
    await expect(planKnowledgePublication(fixture.input)).rejects.toThrow(/review/i);
    expect(fixture.store.getCandidate(fixture.candidate.id)?.state).toBe('validated');
  });

  it('routes environment observations to an explicitly authorized snapshot destination', async () => {
    const fixture = open(candidateProposalSchema.parse({ ...output.candidates[0], targetRef: 'wiki:approval',
      title: 'Production image', statement: 'Production currently runs image abc',
      payload: { subject: 'production image', rule: 'Production currently runs image abc', classification: 'fact' },
      applicability: { ...output.candidates[0]!.applicability, environments: ['production'] } }));
    await expect(planKnowledgePublication(fixture.input)).rejects.toThrow(/snapshot/i);
    Object.assign(fixture.policy.targets[0]!, { snapshot: true, paths: ['环境/Production.md'] });
    fixture.persistGrant();
    const prepared = await planKnowledgePublication(fixture.input);
    expect(prepared.plan.changes[0]!.path).toBe('环境/Production.md');
    expect(prepared.plan.changes[0]!.content).toContain('## snapshot');
    expect(prepared.classification).toBe('snapshot');
  });
  it('previews, applies the indexed plan and replays without rewriting', async () => {
    const fixture = open();
    const prepared = await planKnowledgePublication(fixture.input);
    expect(prepared.plan.version).toBe(1);
    expect(prepared.plan.changes.map(change => change.path)).toEqual(['知识/Approval.md', '00-总览.md', '知识/入口.md']);
    expect(prepared.plan.evidence.join('\n')).toContain('revision:abc:rules');
    expect(prepared.plan.changes[0]!.content).toContain('Approve before publishing');
    expect(prepared.plan.changes[0]!.content).toContain('abc');
    expect(prepared.plan.changes[0]!.content).toContain('[[知识/入口]]');
    expect(await runWikiIngest(fixture.wikiScript, fixture.vault, prepared.plan, false)).toMatchObject({ status: 'preview' });
    expect(() => statSync(join(fixture.vault, '知识/Approval.md'))).toThrow();
    expect(await runWikiIngest(fixture.wikiScript, fixture.vault, prepared.plan, true)).toMatchObject({ status: 'applied' });
    const before = statSync(join(fixture.vault, '知识/Approval.md')).mtimeMs;
    expect(await runWikiIngest(fixture.wikiScript, fixture.vault, prepared.plan, true)).toMatchObject({ status: 'unchanged' });
    expect(statSync(join(fixture.vault, '知识/Approval.md')).mtimeMs).toBe(before);
    const reused = await planKnowledgePublication(fixture.input);
    expect(reused.reused).toBe(true);
    expect(reused.plan.changes).toHaveLength(1);
  });

  it('reuses identical knowledge at another explicitly authorized path', async () => {
    const fixture = open();
    const first = await planKnowledgePublication(fixture.input);
    fixture.write('知识/Existing.md', first.plan.changes[0]!.content);
    fixture.policy.targets[0]!.paths.push('知识/Existing.md');
    fixture.persistGrant();
    const reused = await planKnowledgePublication(fixture.input);
    expect(reused.reused).toBe(true);
    expect(reused.plan.changes[0]!.path).toBe('知识/Existing.md');
    expect(reused.plan.changes.find(change => change.path === '00-总览.md')?.content).toContain('[[知识/Existing]]');
    expect(() => readFileSync(join(fixture.vault, '知识/Approval.md'))).toThrow();
  });

  it('reuses the same scoped rule with older provenance without refreshing or duplicating it', async () => {
    const fixture = open();
    const first = await planKnowledgePublication(fixture.input);
    await runWikiIngest(fixture.wikiScript, fixture.vault, first.plan, true);
    const original = first.plan.changes[0]!.content.replaceAll('"e1"', '"old-e1"').replaceAll('a'.repeat(64), 'c'.repeat(64));
    fixture.write('知识/Approval.md', original);
    const before = statSync(join(fixture.vault, '知识/Approval.md')).mtimeMs;
    const reused = await planKnowledgePublication(fixture.input);
    expect(reused.reused).toBe(true);
    expect(reused.plan.changes[0]!.content).toBe(original);
    expect(await runWikiIngest(fixture.wikiScript, fixture.vault, reused.plan, true)).toMatchObject({ status: 'unchanged' });
    expect(statSync(join(fixture.vault, '知识/Approval.md')).mtimeMs).toBe(before);
  });

  it('marks a contrary existing rule as conflict without merging', async () => {
    const fixture = open();
    fixture.write('知识/Approval.md', page('Approval', 'approval: Never approve before publishing.'));
    await expect(planKnowledgePublication(fixture.input)).rejects.toThrow(/conflict/i);
    expect(fixture.store.getCandidate(fixture.candidate.id)?.state).toBe('conflict');
    expect(readFileSync(join(fixture.vault, '知识/Approval.md'), 'utf8')).toContain('Never approve');
  });

  it('binds target, rules, templates, search results and scope to the preview', async () => {
    const fixture = open();
    const prepared = await planKnowledgePublication(fixture.input);
    fixture.write('知识/入口.md', page('入口', 'Human edit.'));
    await expect(verifyKnowledgePlan(prepared, fixture.policy, fixture.wikiScript)).rejects.toThrow(/changed|conflict/i);
    await expect(runWikiIngest(fixture.wikiScript, fixture.vault, prepared.plan, true)).rejects.toThrow(/concurrent|changed/i);
    fixture.write('AGENTS.md', '# Changed rules\n');
    await expect(planKnowledgePublication(fixture.input)).rejects.toThrow(/rules|authorization/i);
  });

  it.each(['../outside.md', '/outside.md', 'AGENTS.md', '知识/_模板.md', '30-账户凭证/secret.md', '.hidden/page.md'])('rejects unsafe target %s', async path => {
    const fixture = open();
    fixture.policy.targets[0]!.paths = [path];
    fixture.persistGrant();
    await expect(planKnowledgePublication(fixture.input)).rejects.toThrow(/path|protected|rules|sensitive/i);
  });

  it('rejects symbolic targets, sensitive pages and credentials', async () => {
    const fixture = open();
    symlinkSync(join(fixture.vault, '知识/入口.md'), join(fixture.vault, '知识/Approval.md'));
    await expect(planKnowledgePublication(fixture.input)).rejects.toThrow(/symbolic/i);
    const sensitive = open();
    sensitive.write('知识/Approval.md', page('Approval', 'secret').replace('[knowledge]', '[敏感]'));
    await expect(planKnowledgePublication(sensitive.input)).rejects.toThrow(/sensitive/i);
    const secret = open(candidateProposalSchema.parse({ ...output.candidates[0], targetRef: 'wiki:approval',
      payload: { subject: 'approval', rule: 'password=do-not-publish', classification: 'fact' } }));
    await expect(planKnowledgePublication(secret.input)).rejects.toThrow(/lint|sensitive|credential/i);
  });

  it('keeps classification proposal in an authorized inbox', async () => {
    const proposal = candidateProposalSchema.parse({ ...output.candidates[0], targetRef: 'wiki:approval',
      payload: { subject: 'approval', rule: 'Proposed approval rule', classification: 'proposal' } });
    const denied = open(proposal);
    await expect(planKnowledgePublication(denied.input)).rejects.toThrow(/inbox|proposal/i);
    const allowed = open({ ...proposal, targetRef: 'wiki:inbox' });
    const prepared = await planKnowledgePublication(allowed.input);
    expect(prepared.plan.changes[0]!.path).toBe('99-收件箱/Proposal.md');
    expect(prepared.plan.changes[0]!.content).toContain('proposal');
  });

  it('retains every process node, state change and explicit evidence gap', async () => {
    const process = candidateProposalSchema.parse({ ...output.candidates[0], kind: 'process', targetRef: 'wiki:inbox', payload: {
      entry: 'Submit order', systems: ['API', 'billing'], preconditions: ['Authenticated'],
      steps: [{ id: 'submit', action: 'Submit', stateChange: 'new → queued', evidenceIds: ['e1'] },
        { id: 'charge', action: 'Charge', stateChange: 'queued → charged', evidenceIds: [], missingEvidence: 'No billing trace' }],
      exceptions: ['Payment declined'], completion: 'Charge receipt exists',
    } });
    const fixture = open(process);
    const prepared = await planKnowledgePublication(fixture.input);
    const content = prepared.plan.changes[0]!.content;
    for (const value of ['submit', 'charge', 'new → queued', 'queued → charged', 'No billing trace', 'revision:abc:rules', 'partial']) expect(content).toContain(value);
  });

  it('requires current validation, evidence and explicit asset authorization', async () => {
    const fixture = open();
    await expect(planKnowledgePublication({ ...fixture.input, expectedVersion: 1 })).rejects.toThrow(/version|validation/i);
    await expect(planKnowledgePublication({ ...fixture.input, policy: { ...fixture.policy, scope: 'github:else/repo' } })).rejects.toThrow(/scope|project/i);
    fixture.policy.targets[0]!.kinds = ['process'];
    fixture.persistGrant();
    await expect(planKnowledgePublication(fixture.input)).rejects.toThrow(/authorization|kind/i);
  });

  it('rejects ambiguous vault roots before Python and Node can resolve them differently', async () => {
    const fixture = open();
    fixture.policy.vault = `${fixture.vault}/../vault`;
    fixture.persistGrant();
    await expect(planKnowledgePublication(fixture.input)).rejects.toThrow(/canonical|vault|path/i);
  });

  it('accepts a caller-authorized logical target when the candidate omits one', async () => {
    const fixture = open(candidateProposalSchema.parse(output.candidates[0]));
    await expect(planKnowledgePublication(fixture.input)).rejects.toThrow(/authorization/i);
    expect((await planKnowledgePublication({ ...fixture.input, targetRef: 'wiki:approval' })).targetRef).toBe('wiki:approval');
  });

  it('rejects revoked evidence before planning and never treats review text as credential authorization', async () => {
    const fixture = open();
    fixture.store.setRequestBlocked(fixture.candidate.requestKey, 'source_invalidated');
    await expect(planKnowledgePublication(fixture.input)).rejects.toThrow(/source|blocked|invalidated/i);
    const secret = open(candidateProposalSchema.parse({ ...output.candidates[0], targetRef: 'wiki:approval',
      payload: { subject: 'approval', rule: 'see password=do-not-publish', classification: 'fact' } }));
    await expect(planKnowledgePublication(secret.input)).rejects.toThrow(/sensitive|credential/i);
  });

  it.each(['template', 'rules', 'search'] as const)('rejects %s changes after preview', async changed => {
    const fixture = open();
    const prepared = await planKnowledgePublication(fixture.input);
    if (changed === 'template') fixture.write('知识/_模板.md', page('{{title}}', '{{knowledge}}\nNew requirement'));
    if (changed === 'rules') fixture.write('知识/AGENTS.md', '# Newly introduced rule\n');
    if (changed === 'search') fixture.write('知识/Contrary.md', page('approval', 'Contrary rule'));
    await expect(verifyKnowledgePlan(prepared, fixture.policy, fixture.wikiScript)).rejects.toThrow(/changed|rules|conflict/i);
  });
});
