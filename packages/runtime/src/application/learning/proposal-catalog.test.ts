import { createHash } from 'node:crypto';
import filesystem from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalLearningJson } from './requests.js';
import { prepareAssetProposal } from './proposals.js';
import { output } from './ledger-data.fixture.spec.js';

const scope = 'github:acme/catalog';
const expectedCommit = 'a'.repeat(40);
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  temporary.splice(0).forEach(directory => filesystem.rmSync(directory, { recursive: true, force: true }));
});

function fixture() {
  const base = filesystem.realpathSync(filesystem.mkdtempSync(join(tmpdir(), 'proposal-catalog-')));
  temporary.push(base);
  const repositoryRoot = join(base, 'repository');
  const privateRoot = join(base, 'private');
  filesystem.mkdirSync(repositoryRoot, { mode: 0o700 });
  filesystem.mkdirSync(privateRoot, { mode: 0o700 });
  const scanRoots = { skills: 'catalog/skills', cli: 'catalog/cli', script: 'catalog/script', plugin: 'catalog/plugin' };
  for (const relative of Object.values(scanRoots)) filesystem.mkdirSync(join(repositoryRoot, relative), { recursive: true, mode: 0o700 });
  const original = '---\nname: recover\ndescription: Recover interrupted jobs\ndisable-model-invocation: true\nuser-invocable: true\nallowed-tools: [Read]\ndisallowed-tools: [Bash]\n---\nManual recovery only.\n';
  const skillFile = join(repositoryRoot, scanRoots.skills, 'recover', 'SKILL.md');
  filesystem.mkdirSync(join(repositoryRoot, scanRoots.skills, 'recover'));
  filesystem.writeFileSync(skillFile, original, { mode: 0o600 });
  const toolFiles = (['cli', 'script', 'plugin'] as const).map(kind => {
    const file = join(repositoryRoot, scanRoots[kind], `${kind}.js`);
    const content = `throw new Error('Catalog must not execute ${kind}');\n`;
    filesystem.writeFileSync(file, content, { mode: 0o600 });
    return { kind, ref: `${kind}:fixture`, name: `${kind}-fixture`, description: `Known ${kind} fixture`, provenance: 'operator',
      scope, expectedCommit, digest: digest(content), source: { root: repositoryRoot, file } };
  });
  const manifest = { version: 1, scope, repositoryRoot, expectedCommit, scanRoots,
    skills: [{ name: 'recover', description: 'Recover interrupted jobs', 'disable-model-invocation': true, 'user-invocable': true,
      'allowed-tools': ['Read'], 'disallowed-tools': ['Bash'], scope, expectedCommit, digest: digest(original),
      source: { root: repositoryRoot, file: skillFile } }], tools: toolFiles };
  const file = join(privateRoot, 'catalog.json');
  const input = { scope, repositoryRoot, expectedCommit, file, digest: '' };
  const save = (value: unknown = manifest) => {
    const content = JSON.stringify(value);
    filesystem.writeFileSync(file, content, { mode: 0o600 });
    input.digest = digest(content);
  };
  save();
  return { base, repositoryRoot, privateRoot, manifest, input, save, original, skillFile, toolFiles };
}

async function catalog() {
  const modulePath = './proposal-catalog.js';
  const loaded = await import(modulePath).catch(() => undefined) as typeof import('./proposal-catalog.js') | undefined;
  expect(loaded, 'B1 catalog module must exist').toBeDefined();
  return loaded!;
}

describe('bounded operator proposal catalog', () => {
  it('binds declared skill resources to the inventory and rejects resource drift', async () => {
    const current = fixture();
    const path = 'references/recovery.md';
    const file = join(dirname(current.skillFile), path);
    const content = 'Recovery reference';
    filesystem.mkdirSync(dirname(file));
    filesystem.writeFileSync(file, content);
    const resources = [{ path, digest: digest(content) }];
    current.save({ ...current.manifest, skills: [{ ...current.manifest.skills[0], resources }] });
    const module = await catalog();
    const result = module.readProposalCatalog(current.input);
    expect(result.inventory.skills[0]).toHaveProperty('resources', resources);
    expect(result.inventoryDigest).toBe(digest(canonicalLearningJson(result.inventory)));
    expect(result.scanReceipts[0].entries).toContainEqual(expect.objectContaining({
      path: `${current.manifest.scanRoots.skills}/recover/${path}`, digest: resources[0].digest,
    }));
    filesystem.appendFileSync(file, '!');
    expect(() => result.assertCurrent()).toThrowError('proposal_catalog_unavailable_or_changed');
    expect(() => module.readProposalCatalog(current.input)).toThrowError('proposal_catalog_unavailable_or_changed');
  });

  it.each(['undeclared', 'escape', 'duplicate', 'nested-owner', 'symlink'] as const)('rejects %s skill resources', async kind => {
    const current = fixture();
    const path = kind === 'escape' ? '../reference.md' : kind === 'nested-owner' ? 'nested/reference.md' : 'reference.md';
    const file = join(dirname(current.skillFile), path);
    const content = 'Reference';
    filesystem.mkdirSync(dirname(file), { recursive: true });
    if (kind === 'symlink') {
      const outside = join(current.privateRoot, 'reference.md');
      filesystem.writeFileSync(outside, content);
      filesystem.symlinkSync(outside, file);
    } else filesystem.writeFileSync(file, content);
    const resource = { path, digest: digest(content) };
    const skill = current.manifest.skills[0];
    const skills = [kind === 'undeclared' ? skill : { ...skill, resources: kind === 'duplicate' ? [resource, resource] : [resource] }];
    if (kind === 'nested-owner') {
      const nestedSkill = join(dirname(file), 'SKILL.md');
      filesystem.writeFileSync(nestedSkill, current.original);
      skills.push({ ...skill, name: 'nested', source: { ...skill.source, file: nestedSkill } });
    }
    current.save({ ...current.manifest, skills });
    const module = await catalog();
    expect(() => module.readProposalCatalog(current.input)).toThrowError('proposal_catalog_unavailable_or_changed');
  });

  it('builds inventory from pinned bytes and actual four-category scans without executing assets', async () => {
    const current = fixture();
    const result = (await catalog()).readProposalCatalog(current.input);
    expect(result.inventory.skills).toHaveLength(1);
    expect(result.inventory.tools.map(tool => tool.kind)).toEqual(['cli', 'script', 'plugin']);
    expect(result.inventory.toolSearches).toEqual(['cli', 'script', 'plugin']);
    expect(result.inventoryDigest).toBe(digest(canonicalLearningJson(result.inventory)));
    expect(result.digest).toBe(result.inventoryDigest);
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.fingerprint).not.toBe(result.manifestFingerprint);
    expect(result.manifestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.scanReceipts.map(receipt => receipt.kind)).toEqual(['skills', 'cli', 'script', 'plugin']);
    for (const receipt of result.scanReceipts) {
      expect(receipt).toMatchObject({ scope, repositoryRoot: current.repositoryRoot, expectedCommit, scannerRevision: 'proposal-catalog-v1' });
      expect(receipt.entries.some(entry => entry.kind === 'file' && entry.digest)).toBe(true);
      expect(receipt.digest).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(result.assertCurrent).toBe(result.assertCurrent);
    expect(result.assertCurrent()).toBeUndefined();
    expect(Object.isFrozen(result.inventory)).toBe(true);
    expect(Object.isFrozen(result.inventory.tools[0].source)).toBe(true);
    expect(() => result.inventory.toolSearches.push('cli')).toThrow();
  });

  it('feeds the existing skill proposal preparer with exact source bytes and preserved invocation fields', async () => {
    const current = fixture();
    const selected = (await catalog()).readProposalCatalog(current.input);
    const prepared = prepareAssetProposal({ ...output.candidates[0], kind: 'skill', title: 'Recover jobs', payload: {
      targetSkill: 'skill:recover', originalDigest: digest(current.original), triggers: ['Manual recovery request'],
      prohibitedConditions: ['No authorization'], inputs: [{ name: 'job', description: 'Job identifier', required: true }],
      branches: ['Resume interrupted job'], recovery: ['Keep original checkpoint'], completion: 'Checkpoint confirmed', patch: 'Parameterize job.',
      evaluationCases: [{ kind: 'normal', input: 'job A', expected: 'Complete job A' },
        { kind: 'recovery', input: 'job B interrupted', expected: 'Resume job B' }, { kind: 'refusal', input: 'unauthorized', expected: 'Refuse' }],
    } }, selected.inventory);
    expect(prepared.artifact.originalDigest).toBe(digest(current.original));
    expect(prepared.invocation).toEqual({ automatic: false, userInvocable: true, allowedTools: ['Read'], disallowedTools: ['Bash'] });
    selected.assertCurrent();
  });

  it('records real empty directory scans instead of accepting self-reported search completion', async () => {
    const current = fixture();
    for (const tool of current.toolFiles) filesystem.unlinkSync(tool.source.file);
    current.manifest.tools = [];
    current.save();
    const result = (await catalog()).readProposalCatalog(current.input);
    expect(result.inventory.tools).toEqual([]);
    expect(result.inventory.toolSearches).toEqual(['cli', 'script', 'plugin']);
    expect(result.scanReceipts.slice(1).every(receipt => receipt.entries.length === 1 && receipt.entries[0].kind === 'directory')).toBe(true);
  });

  it.each([
    { searches: true }, { toolSearches: ['cli', 'script', 'plugin'] }, { passed: true }, { scanReceipts: [] },
    { scope: 'github:other/catalog' }, { expectedCommit: 'b'.repeat(40) }, { version: 2 },
  ])('rejects manifest overrides and manufactured search claims %#', async extra => {
    const current = fixture(); current.save({ ...current.manifest, ...extra });
    const module = await catalog();
    expect(() => module.readProposalCatalog(current.input)).toThrow();
  });

  it.each(['missing-category', 'overlap', 'escape', 'dotgit', 'missing-directory'] as const)('rejects incomplete scan domains: %s', async kind => {
    const current = fixture();
    const roots = { ...current.manifest.scanRoots };
    if (kind === 'missing-category') Reflect.deleteProperty(roots, 'cli');
    if (kind === 'overlap') roots.cli = roots.script;
    if (kind === 'escape') roots.cli = '../private';
    if (kind === 'dotgit') roots.cli = '.git/objects';
    if (kind === 'missing-directory') { filesystem.unlinkSync(current.toolFiles[0].source.file); filesystem.rmdirSync(join(current.repositoryRoot, roots.cli)); }
    current.save({ ...current.manifest, scanRoots: roots });
    const module = await catalog();
    expect(() => module.readProposalCatalog(current.input)).toThrow();
  });

  it.each(['scope', 'commit', 'root', 'digest', 'wrong-category', 'extra', 'duplicate-ref', 'duplicate-name', 'duplicate-source', 'source-less'] as const)(
    'rejects an unbound or ambiguous tool entry: %s', async kind => {
      const current = fixture();
      const entry = current.manifest.tools[0];
      if (kind === 'scope') entry.scope = 'github:other/catalog';
      if (kind === 'commit') entry.expectedCommit = 'b'.repeat(40);
      if (kind === 'root') entry.source.root = current.base;
      if (kind === 'digest') entry.digest = 'b'.repeat(64);
      if (kind === 'wrong-category') entry.kind = 'script';
      if (kind === 'extra') Object.assign(entry, { command: ['node'] });
      if (kind === 'duplicate-ref') current.manifest.tools[1].ref = entry.ref;
      if (kind === 'duplicate-name') current.manifest.tools[1].name = entry.name;
      if (kind === 'duplicate-source') current.manifest.tools[1].source = entry.source;
      if (kind === 'source-less') Reflect.deleteProperty(entry, 'source');
      current.save();
      const module = await catalog();
      expect(() => module.readProposalCatalog(current.input)).toThrow();
    });

  it.each(['missing', 'outside', 'unlisted', 'symlink', 'directory-symlink', 'hardlink', 'invalid-utf8', 'oversize', 'group-writable'] as const)(
    'rejects unsafe source state: %s', async kind => {
      const current = fixture();
      const source = current.toolFiles[0].source.file;
      if (kind === 'missing') filesystem.unlinkSync(source);
      if (kind === 'outside') current.manifest.tools[0].source.file = current.input.file;
      if (kind === 'unlisted') filesystem.writeFileSync(join(current.repositoryRoot, current.manifest.scanRoots.cli, 'hidden.js'), 'hidden');
      if (kind === 'symlink') { filesystem.unlinkSync(source); filesystem.symlinkSync(current.skillFile, source); }
      if (kind === 'directory-symlink') {
        const directory = join(current.repositoryRoot, current.manifest.scanRoots.cli);
        filesystem.renameSync(directory, directory + '-old'); filesystem.symlinkSync(directory + '-old', directory);
      }
      if (kind === 'hardlink') filesystem.linkSync(source, join(current.privateRoot, 'hardlink.js'));
      if (kind === 'invalid-utf8') { const bytes = Buffer.from([0xc3, 0x28]); filesystem.writeFileSync(source, bytes); current.manifest.tools[0].digest = digest(bytes); }
      if (kind === 'oversize') { const bytes = Buffer.alloc(65537, 65); filesystem.writeFileSync(source, bytes); current.manifest.tools[0].digest = digest(bytes); }
      if (kind === 'group-writable') filesystem.chmodSync(source, 0o620);
      current.save();
      const module = await catalog();
      expect(() => module.readProposalCatalog(current.input)).toThrow();
    });

  it.each(['digest', 'symlink', 'hardlink', 'permissions', 'directory-permissions', 'invalid-utf8', 'oversize', 'inside-repository'] as const)(
    'rejects an unsafe operator manifest: %s', async kind => {
      const current = fixture();
      if (kind === 'digest') current.input.digest = 'b'.repeat(64);
      if (kind === 'symlink') { filesystem.renameSync(current.input.file, current.input.file + '-old'); filesystem.symlinkSync(current.input.file + '-old', current.input.file); }
      if (kind === 'hardlink') filesystem.linkSync(current.input.file, current.input.file + '-link');
      if (kind === 'permissions') filesystem.chmodSync(current.input.file, 0o644);
      if (kind === 'directory-permissions') filesystem.chmodSync(current.privateRoot, 0o755);
      if (kind === 'invalid-utf8') { const bytes = Buffer.from([0xc3, 0x28]); filesystem.writeFileSync(current.input.file, bytes); current.input.digest = digest(bytes); }
      if (kind === 'oversize') { const bytes = Buffer.alloc(1024 * 1024 + 1, 32); filesystem.writeFileSync(current.input.file, bytes); current.input.digest = digest(bytes); }
      if (kind === 'inside-repository') { const target = join(current.repositoryRoot, 'catalog.json'); filesystem.copyFileSync(current.input.file, target); current.input.file = target; }
      const module = await catalog();
      expect(() => module.readProposalCatalog(current.input)).toThrow();
    });

  it.each(['source-write', 'source-revert', 'source-replace', 'file-add', 'file-delete', 'directory-add', 'directory-revert', 'directory-replace',
    'manifest-revert', 'manifest-replace', 'root-replace'] as const)('detects post-load readset drift: %s', async kind => {
      const current = fixture();
      const result = (await catalog()).readProposalCatalog(current.input);
      const source = current.toolFiles[0].source.file;
      const directory = join(current.repositoryRoot, current.manifest.scanRoots.cli);
      if (kind === 'source-write') filesystem.appendFileSync(source, '// changed');
      if (kind === 'source-revert') { const before = filesystem.readFileSync(source); filesystem.writeFileSync(source, 'different'); filesystem.writeFileSync(source, before); }
      if (kind === 'source-replace') { const before = filesystem.readFileSync(source); filesystem.unlinkSync(source); filesystem.writeFileSync(source, before); }
      if (kind === 'file-add') filesystem.writeFileSync(join(directory, 'new.js'), 'new');
      if (kind === 'file-delete') filesystem.unlinkSync(source);
      if (kind === 'directory-add') filesystem.mkdirSync(join(directory, 'new'));
      if (kind === 'directory-revert') { filesystem.mkdirSync(join(directory, 'new')); filesystem.rmdirSync(join(directory, 'new')); }
      if (kind === 'directory-replace') { filesystem.renameSync(directory, directory + '-old'); filesystem.mkdirSync(directory); filesystem.copyFileSync(join(directory + '-old', basename(source)), source); }
      if (kind === 'manifest-revert') { const before = filesystem.readFileSync(current.input.file); filesystem.writeFileSync(current.input.file, '{}'); filesystem.writeFileSync(current.input.file, before); }
      if (kind === 'manifest-replace') { const before = filesystem.readFileSync(current.input.file); filesystem.unlinkSync(current.input.file); filesystem.writeFileSync(current.input.file, before, { mode: 0o600 }); }
      if (kind === 'root-replace') { filesystem.renameSync(current.repositoryRoot, current.repositoryRoot + '-old'); filesystem.mkdirSync(current.repositoryRoot); }
      expect(result.assertCurrent).toThrow();
    });

  it.each(['depth', 'entries', 'total-bytes'] as const)('bounds the scan before it can claim coverage: %s', async kind => {
    const current = fixture();
    const root = join(current.repositoryRoot, current.manifest.scanRoots.script);
    if (kind === 'depth') filesystem.mkdirSync(join(root, ...Array.from({ length: 33 }, () => 'deep')), { recursive: true });
    if (kind === 'entries') for (let index = 0; index < 1025; index++) filesystem.mkdirSync(join(root, `entry-${index}`));
    if (kind === 'total-bytes') for (let index = 0; index < 129; index++) {
      const file = join(root, `bytes-${index}`);
      const bytes = Buffer.alloc(65536, 65);
      filesystem.writeFileSync(file, bytes, { mode: 0o600 });
      current.manifest.tools.push({ ...current.toolFiles[1], name: `bytes-${index}`, ref: `script:bytes-${index}`,
        digest: digest(bytes), source: { root: current.repositoryRoot, file } });
    }
    current.save();
    const module = await catalog();
    expect(() => module.readProposalCatalog(current.input)).toThrow();
  });

  it('ignores subsequent caller input mutation while preserving the selected immutable readset', async () => {
    const current = fixture();
    const result = (await catalog()).readProposalCatalog(current.input);
    current.input.scope = 'github:other/catalog'; current.input.repositoryRoot = current.base; current.input.digest = 'b'.repeat(64);
    expect(result.assertCurrent()).toBeUndefined();
  });

  it.each(['source', 'manifest'] as const)('rechecks earlier %s bytes when a later category scan completes', async kind => {
    const current = fixture();
    const module = await catalog();
    const nativeOpen = filesystem.opendirSync;
    let pluginScans = 0;
    let mutated = false;
    vi.spyOn(filesystem, 'opendirSync').mockImplementation((...parameters: Parameters<typeof filesystem.opendirSync>) => {
      if (String(parameters[0]) === join(current.repositoryRoot, current.manifest.scanRoots.plugin) && ++pluginScans === 2) {
        filesystem.appendFileSync(kind === 'source' ? current.toolFiles[0].source.file : current.input.file, ' ');
        mutated = true;
      }
      return nativeOpen(...parameters);
    });
    syncBuiltinESMExports();
    expect(() => module.readProposalCatalog(current.input)).toThrow();
    expect(mutated).toBe(true);
  });

  it('returns a bounded public error without source paths or injected private details', async () => {
    const current = fixture();
    const module = await catalog();
    vi.spyOn(filesystem, 'opendirSync').mockImplementation(() => { throw new Error('PRIVATE_CATALOG_TOKEN'); });
    syncBuiltinESMExports();
    expect(() => module.readProposalCatalog(current.input)).toThrowError('proposal_catalog_unavailable_or_changed');
  });

  it.each(['hardlink', 'single-link'] as const)('rejects %s source replacement at open without reading its FD', async kind => {
    const current = fixture();
    const module = await catalog();
    const file = current.toolFiles[0].source.file;
    const replacement = join(current.privateRoot, 'replacement.js');
    filesystem.writeFileSync(replacement, filesystem.readFileSync(file), { mode: 0o600 });
    const nativeOpen = filesystem.openSync;
    const nativeRead = filesystem.readSync;
    const nativeStat = filesystem.fstatSync;
    const nativeClose = filesystem.closeSync;
    let sourceDescriptor: number | undefined;
    let sourceReadBytes = 0;
    let sourceCloseCount = 0;
    vi.spyOn(filesystem, 'openSync').mockImplementation((...parameters: Parameters<typeof filesystem.openSync>) => {
      if (String(parameters[0]) === file && sourceDescriptor === undefined) {
        filesystem.renameSync(file, join(current.privateRoot, 'original.js'));
        if (kind === 'hardlink') filesystem.linkSync(replacement, file);
        else filesystem.renameSync(replacement, file);
        sourceDescriptor = nativeOpen(...parameters);
        return sourceDescriptor;
      }
      return nativeOpen(...parameters);
    });
    vi.spyOn(filesystem, 'readSync').mockImplementation((...parameters: Parameters<typeof filesystem.readSync>) => {
      const count = Reflect.apply(nativeRead, filesystem, parameters);
      if (parameters[0] === sourceDescriptor) sourceReadBytes += count;
      return count;
    });
    vi.spyOn(filesystem, 'closeSync').mockImplementation(descriptor => {
      if (descriptor === sourceDescriptor) sourceCloseCount += 1;
      nativeClose(descriptor);
    });
    syncBuiltinESMExports();
    expect(() => module.readProposalCatalog(current.input)).toThrowError('proposal_catalog_unavailable_or_changed');
    expect(sourceDescriptor).toBeDefined();
    expect(filesystem.lstatSync(file).nlink).toBe(kind === 'hardlink' ? 2 : 1);
    expect(sourceCloseCount).toBe(1);
    expect(() => nativeStat(sourceDescriptor!)).toThrowError(expect.objectContaining({ code: 'EBADF' }));
    expect(sourceReadBytes, 'untrusted replacement FD bytes must never be read').toBe(0);
  });

  it.each(['growth', 'swap-at-open', 'read-error'] as const)('keeps bounded same-FD reads and finally closes on %s', async kind => {
    const current = fixture();
    const module = await catalog();
    const file = current.toolFiles[0].source.file;
    const originalSize = filesystem.statSync(file).size;
    const nativeOpen = filesystem.openSync;
    const nativeStat = filesystem.fstatSync;
    const nativeRead = filesystem.readSync;
    const opened: number[] = [];
    const sourceDescriptors: number[] = [];
    let mutated = false;
    let sourceReadBytes = 0;
    const open = vi.spyOn(filesystem, 'openSync').mockImplementation((...parameters: Parameters<typeof filesystem.openSync>) => {
      if (String(parameters[0]) === file && kind === 'swap-at-open' && !mutated) {
        mutated = true; filesystem.unlinkSync(file); filesystem.symlinkSync(current.skillFile, file);
      }
      const descriptor = nativeOpen(...parameters);
      opened.push(descriptor);
      if (String(parameters[0]) === file) sourceDescriptors.push(descriptor);
      return descriptor;
    });
    vi.spyOn(filesystem, 'fstatSync').mockImplementation((...parameters: Parameters<typeof filesystem.fstatSync>) => {
      const observed = Reflect.apply(nativeStat, filesystem, parameters);
      if (kind === 'growth' && sourceDescriptors.includes(parameters[0]) && !mutated) {
        mutated = true; filesystem.writeFileSync(file, Buffer.alloc(1024 * 1024, 65));
      }
      return observed;
    });
    vi.spyOn(filesystem, 'readSync').mockImplementation((...parameters: Parameters<typeof filesystem.readSync>) => {
      if (sourceDescriptors.includes(parameters[0]) && kind === 'read-error') throw new Error('injected-read-error');
      const count = Reflect.apply(nativeRead, filesystem, parameters);
      if (sourceDescriptors.includes(parameters[0])) sourceReadBytes += count;
      return count;
    });
    const close = vi.spyOn(filesystem, 'closeSync');
    syncBuiltinESMExports();
    expect(() => module.readProposalCatalog(current.input)).toThrow();
    if (kind !== 'read-error') expect(mutated).toBe(true);
    expect(sourceReadBytes).toBeLessThanOrEqual(originalSize + 1);
    for (const descriptor of new Set(opened)) expect(close.mock.calls.filter(([closed]) => closed === descriptor)).toHaveLength(opened.filter(value => value === descriptor).length);
    for (const call of open.mock.calls.filter(call => typeof call[1] === 'number')) {
      expect(Number(call[1]) & filesystem.constants.O_NOFOLLOW).toBe(filesystem.constants.O_NOFOLLOW);
      expect(Number(call[1]) & filesystem.constants.O_NONBLOCK).toBe(filesystem.constants.O_NONBLOCK);
    }
  });
});
