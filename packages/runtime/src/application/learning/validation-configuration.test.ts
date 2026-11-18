import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { canonicalLearningJson } from './requests.js';

const scope = 'github:acme/api';
const digest = 'a'.repeat(64);
const image = `sha256:${'b'.repeat(64)}`;
const repository = () => ({ providerId: 'managed', repository: { url: 'local-fixture', ref: 'main' },
  root: '/isolated/repository', expectedCommit: 'c'.repeat(40) });
const experiment = () => ({ protocol: 'proposal-semantic-v1', adapter: 'node-json-argv-v1', kind: 'normal', input: '{"key":"alpha"}',
  assertions: [{ id: 'exit', source: 'exit-code', expected: 0 }, { id: 'value', source: 'stdout-json', path: ['value'], expected: 'alpha' }] });
const knowledge = () => ({ scope, checkerId: 'knowledge', providerId: 'semantic', version: 'v1', authorizationFile: '/isolated/private/wiki.json',
  target: { ref: 'wiki:rules', root: '/isolated/wiki', path: 'rules.md' }, allowLessonValidation: true,
  qa: { scope, workItemId: `${scope}#1`, runId: 'qa-run', targetRevision: 'c'.repeat(40), root: '/isolated/events', auditDigest: digest },
  evidence: [{ digest, sources: [{ id: 'audit', kind: 'audit', path: '/isolated/events/run.jsonl', allowedRoot: '/isolated/events', runId: 'source' }] }] });
const asset = () => ({ mode: 'repository-asset', scope, checkerId: 'asset', version: 'v1', kind: 'tool',
  executionAuthorizationFile: '/isolated/private/execution.json', repository: repository(), asset: { ref: 'script:fixture', path: 'asset.js' },
  inventory: { file: '/isolated/private/catalog.json', digest }, sandbox: { engine: 'docker', baseImageId: image },
  semantic: { protocol: 'proposal-semantic-v1', adapter: 'node-json-argv-v1', revision: 'v1',
    cases: [{ checkId: 'behavior-1', checkDigest: digest, experiment: experiment() }] } });
const grant = () => ({ version: 1, purpose: 'proposal-validation-execution', revoked: false, scope, checkerId: 'asset', checkerVersion: 'v1',
  candidateId: digest, candidateVersion: 1, candidateDigest: digest, evidenceDigest: digest,
  checkerDigest: digest, kind: 'tool', repository: repository(), asset: { ref: 'script:fixture', path: 'asset.js' }, inventoryDigest: digest,
  sandbox: { engine: 'docker', baseImageId: image }, adapter: { id: 'node-json-argv-v1', revision: 'v1', hostRuntimeRevision: 'runtime-v1' },
  allowed: { dependencies: [], permissions: [], sideEffects: 'none' }, limits: { timeoutMs: 120000, maxOutputBytes: 32768 } });
const v2 = (entry: unknown = asset()) => ({ version: 2, checkers: [entry] });
const scratchHelper = () => ({ path: '/isolated/private/scratch-helper', digest });
const recoveryExperiment = () => ({ ...experiment(), kind: 'recovery', input: 'Recover an interrupted operation', callInput: '{"key":"fault"}',
  assertions: [{ id: 'exit', source: 'exit-code', expected: 0 }, { id: 'reason', source: 'stderr', expected: 'fault' }],
  recovery: { contractRevision: 'bounded-recovery-return-state-v1', resources: [{ id: 'state', path: 'data/state.bin' }],
    callInput: '{"key":"recovered"}', requireEffectHistory: false,
    assertions: { fault: [{ id: 'state', path: 'data/state.bin', bytes: 'cGFydGlhbA==' }],
      recovered: [{ id: 'state', path: 'data/state.bin', bytes: 'ZG9uZQ==' }], replayed: [{ id: 'state', path: 'data/state.bin', bytes: 'ZG9uZQ==' }] },
    returnAssertions: { fault: { exitCode: 2, signal: null, stdoutHex: '', stderrHex: '6661756c74' },
      recovery: { exitCode: 0, signal: null, stdoutHex: '6f6b', stderrHex: '' }, replay: { exitCode: 0, signal: null, stdoutHex: '6f6b', stderrHex: '' } } } });
const recoveryAsset = (configured: unknown = recoveryExperiment()) => ({ ...asset(), sandbox: { ...asset().sandbox, scratchHelper: scratchHelper() },
  semantic: { ...asset().semantic, cases: [{ ...asset().semantic.cases[0], experiment: configured }] } });
const factCommand = () => ({ ...knowledge(), mode: 'fact-command', kind: 'fact', allowLessonValidation: undefined, qa: undefined,
  executionAuthorizationFile: '/isolated/private/fact-execution.json', execution: {
    command: ['/usr/bin/node', '/isolated/checker.mjs'], timeoutMs: 1000,
    checkerFiles: [{ path: '/usr/bin/node', digest }, { path: '/isolated/checker.mjs', digest }],
    workspace: { kind: 'repository', providerId: 'selected-repository', id: 'workspace-1',
      cwd: '/isolated/workspace', revision: 'c'.repeat(40) } } });

async function configuration() {
  const modulePath = './validation-configuration.js';
  const loaded = await import(modulePath).catch(() => undefined) as typeof import('./validation-configuration.js') | undefined;
  expect(loaded, 'A1 shared configuration module must exist').toBeDefined();
  return loaded!;
}

describe('shared validation configuration', () => {
  it('preserves legacy configuration and grant canonical bytes and digests when optional fields are absent', async () => {
    const module = await configuration();
    const hash = (value: unknown) => createHash('sha256').update(canonicalLearningJson(value)).digest('hex');
    for (const input of [{ version: 1, checkers: [knowledge()] }, v2()]) {
      const parsed = module.validationConfigurationSchema.parse(input);
      expect(canonicalLearningJson(parsed)).toBe(canonicalLearningJson(input));
      expect(hash(parsed)).toBe(hash(input));
      expect(parsed.checkers[0]).not.toHaveProperty('sandbox.scratchHelper');
      expect(parsed.checkers[0]).not.toHaveProperty('semantic.cases.0.experiment.recovery');
    }
    const parsed = module.proposalExecutionGrantSchema.parse(grant());
    expect(canonicalLearningJson(parsed)).toBe(canonicalLearningJson(grant()));
    expect(hash(parsed)).toBe(hash(grant()));
    expect(parsed.sandbox).not.toHaveProperty('scratchHelper');
  });

  it('parses the optional versioned recovery contract and shared helper pin without granting execution', async () => {
    const module = await configuration();
    const input = v2(recoveryAsset());
    expect(module.validationConfigurationSchema.parse(input)).toEqual(input);
    const authorized = { ...grant(), sandbox: { ...grant().sandbox, scratchHelper: scratchHelper() } };
    expect(module.proposalExecutionGrantSchema.parse(authorized)).toEqual(authorized);
    expect(module.validationConfigurationSchema.safeParse(v2(recoveryAsset({ ...recoveryExperiment(),
      recovery: { ...recoveryExperiment().recovery, requireEffectHistory: true } }))).success).toBe(true);
    const legacy = Object.fromEntries(Object.entries(recoveryExperiment()).filter(([key]) => key !== 'recovery'));
    expect(module.validationConfigurationSchema.safeParse(v2(recoveryAsset(legacy))).success).toBe(true);
  });

  it('requires a helper only for cases with a recovery contract and preserves unbound legacy cases', async () => {
    const module = await configuration();
    const entry = recoveryAsset();
    expect(module.validationConfigurationSchema.safeParse(v2({ ...entry, sandbox: asset().sandbox })).success).toBe(false);
    const legacy = v2({ ...asset(), semantic: { ...asset().semantic,
      cases: [{ ...asset().semantic.cases[0], experiment: { ...experiment(), kind: 'recovery' } }] } });
    const parsed = module.validationConfigurationSchema.parse(legacy);
    expect(parsed).toEqual(legacy);
    expect(canonicalLearningJson(parsed)).toBe(canonicalLearningJson(legacy));
    expect(parsed.checkers[0]).not.toHaveProperty('sandbox.scratchHelper');
    expect(parsed.checkers[0]).not.toHaveProperty('semantic.cases.0.experiment.recovery');
    const semantics = await import('./proposal-semantics.js');
    const configured = { ...experiment(), kind: 'recovery' as const };
    expect(semantics.prepareProposalExperiment('tool', 'asset.js', { id: 'behavior-1', kind: 'recovery',
      input: configured.input, expected: 'Candidate claim is not the oracle' }, configured))
      .toEqual({ status: 'unsupported', reason: 'recovery_contract_unavailable' });
  });

  it('rejects malformed helper provenance identically in configuration and grant', async () => {
    const module = await configuration();
    for (const helper of [null, {}, { path: scratchHelper().path }, { digest }, { ...scratchHelper(), extra: true },
      { ...scratchHelper(), digest: 'wrong' }, { ...scratchHelper(), digest: 'A'.repeat(64) },
      ...['relative/helper', '/isolated/../helper', '/isolated//helper', '/isolated/helper/', '/isolated/helper\\other', '/isolated/helper\0', '/isolated/helper\n']
        .map(path => ({ ...scratchHelper(), path }))]) {
      expect(module.validationConfigurationSchema.safeParse(v2({ ...recoveryAsset(), sandbox: { ...asset().sandbox, scratchHelper: helper } })).success).toBe(false);
      expect(module.proposalExecutionGrantSchema.safeParse({ ...grant(), sandbox: { ...grant().sandbox, scratchHelper: helper } }).success).toBe(false);
    }
  });

  it('rejects mismatched kinds, control, missing business input and malformed recovery contracts', async () => {
    const module = await configuration();
    const configured = recoveryExperiment();
    for (const invalid of [
      { ...configured, kind: 'normal' }, { ...configured, kind: 'refusal' }, { ...configured, kind: 'permission-denied' },
      { ...configured, control: { kind: 'timeout', afterMs: 10 } }, { ...configured, callInput: undefined },
      { ...configured, assertions: [{ ...configured.assertions[0], expected: 2 }, configured.assertions[1]] },
      { ...configured, callInput: configured.recovery.callInput }, { ...configured, recovery: {} },
      { ...configured, recovery: { ...configured.recovery, contractRevision: undefined } },
      { ...configured, recovery: { ...configured.recovery, returnAssertions: undefined } },
      { ...configured, recovery: { ...configured.recovery, extra: true } },
      { ...configured, recovery: { ...configured.recovery, returnAssertions: { ...configured.recovery.returnAssertions,
        fault: { ...configured.recovery.returnAssertions.fault, stdoutHex: 'FF' } } } },
      { ...configured, recovery: { ...configured.recovery, assertions: { ...configured.recovery.assertions,
        fault: [{ ...configured.recovery.assertions.fault[0], bytes: 'YQ' }] } } },
    ]) expect(module.validationConfigurationSchema.safeParse(v2(recoveryAsset(invalid))).success).toBe(false);
  });

  it.each(['fault', 'recovery'] as const)('requires bounded JSON business bytes for the %s phase', async phase => {
    const module = await configuration();
    for (const callInput of ['not JSON', '{"key":"alpha"}\0', '"' + 'x'.repeat(2048) + '"',
      JSON.stringify(Array.from({ length: 34 }).reduce(value => [value], [] as unknown[]))]) {
      const configured = recoveryExperiment();
      const invalid = phase === 'fault' ? { ...configured, callInput } : { ...configured, recovery: { ...configured.recovery, callInput } };
      expect(module.validationConfigurationSchema.safeParse(v2(recoveryAsset(invalid))).success).toBe(false);
    }
  });

  it('accepts the aggregate return limit and rejects a single excess decoded byte across phases', async () => {
    const module = await configuration();
    const configured = recoveryExperiment();
    const returns = configured.recovery.returnAssertions;
    const bounded = { fault: { ...returns.fault, stdoutHex: '00'.repeat(32768), stderrHex: '' },
      recovery: { ...returns.recovery, stdoutHex: '' }, replay: { ...returns.replay, stdoutHex: '' } };
    expect(module.validationConfigurationSchema.safeParse(v2(recoveryAsset({ ...configured,
      recovery: { ...configured.recovery, returnAssertions: bounded } }))).success).toBe(true);
    expect(module.validationConfigurationSchema.safeParse(v2(recoveryAsset({ ...configured, recovery: { ...configured.recovery,
      returnAssertions: { ...bounded, recovery: { ...bounded.recovery, stderrHex: '00' } } } }))).success).toBe(false);
  });

  it.each(['validation', 'experience-store'])('initializes QA configuration after importing %s first', async entry => {
    vi.resetModules();
    await import(`./${entry}.js`);
    const configured = await import('./validation-configuration.js');
    const validation = await import('./validation.js');
    expect(configured.validationConfigurationSchema.safeParse(v2({ mode: 'knowledge', ...knowledge() })).success).toBe(true);
    expect(validation.lessonQaConfigurationSchema.safeParse(knowledge().qa).success).toBe(true);
  });

  it('pins a frozen checker closure and requires both immutable input delivery paths', async () => {
    const module = await configuration();
    const entry = factCommand();
    const execution = { ...entry.execution, checkerFiles: [],
      frozen: { checkerRoot: '/isolated/checker', checkerDigest: digest, baseImageId: image },
      command: ['/usr/bin/node', '/workspace/checker.mjs', '/workspace/.verification-request.json', '/workspace/.verification-target.json'] };
    expect(module.validationConfigurationSchema.safeParse(v2({ ...entry, execution })).success).toBe(true);
    for (const change of [
      { checkerFiles: entry.execution.checkerFiles },
      { frozen: { ...execution.frozen, checkerDigest: 'unpinned' } },
      { frozen: { ...execution.frozen, baseImageId: 'node:latest' } },
      { command: ['/usr/../usr/bin/node', ...execution.command.slice(1)] },
      ...['/workspace/.verification-request.json', '/workspace/.verification-target.json']
        .map(file => ({ command: execution.command.filter(argument => argument !== file) })),
    ]) expect(module.validationConfigurationSchema.safeParse(v2({ ...entry, execution: { ...execution, ...change } })).success).toBe(false);
  });

  it('reserves a fact-only command contract without qualifying an ordinary test runner', async () => {
    const module = await configuration();
    const input = v2(factCommand());
    const parsed = module.validationConfigurationSchema.parse(input);
    expect(parsed).toEqual(input);
    expect(module.selectKnowledgeValidationChecker(parsed, scope, 'knowledge')).toEqual(factCommand());
    expect(module.validationConfigurationSchema.safeParse({ version: 1, checkers: [factCommand()] }).success).toBe(false);
  });

  it.each([
    { kind: 'process' }, { qa: knowledge().qa }, { allowLessonValidation: true },
    { executionAuthorizationFile: undefined }, { execution: { ...factCommand().execution, command: ['node', 'checker.mjs'] } },
    { execution: { ...factCommand().execution, checkerFiles: [] } },
    { execution: { ...factCommand().execution, workspace: { ...factCommand().execution.workspace, cwd: 'relative' } } },
    { execution: { ...factCommand().execution, checkerFiles: [{ path: '/other/node', digest }] } },
    { execution: { ...factCommand().execution, checkerFiles: [factCommand().execution.checkerFiles[0], factCommand().execution.checkerFiles[0]] } },
  ])('rejects incomplete or broadened fact execution contracts %#', async extra => {
    expect((await configuration()).validationConfigurationSchema.safeParse(v2({ ...factCommand(), ...extra })).success).toBe(false);
  });

  it('requires a separately purposed exact execution grant', async () => {
    const module = await configuration();
    const ownedFixtureGrant = { version: 1, purpose: 'fact-validation-execution', revoked: false, kind: 'fact',
      scope, checkerId: 'knowledge', checkerVersion: 'v1', checkerDigest: digest, execution: factCommand().execution };
    expect(module.factExecutionGrantSchema.parse(ownedFixtureGrant)).toEqual(ownedFixtureGrant);
    for (const extra of [{ purpose: 'knowledge-publication' }, { kind: 'process' }, { passed: true }, { execution: undefined }]) {
      expect(module.factExecutionGrantSchema.safeParse({ ...ownedFixtureGrant, ...extra }).success).toBe(false);
    }
  });

  it('preserves the original v1 knowledge configuration and normalized selection', async () => {
    const module = await configuration();
    const input = { version: 1, checkers: [knowledge()] };
    expect(module.validationConfigurationSchema.parse(input)).toEqual(input);
    const parsed = module.validationConfigurationSchema.parse(input);
    expect(module.selectKnowledgeValidationChecker(parsed, scope, 'knowledge')).toEqual(knowledge());
  });

  it('selects only knowledge from a mixed v2 configuration and strips its mode', async () => {
    const module = await configuration();
    const parsed = module.validationConfigurationSchema.parse({ version: 2, checkers: [{ mode: 'knowledge', ...knowledge() }, asset()] });
    expect(module.selectKnowledgeValidationChecker(parsed, scope, 'knowledge')).toEqual(knowledge());
    expect(module.selectKnowledgeValidationChecker(parsed, scope, 'asset')).toBeUndefined();
    expect(module.selectKnowledgeValidationChecker(parsed, 'github:other/api', 'knowledge')).toBeUndefined();
    expect(module.selectKnowledgeValidationChecker(parsed, scope, 'missing')).toBeUndefined();
  });

  it.each([
    ['extra field', { ...knowledge(), command: ['sh'] }],
    ['bad target', { ...knowledge(), target: { ...knowledge().target, path: '../rules.md' } }],
    ['audit identity', { ...knowledge(), evidence: [{ digest, sources: [{ ...knowledge().evidence[0].sources[0], runId: undefined }] }] }],
    ['relative authorization', { ...knowledge(), authorizationFile: 'wiki.json' }],
    ['duplicate source', { ...knowledge(), evidence: [{ digest, sources: [knowledge().evidence[0].sources[0], knowledge().evidence[0].sources[0]] }] }],
  ])('retains v1 rejection semantics: %s', async (_name, entry) => {
    const module = await configuration();
    const input = { version: 1, checkers: [entry] };
    expect(module.validationConfigurationSchema.safeParse(input).success).toBe(false);
  });

  it('retains original v1 identity trimming and its knowledge-only relative path rules', async () => {
    const module = await configuration();
    const input = { version: 1, checkers: [{ ...knowledge(), checkerId: ' knowledge ', target: { ...knowledge().target, path: '.git/rules.md' } }] };
    expect(module.validationConfigurationSchema.parse(input)).toEqual({ version: 1, checkers: [{ ...knowledge(),
      target: { ...knowledge().target, path: '.git/rules.md' } }] });
  });

  it.each([1, 2])('rejects duplicate scoped checker identities in v%s', async version => {
    const module = await configuration();
    const entry = version === 1 ? knowledge() : { mode: 'knowledge', ...knowledge() };
    expect(module.validationConfigurationSchema.safeParse({ version, checkers: [entry, entry] }).success).toBe(false);
  });

  it('rejects cross-mode collisions after identity normalization but permits different scopes', async () => {
    const module = await configuration();
    const entry = { ...asset(), checkerId: ' knowledge ' };
    expect(module.validationConfigurationSchema.safeParse({ version: 2, checkers: [{ mode: 'knowledge', ...knowledge() }, entry] }).success).toBe(false);
    expect(module.validationConfigurationSchema.safeParse({ version: 2, checkers: [{ mode: 'knowledge', ...knowledge() }, { ...entry, scope: 'github:other/api' }] }).success).toBe(true);
  });

  it.each([
    { version: 1, checkers: [asset()] }, { version: 2, checkers: [knowledge()] },
    { ...v2(), passed: true }, { version: 2, checkers: [] }, { version: 3, checkers: [asset()] },
    { version: 2, checkers: Array.from({ length: 65 }, (_, index) => ({ ...asset(), checkerId: `asset-${index}` })) },
  ])('rejects ambiguous or expanded root configuration %#', async input => {
    expect((await configuration()).validationConfigurationSchema.safeParse(input).success).toBe(false);
  });

  it('parses a tool binding without implying complete coverage or executable qualification', async () => {
    const module = await configuration();
    expect(module.validationConfigurationSchema.parse(v2())).toEqual(v2());
    expect(module.selectKnowledgeValidationChecker(module.validationConfigurationSchema.parse(v2()), scope, 'asset')).toBeUndefined();
  });

  it('reserves skill-trace configuration without a supported or enabled escape', async () => {
    const module = await configuration();
    const entry = { ...asset(), kind: 'skill', asset: { ref: 'skill:fixture', path: 'skills/fixture/SKILL.md' },
      semantic: { ...asset().semantic, adapter: 'skill-trace-v1', cases: [{ ...asset().semantic.cases[0],
        experiment: { ...experiment(), adapter: 'skill-trace-v1' } }] } };
    expect(module.validationConfigurationSchema.parse(v2(entry))).toEqual(v2(entry));
    expect(module.validationConfigurationSchema.safeParse(v2({ ...entry, supported: true })).success).toBe(false);
  });

  it.each([
    { callback: () => true }, { passed: true }, { argv: ['sh', '-c', 'echo passed'] }, { runId: 'client-run' }, { binding: {} },
    { report: {} }, { runtimeVersion: 'client' }, { providerId: 'legacy-verifier' }, { allowLessonValidation: true },
  ])('rejects client and legacy escapes on asset entries %#', async extra => {
    expect((await configuration()).validationConfigurationSchema.safeParse(v2({ ...asset(), ...extra })).success).toBe(false);
  });

  it.each([
    { repository: { ...repository(), force: true } }, { repository: { ...repository(), expectedCommit: 'main' } },
    { repository: { ...repository(), expectedCommit: 'C'.repeat(40) } }, { repository: { ...repository(), root: '/isolated/../repository' } },
    { repository: { ...repository(), root: 'repository' } }, { asset: { ...asset().asset, path: '../asset.js' } },
    { asset: { ...asset().asset, path: '.git/config' } }, { asset: { ...asset().asset, path: '/asset.js' } },
    { asset: { ...asset().asset, path: 'dir\\asset.js' } }, { asset: { ...asset().asset, path: 'dir//asset.js' } },
    { asset: { ...asset().asset, path: 'asset\0.js' } }, { asset: { ref: 'wiki:rules', path: 'asset.js' } },
    { asset: { ref: 'script:../fixture', path: 'asset.js' } }, { asset: { ref: 'cli:fixture/../unsafe', path: 'asset.js' } },
    { asset: { ref: 'plugin:fixture?override=true', path: 'asset.js' } },
    { sandbox: { engine: 'docker', baseImageId: 'node:latest' } }, { sandbox: { engine: 'podman', baseImageId: image } },
    { sandbox: { ...asset().sandbox, env: { TOKEN: 'secret' } } }, { inventory: { ...asset().inventory, digest: 'wrong' } },
    { inventory: { ...asset().inventory, file: 'catalog.json' } }, { executionAuthorizationFile: '/isolated/repository/execution.json' },
    { executionAuthorizationFile: '/isolated/private/../execution.json' },
    { semantic: { ...asset().semantic, adapter: 'skill-trace-v1' } },
    { kind: 'skill', asset: { ref: 'skill:fixture', path: 'SKILL.md' } },
  ])('rejects invalid asset binding %#', async extra => {
    expect((await configuration()).validationConfigurationSchema.safeParse(v2({ ...asset(), ...extra })).success).toBe(false);
  });

  it('accepts an exact sha256 Git commit and an explicit null target for a new asset', async () => {
    expect((await configuration()).validationConfigurationSchema.safeParse(v2({ ...asset(),
      repository: { ...repository(), expectedCommit: digest }, asset: { ref: null, path: 'new.js' } })).success).toBe(true);
  });

  it.each([
    { ...asset().semantic, cases: [] },
    { ...asset().semantic, cases: [asset().semantic.cases[0], asset().semantic.cases[0]] },
    { ...asset().semantic, cases: [{ ...asset().semantic.cases[0], checkDigest: 'bad' }] },
    { ...asset().semantic, cases: [{ ...asset().semantic.cases[0], argv: ['sh'] }] },
    { ...asset().semantic, cases: [{ checkId: 'behavior-1', checkDigest: digest }] },
    { ...asset().semantic, cases: Array.from({ length: 17 }, (_, index) => ({ ...asset().semantic.cases[0], checkId: `check-${index}` })) },
  ])('rejects invalid semantic case tables %#', async semantic => {
    expect((await configuration()).validationConfigurationSchema.safeParse(v2({ ...asset(), semantic })).success).toBe(false);
  });

  it.each([
    { ...experiment(), assertions: [experiment().assertions[0], experiment().assertions[0]] },
    { ...experiment(), assertions: [experiment().assertions[0], { id: 'value', source: 'stdout-json', expected: undefined }] },
    { ...experiment(), assertions: [experiment().assertions[0], { ...experiment().assertions[1], path: ['__proto__'] }] },
    { ...experiment(), assertions: [experiment().assertions[0], { id: 'value', source: 'stdout', path: ['value'], expected: 'alpha' }] },
    { ...experiment(), assertions: [{ id: 'exit', source: 'exit-code', expected: 256 }, experiment().assertions[1]] },
    { ...experiment(), assertions: [{ id: 'exit', source: 'exit-code', expected: '0' }, experiment().assertions[1]] },
    { ...experiment(), control: { kind: 'timeout', afterMs: 1 } },
    { ...experiment(), assertions: [experiment().assertions[0], { id: 'control', source: 'control', expected: {} }] },
    { ...experiment(), kind: 'refusal' }, { ...experiment(), kind: 'cancellation' },
    { ...experiment(), passed: true },
    { ...experiment(), callInput: experiment().input },
    { ...experiment(), kind: 'refusal', callInput: experiment().input, assertions: [
      { id: 'exit', source: 'exit-code', expected: 2 }, experiment().assertions[1]] },
  ])('rejects semantic assertion and control escapes %#', async invalid => {
    const entry = asset();
    expect((await configuration()).validationConfigurationSchema.safeParse(v2({ ...entry,
      semantic: { ...entry.semantic, cases: [{ ...entry.semantic.cases[0], experiment: invalid }] } })).success).toBe(false);
  });

  it.each(['cancellation', 'timeout'])('parses a bound %s experiment without fabricating a host receipt', async kind => {
    const entry = asset();
    const control = { ...experiment(), kind, input: 'Host interrupts the business operation', callInput: '{ "key": "alpha" }', control: { kind, afterMs: 10 }, assertions: [
      { id: 'exit', source: 'exit-code', expected: 137 }, { id: 'host', source: 'control', path: ['outcome'], expected: 'triggered' }] };
    expect((await configuration()).validationConfigurationSchema.safeParse(v2({ ...entry,
      semantic: { ...entry.semantic, cases: [{ ...entry.semantic.cases[0], experiment: control }] } })).success).toBe(true);
    const parsed = (await configuration()).validationConfigurationSchema.parse(v2({ ...entry,
      semantic: { ...entry.semantic, cases: [{ ...entry.semantic.cases[0], experiment: control }] } }));
    expect(parsed.checkers[0]).toMatchObject({ semantic: { cases: [{ experiment: { input: control.input, callInput: control.callInput } }] } });
    for (const callInput of ['not JSON', '{"key":"alpha"}\0', '"' + 'x'.repeat(2048) + '"', JSON.stringify(Array.from({ length: 34 }).reduce(value => [value], [] as unknown[]))]) {
      expect((await configuration()).validationConfigurationSchema.safeParse(v2({ ...entry,
        semantic: { ...entry.semantic, cases: [{ ...entry.semantic.cases[0], experiment: { ...control, callInput } }] } })).success).toBe(false);
    }
  });

  it('accepts a refusal with a nonzero exit and an independent output assertion', async () => {
    const entry = asset();
    const refusal = { ...experiment(), kind: 'refusal', input: 'invalid', assertions: [
      { id: 'exit', source: 'exit-code', expected: 2 }, { id: 'reason', source: 'stderr', expected: 'invalid input' }] };
    expect((await configuration()).validationConfigurationSchema.safeParse(v2({ ...entry,
      semantic: { ...entry.semantic, cases: [{ ...entry.semantic.cases[0], experiment: refusal }] } })).success).toBe(true);
  });

  it('rejects invalid normal input and a controlled experiment with no host assertion', async () => {
    const entry = asset();
    for (const configured of [{ ...experiment(), input: 'invalid' }, { ...experiment(), kind: 'cancellation',
      control: { kind: 'cancellation', afterMs: 10 }, assertions: [
        { id: 'exit', source: 'exit-code', expected: 137 }, experiment().assertions[1]] }]) {
      expect((await configuration()).validationConfigurationSchema.safeParse(v2({ ...entry,
        semantic: { ...entry.semantic, cases: [{ ...entry.semantic.cases[0], experiment: configured }] } })).success).toBe(false);
    }
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n, Symbol('invalid'), () => true, new Date(), new Map(), 'x'.repeat(32769)])(
    'rejects non-JSON or oversized assertion expected %#', async expected => {
      const entry = asset();
      const configured = { ...experiment(), assertions: [experiment().assertions[0], { ...experiment().assertions[1], expected }] };
      expect((await configuration()).validationConfigurationSchema.safeParse(v2({ ...entry,
        semantic: { ...entry.semantic, cases: [{ ...entry.semantic.cases[0], experiment: configured }] } })).success).toBe(false);
    });

  it('bounds cyclic, deep, wide and accessor assertion values without invoking their code', async () => {
    const module = await configuration();
    const cyclic: unknown[] = []; cyclic.push(cyclic);
    let deep: unknown = null;
    for (let index = 0; index < 34; index++) deep = [deep];
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get() { getterCalls++; return 'unsafe'; } });
    for (const expected of [cyclic, deep, Array(4097).fill(null), accessor, [, 'sparse']]) {
      const entry = asset();
      const configured = { ...experiment(), assertions: [experiment().assertions[0], { ...experiment().assertions[1], expected }] };
      expect(module.validationConfigurationSchema.safeParse(v2({ ...entry,
        semantic: { ...entry.semantic, cases: [{ ...entry.semantic.cases[0], experiment: configured }] } })).success).toBe(false);
    }
    expect(getterCalls).toBe(0);
  });
});

describe('proposal execution grant', () => {
  it('parses a standalone zero-privilege grant without interpreting revoked as allowed', async () => {
    const module = await configuration();
    expect(module.proposalExecutionGrantSchema.parse(grant())).toEqual(grant());
    expect(module.proposalExecutionGrantSchema.parse({ ...grant(), revoked: true }).revoked).toBe(true);
  });

  it.each([
    { version: 1, revoked: false, allowWithdrawal: true, policy: { scope, vault: '/wiki', rules: {}, targets: [] } },
    { ...grant(), purpose: 'wiki-publication' }, { ...grant(), force: true }, { ...grant(), passed: true },
    { ...grant(), allowed: { ...grant().allowed, dependencies: ['npm:unknown'] } },
    { ...grant(), allowed: { ...grant().allowed, permissions: ['network'] } },
    { ...grant(), allowed: { ...grant().allowed, sideEffects: 'filesystem' } },
    { ...grant(), limits: { timeoutMs: 120001, maxOutputBytes: 32768 } },
    { ...grant(), limits: { timeoutMs: 0.5, maxOutputBytes: 32768 } },
    { ...grant(), limits: { timeoutMs: 1000, maxOutputBytes: 32769 } },
    { ...grant(), limits: { timeoutMs: 1000, maxOutputBytes: 0 } },
    { ...grant(), checkerDigest: 'wrong' }, { ...grant(), inventoryDigest: 'wrong' },
    { ...grant(), candidateId: undefined }, { ...grant(), candidateVersion: 0 },
    { ...grant(), candidateDigest: 'wrong' }, { ...grant(), evidenceDigest: undefined },
    { ...grant(), adapter: { ...grant().adapter, id: 'skill-trace-v1' } },
    { ...grant(), repository: { ...repository(), path: '/client-target' } },
    { ...grant(), sandbox: { ...grant().sandbox, privileged: true } },
    { ...grant(), adapter: { ...grant().adapter, callback: () => true } },
  ])('rejects execution authorization escalation %#', async input => {
    expect((await configuration()).proposalExecutionGrantSchema.safeParse(input).success).toBe(false);
  });
});
