import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, realpathSync, type BigIntStats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { learningScopeSchema } from './contracts.js';
import type { ProposalInventory } from './proposals.js';
import { canonicalLearningJson, learningDigestSchema, learningIdentitySchema } from './requests.js';
import { readValidationPrivateFile, readValidationSnapshotFile } from './validation-files.js';

const LIMITS = { manifest: 1024 * 1024, asset: 64 * 1024, depth: 32, entries: 1024, bytes: 8 * 1024 * 1024 } as const;
const kinds = ['skills', 'cli', 'script', 'plugin'] as const;
const absolutePath = z.string().min(1).max(4096).refine(value => isAbsolute(value) && resolve(value) === value && !/[\\\0\r\n]/.test(value));
const relativePath = z.string().min(1).max(4096).refine(value => !isAbsolute(value) && !/[\\\0\r\n]/.test(value)
  && !value.split('/').some(part => !part || ['.', '..', '.git'].includes(part)));
const commitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const inputSchema = z.object({ scope: learningScopeSchema, repositoryRoot: absolutePath, expectedCommit: commitSchema,
  file: absolutePath, digest: learningDigestSchema }).strict();
const sourceSchema = z.object({ root: absolutePath, file: absolutePath }).strict();
const toolsDeclaration = z.union([z.string().max(4096), z.array(learningIdentitySchema).max(64)]);
const skillSchema = z.object({ scope: learningScopeSchema, expectedCommit: commitSchema, digest: learningDigestSchema,
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), description: z.string().min(1).max(4096),
  'disable-model-invocation': z.boolean(), 'user-invocable': z.boolean(),
  'allowed-tools': toolsDeclaration, 'disallowed-tools': toolsDeclaration, source: sourceSchema,
  resources: z.array(z.object({ path: relativePath, digest: learningDigestSchema }).strict()).min(1).max(LIMITS.entries).optional(),
}).strict();
const toolSchema = z.object({ scope: learningScopeSchema, expectedCommit: commitSchema, digest: learningDigestSchema,
  kind: z.enum(['cli', 'script', 'plugin']), ref: learningIdentitySchema, name: learningIdentitySchema,
  description: z.string().min(1).max(4096), provenance: learningIdentitySchema, source: sourceSchema }).strict()
  .refine(value => value.ref.startsWith(`${value.kind}:`) && /^(?:cli|script|plugin):[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value.ref)
    && !value.ref.split(/[/:]/).some(part => part === '.' || part === '..'));
const manifestSchema = z.object({ version: z.literal(1), scope: learningScopeSchema, repositoryRoot: absolutePath,
  expectedCommit: commitSchema, scanRoots: z.object({ skills: relativePath, cli: relativePath, script: relativePath, plugin: relativePath }).strict(),
  skills: z.array(skillSchema).max(LIMITS.entries), tools: z.array(toolSchema).max(LIMITS.entries) }).strict();

export type ProposalCatalogInput = z.infer<typeof inputSchema>;
export interface ProposalCatalogScanEntry {
  path: string;
  kind: 'directory' | 'file';
  fingerprint: string;
  digest?: string;
  bytes?: number;
}
export interface ProposalCatalogScanReceipt {
  scannerRevision: 'proposal-catalog-v1';
  scope: string;
  repositoryRoot: string;
  expectedCommit: string;
  kind: typeof kinds[number];
  root: string;
  entries: ProposalCatalogScanEntry[];
  digest: string;
}
export interface ProposalCatalog {
  inventory: ProposalInventory;
  digest: string;
  fingerprint: string;
  inventoryDigest: string;
  manifestFingerprint: string;
  scanReceipts: ProposalCatalogScanReceipt[];
  assertCurrent(): void;
}

const hashBytes = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const hashJson = (value: unknown): string => hashBytes(canonicalLearningJson(value));
const compare = (first: string, second: string): number => first < second ? -1 : first > second ? 1 : 0;
const within = (root: string, file: string): boolean => {
  const distance = relative(root, file);
  return distance !== '' && distance !== '..' && !distance.startsWith(`..${sep}`) && !isAbsolute(distance);
};
const fingerprint = (stats: BigIntStats, full = true): string => hashJson((full
  ? [stats.dev, stats.ino, stats.mode, stats.uid, stats.gid, stats.nlink, stats.size, stats.mtimeNs, stats.ctimeNs, stats.birthtimeNs]
  : [stats.dev, stats.ino, stats.mode, stats.uid, stats.gid]).map(value => String(value)));
function fail(): never { throw new Error('proposal_catalog_unavailable_or_changed'); }

interface ReadState {
  input: ProposalCatalogInput;
  directories: Map<string, { full: boolean; fingerprint: string }>;
  files: Map<string, { fingerprint: string; identity: string }>;
  entries: number;
  bytes: number;
}

function directoryState(path: string, state: ReadState): string {
  const stats = lstatSync(path, { bigint: true });
  if (!stats.isDirectory() || realpathSync(path) !== path) fail();
  const full = path === state.input.repositoryRoot || within(state.input.repositoryRoot, path) || path === dirname(state.input.file);
  if (full && ((stats.mode & 0o022n) !== 0n || (process.getuid && stats.uid !== BigInt(process.getuid())))) fail();
  if (path === dirname(state.input.file) && (stats.mode & 0o077n) !== 0n) fail();
  const current = fingerprint(stats, full);
  const pinned = state.directories.get(path);
  if (pinned && pinned.fingerprint !== current) fail();
  state.directories.set(path, { full, fingerprint: current });
  return current;
}

function checkParents(file: string, state: ReadState): void {
  let parent = dirname(file);
  for (;;) {
    directoryState(parent, state);
    const next = dirname(parent);
    if (parent === next) break;
    parent = next;
  }
}

function readPinned(file: string, limit: number, state: ReadState, privateFile = false): { text: string; digest: string; fingerprint: string; bytes: number } {
  absolutePath.parse(file);
  checkParents(file, state);
  const before = lstatSync(file, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limit) || before.size < 0n
    || (before.mode & (privateFile ? 0o077n : 0o022n)) !== 0n || (process.getuid && before.uid !== BigInt(process.getuid()))
    || realpathSync(file) !== file) fail();
  if (!privateFile && state.bytes + Number(before.size) > LIMITS.bytes) fail();
  const beforeIdentity = fingerprint(before);
  const bytes = privateFile ? readValidationPrivateFile(file).bytes
    : readValidationSnapshotFile(file, state.input.repositoryRoot, limit, { dev: before.dev, ino: before.ino });
  if (bytes.length !== Number(before.size) || bytes.length > limit || fingerprint(lstatSync(file, { bigint: true })) !== beforeIdentity
    || realpathSync(file) !== file) fail();
  checkParents(file, state);
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const digest = hashBytes(bytes);
  const observed = hashJson([file, beforeIdentity, digest]);
  state.files.set(file, { fingerprint: observed, identity: beforeIdentity });
  if (!privateFile) state.bytes += bytes.length;
  return { text, digest, fingerprint: observed, bytes: bytes.length };
}

function assertReadState(state: ReadState): void {
  for (const [path, pinned] of state.files) {
    if (fingerprint(lstatSync(path, { bigint: true })) !== pinned.identity || realpathSync(path) !== path) fail();
  }
  for (const [path, pinned] of state.directories) {
    if (fingerprint(lstatSync(path, { bigint: true }), pinned.full) !== pinned.fingerprint || realpathSync(path) !== path) fail();
  }
}

function readSnapshot(input: ProposalCatalogInput) {
  const state: ReadState = { input, directories: new Map(), files: new Map(), entries: 0, bytes: 0 };
  const home = resolve(homedir());
  if (input.repositoryRoot === home || within(input.repositoryRoot, home) || dirname(input.repositoryRoot) === input.repositoryRoot
    || input.file === input.repositoryRoot || within(input.repositoryRoot, input.file)) fail();
  checkParents(input.repositoryRoot, state);
  directoryState(input.repositoryRoot, state);
  const manifestFile = readPinned(input.file, LIMITS.manifest, state, true);
  if (manifestFile.digest !== input.digest) fail();
  const manifest = manifestSchema.parse(JSON.parse(manifestFile.text));
  if (manifest.scope !== input.scope || manifest.repositoryRoot !== input.repositoryRoot || manifest.expectedCommit !== input.expectedCommit) fail();
  const roots = kinds.map(kind => ({ kind, path: join(input.repositoryRoot, manifest.scanRoots[kind]) }));
  for (const [index, root] of roots.entries()) for (const other of roots.slice(index + 1)) {
    if (root.path === other.path || within(root.path, other.path) || within(other.path, root.path)) fail();
  }
  const declared = new Map<string, { kind: typeof kinds[number]; digest: string }>();
  const names = new Set<string>();
  const refs = new Set<string>();
  for (const entry of [...manifest.skills, ...manifest.tools]) {
    const kind = 'kind' in entry ? entry.kind : 'skills';
    const scanRoot = roots.find(root => root.kind === kind)!;
    if (entry.scope !== input.scope || entry.expectedCommit !== input.expectedCommit || entry.source.root !== input.repositoryRoot
      || !within(scanRoot.path, entry.source.file) || declared.has(entry.source.file) || names.has(entry.name)) fail();
    if (kind === 'skills' && basename(entry.source.file) !== 'SKILL.md') fail();
    if ('ref' in entry) { if (refs.has(entry.ref)) fail(); refs.add(entry.ref); }
    declared.set(entry.source.file, { kind, digest: entry.digest });
    names.add(entry.name);
  }
  for (const skill of manifest.skills) for (const resource of skill.resources ?? []) {
    const owner = dirname(skill.source.file);
    const file = join(owner, resource.path);
    if (!within(owner, file) || basename(file).toLowerCase() === 'skill.md' || declared.has(file) || declared.size >= LIMITS.entries) fail();
    for (let parent = dirname(file); parent !== owner; parent = dirname(parent)) {
      if (declared.has(join(parent, 'SKILL.md'))) fail();
    }
    declared.set(file, { kind: 'skills', digest: resource.digest });
  }
  if (declared.size > LIMITS.entries) fail();
  const found = new Set<string>();
  const receipts: ProposalCatalogScanReceipt[] = [];
  for (const root of roots) {
    const entries: ProposalCatalogScanEntry[] = [];
    const visit = (directory: string): void => {
      if (relative(input.repositoryRoot, directory).split(sep).length > LIMITS.depth || ++state.entries > LIMITS.entries) fail();
      checkParents(directory, state);
      const identity = directoryState(directory, state);
      entries.push({ path: relative(input.repositoryRoot, directory), kind: 'directory', fingerprint: identity });
      const descriptor = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_DIRECTORY);
      try {
        if (fingerprint(fstatSync(descriptor, { bigint: true })) !== identity) fail();
        const handle = opendirSync(directory);
        try {
          let child;
          while ((child = handle.readSync())) {
            const file = join(directory, child.name);
            relativePath.parse(relative(input.repositoryRoot, file));
            const stats = lstatSync(file, { bigint: true });
            if (stats.isDirectory()) visit(file);
            else {
              if (++state.entries > LIMITS.entries || !stats.isFile()) fail();
              const declaration = declared.get(file);
              if (!declaration || declaration.kind !== root.kind) fail();
              const source = readPinned(file, LIMITS.asset, state);
              if (source.digest !== declaration.digest) fail();
              found.add(file);
              entries.push({ path: relative(input.repositoryRoot, file), kind: 'file', fingerprint: source.fingerprint,
                digest: source.digest, bytes: source.bytes });
            }
          }
        } finally { handle.closeSync(); }
        if (fingerprint(fstatSync(descriptor, { bigint: true })) !== identity || directoryState(directory, state) !== identity) fail();
      } finally { closeSync(descriptor); }
    };
    visit(root.path);
    entries.sort((first, second) => compare(first.path, second.path));
    const receipt = { scannerRevision: 'proposal-catalog-v1' as const, scope: input.scope, repositoryRoot: input.repositoryRoot,
      expectedCommit: input.expectedCommit, kind: root.kind, root: root.path, entries };
    receipts.push({ ...receipt, digest: hashJson(receipt) });
  }
  if (found.size !== declared.size) fail();
  assertReadState(state);
  const inventory: ProposalInventory = {
    skills: manifest.skills.map(({ scope, expectedCommit, digest, resources, ...entry }) => ({ ...entry,
      ...(resources === undefined ? {} : { resources: resources.sort((first, second) => compare(first.path, second.path)) }),
    })).sort((first, second) => compare(first.name, second.name)),
    tools: manifest.tools.map(({ scope, expectedCommit, digest, ...entry }) => entry).sort((first, second) =>
      kinds.indexOf(first.kind) - kinds.indexOf(second.kind) || compare(first.ref, second.ref)),
    toolSearches: ['cli', 'script', 'plugin'],
  };
  const result = { inventory, inventoryDigest: hashJson(inventory), manifestFingerprint: manifestFile.fingerprint, scanReceipts: receipts };
  const binding = hashJson({ ...result, directories: [...state.directories].sort(([first], [second]) => compare(first, second)),
    files: [...state.files].sort(([first], [second]) => compare(first, second)) });
  return { result, binding };
}

function freezeData(value: object): void {
  for (const entry of Object.values(value)) if (entry !== null && typeof entry === 'object') freezeData(entry);
  Object.freeze(value);
}

export function readProposalCatalog(input: ProposalCatalogInput): ProposalCatalog {
  try {
    const selected = inputSchema.parse(input);
    const initial = readSnapshot(selected);
    const assertCurrent = (): void => {
      try { if (readSnapshot(selected).binding !== initial.binding) fail(); } catch { fail(); }
    };
    assertCurrent();
    freezeData(initial.result);
    return Object.freeze({ ...initial.result, digest: initial.result.inventoryDigest, fingerprint: initial.binding, assertCurrent });
  } catch { return fail(); }
}
