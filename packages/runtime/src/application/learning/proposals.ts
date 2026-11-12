import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, opendirSync, openSync, readSync, realpathSync, statSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import Ajv from 'ajv';
import { load } from 'js-yaml';
import { z } from 'zod';
import { candidateProposalSchema, DISTILLATION_LIMITS, type CandidateProposal } from './contracts.js';
import { canonicalLearningJson, learningDigestSchema, learningIdentitySchema } from './requests.js';
import type { RepositoryWorkspace, VerificationProvider, VerificationResult, ProviderOperationOptions } from '../../plugin-sdk/capabilities.js';
import type { Sandbox, IsolationLevel } from '../../infrastructure/sandbox/types.js';
import { LocalSandbox } from '../../infrastructure/sandbox/providers/local.js';

export interface ProposalInventory {
  skills: { name: string; description: string; 'disable-model-invocation': boolean; 'user-invocable': boolean;
    'allowed-tools': string | string[]; 'disallowed-tools': string | string[]; source: { root: string; file: string } }[];
  tools: { kind: 'cli' | 'script' | 'plugin'; ref: string; name: string; description: string; provenance: string;
    source?: { root: string; file: string } }[];
  toolSearches: ('cli' | 'script' | 'plugin')[];
}

export interface ProposalCheck {
  id: string;
  kind: 'normal' | 'recovery' | 'refusal' | 'cancellation' | 'timeout' | 'permission-denied';
  input: string;
  expected: string;
}

export function compareProposalActual(actual: unknown, expected: unknown): boolean {
  const encode = (value: unknown): string => {
    let entries = 0;
    const inspect = (entry: unknown, depth: number): void => {
      if (++entries > 4096 || depth > 32) throw new Error('Proposal oracle actual exceeds structure limit');
      if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return;
      if (typeof entry === 'number' && Number.isFinite(entry)) return;
      if (Array.isArray(entry)) { for (const item of entry) inspect(item, depth + 1); return; }
      if (typeof entry !== 'object' || Object.getPrototypeOf(entry) !== Object.prototype) throw new Error('Proposal oracle requires JSON actual and expected');
      for (const item of Object.values(entry)) inspect(item, depth + 1);
    };
    inspect(value, 0);
    const encoded = canonicalLearningJson(value);
    if (Buffer.byteLength(encoded) > DISTILLATION_LIMITS.outputBytes) throw new Error('Proposal oracle actual exceeds byte limit');
    return encoded;
  };
  return encode(actual) === encode(expected);
}

export interface PreparedAssetProposal {
  status: 'verification-prepared';
  kind: 'skill' | 'tool';
  effectiveness: 'not-run';
  proposal: Extract<CandidateProposal, { kind: 'skill' | 'tool' }>;
  artifact: { content: string; digest: string; originalDigest: string | null; targetRef: string | null };
  invocation?: { automatic: boolean; userInvocable: boolean; allowedTools: string | string[]; disallowedTools: string | string[] };
  checks: ProposalCheck[];
  execution: { requiresIsolatedTask: true; autoInstall: false; timeoutMs: number; dependencies: string[]; permissions: string[]; sideEffects: string; idempotency: string; recovery: string };
  search: { query: string; inspected: string[] };
}

export interface ProposalVerificationTask {
  isolation: IsolationLevel;
  artifactPath: string;
  workspace: RepositoryWorkspace;
  sandbox: Pick<Sandbox, 'id' | 'workspacePath' | 'worktreePath'>;
  verification: VerificationProvider;
  harness?: { id: string; command(request: ProposalHarnessRequest): readonly string[] };
}

const receiptBindingSchema = z.object({ executionId: z.string().uuid(), harnessId: learningIdentitySchema,
  checkId: learningIdentitySchema, checkDigest: learningDigestSchema, inputDigest: learningDigestSchema,
  artifactDigest: learningDigestSchema, version: z.enum(['original', 'proposed']), taskDigest: learningDigestSchema,
}).strict();
const receiptSchema = z.object({ version: z.literal(1), binding: receiptBindingSchema,
  result: z.discriminatedUnion('status', [
    z.object({ status: z.literal('executed'), passed: z.boolean(), assertions: z.number().int().positive(),
      actual: z.unknown().refine(value => value !== undefined, 'Actual behavior result is required') }).strict(),
    z.object({ status: z.literal('not-executed'), reason: learningIdentitySchema }).strict(),
    z.object({ status: z.literal('unsupported'), reason: learningIdentitySchema }).strict(),
  ]),
}).strict();

export interface ProposalHarnessRequest {
  binding: z.infer<typeof receiptBindingSchema>;
  check: ProposalCheck;
  artifactPath: string;
  timeoutMs: number;
}

export type ProposalObservation = {
  artifactDigest: string; runId: string; workspaceId: string; sandboxId: string; verifierId: string; taskDigest: string;
} & (
  { status: 'behavior-executed'; passed: boolean; durationMs: number; receipt: z.infer<typeof receiptSchema>; receiptDigest: string;
    execution: { id: string; sandboxId: string; mechanism: 'darwin-seatbelt'; policyDigest: string; snapshotCommit: string;
      argv: readonly string[]; cwd: string; commandDigest: string; inputTreeDigest: string } }
  | { status: 'static-observed'; staticObservation: VerificationResult; passed?: never }
  | { status: 'not-executed' | 'unsupported'; reason: string; passed?: never }
);

const hash = (content: string) => createHash('sha256').update(content).digest('hex');

function inputTreeDigest(workspacePath: string, artifact: string): string {
  const entries: { path: string; kind: 'directory' | 'file' | 'asset'; mode: number; digest?: string }[] = [];
  let count = 0;
  let bytes = 0;
  const chunk = Buffer.alloc(64 * 1024);
  const visit = (directory: string, depth: number): void => {
    if (depth > 32) throw new Error('Proposal input tree exceeds depth limit');
    if (lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory) throw new Error('Proposal input tree refuses symlink directories');
    const handle = opendirSync(directory);
    try {
      let entry;
      while ((entry = handle.readSync())) {
        if (++count > 1024) throw new Error('Proposal input tree exceeds entry count limit');
        const file = resolve(directory, entry.name);
        const path = relative(workspacePath, file);
        if (Buffer.byteLength(path) > 4096) throw new Error('Proposal input tree exceeds path limit');
        const stat = lstatSync(file);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('Proposal input tree refuses symlink or special entries');
        const mode = stat.mode & 0o777;
        if (directory === workspacePath && entry.name === '.git') {
          entries.push({ path, kind: stat.isDirectory() ? 'directory' : 'file', mode });
          continue;
        }
        if (stat.isDirectory()) {
          entries.push({ path, kind: 'directory', mode });
          visit(file, depth + 1);
        } else if (file === artifact) entries.push({ path, kind: 'asset', mode });
        else {
          if (bytes + stat.size > 8 * 1024 * 1024) throw new Error('Proposal input tree exceeds byte limit');
          const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const before = fstatSync(descriptor);
            if (!before.isFile() || before.ino !== stat.ino || before.dev !== stat.dev) throw new Error('Proposal input tree entry changed during scan');
            const digest = createHash('sha256');
            let size = 0;
            let length;
            while ((length = readSync(descriptor, chunk, 0, chunk.length, null))) {
              bytes += length;
              size += length;
              if (bytes > 8 * 1024 * 1024) throw new Error('Proposal input tree exceeds byte limit');
              digest.update(chunk.subarray(0, length));
            }
            const after = fstatSync(descriptor);
            if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
              throw new Error('Proposal input tree entry changed during scan');
            }
            entries.push({ path, kind: 'file', mode, digest: digest.digest('hex') });
          } finally { closeSync(descriptor); }
        }
      }
    } finally { handle.closeSync(); }
  };
  visit(workspacePath, 0);
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return hash(canonicalLearningJson(entries));
}

function sandboxPolicy(sandbox: ProposalVerificationTask['sandbox'], workspacePath: string): string | undefined {
  if (process.platform !== 'darwin' || !(sandbox instanceof LocalSandbox) || !existsSync('/usr/bin/sandbox-exec')) return undefined;
  const literal = (path: string) => `(literal ${JSON.stringify(path)})`;
  const runtime = realpathSync(process.execPath);
  const ancestors = new Set<string>();
  for (const path of [workspacePath, runtime, '/usr/bin/env', '/System/Library', '/usr/lib', '/dev/null']) {
    let parent = dirname(path);
    while (parent !== '/') { ancestors.add(parent); parent = dirname(parent); }
  }
  return ['(version 1)', '(deny default)', '(allow process-fork)',
    `(allow process-exec ${literal(runtime)} ${literal('/usr/bin/env')})`,
    '(allow sysctl-read)',
    `(allow file-read-metadata ${[...ancestors].map(literal).join(' ')})`,
    `(allow file-read* ${literal('/')} (subpath "/System/Library") (subpath "/usr/lib")`,
    ` (subpath ${JSON.stringify(workspacePath)}) ${literal(runtime)} ${literal('/usr/bin/env')} ${literal('/dev/null')} ${literal('/dev/urandom')})`,
    '(allow file-write* (literal "/dev/null"))',
    `(deny file-read* (subpath ${JSON.stringify(resolve(workspacePath, '.git'))}))`,
  ].join('\n');
}

async function runSandboxCommand(sandbox: LocalSandbox, workspacePath: string, policy: string,
  command: readonly string[], timeoutMs: number, options: ProviderOperationOptions) {
  if (realpathSync(command[0]) !== realpathSync(process.execPath)) throw new Error('Isolated proposal harness currently requires the trusted Node runtime');
  const started = performance.now();
  const argv = ['/usr/bin/sandbox-exec', '-p', policy, '/usr/bin/env', '-i',
    `HOME=${workspacePath}`, `TMPDIR=${workspacePath}`, realpathSync(process.execPath), ...command.slice(1)];
  Object.freeze(argv);
  const commandDigest = hash(canonicalLearningJson({ argv, cwd: workspacePath }));
  if (options.signal?.aborted) throw options.signal.reason;
  const execution = await LocalSandbox.prototype.startAgent.call(sandbox, {
    command: { argv, cwd: workspacePath },
    metadata: { provider: 'proposal-harness', transport: 'process' }, executionMode: 'batch',
    generation: 0, prompt: '', signalType: 'goal_complete',
    parseLine: line => {
      try {
        if (receiptSchema.safeParse(JSON.parse(line)).success) return [{ type: 'result', result: '<goal_complete>{"summary":"Case receipt received"}</goal_complete>' }];
      } catch {}
      return [];
    },
  });
  const abort = () => { void execution.kill(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (options.signal?.aborted) throw options.signal.reason;
    const result = await execution.waitForResult({ completionTimeoutMs: timeoutMs });
    if (options.signal?.aborted) throw options.signal.reason;
    return { id: execution.id, argv, cwd: workspacePath, commandDigest,
      passed: result.exitCode === 0 && (result.status === 'completed' || result.error?.code === 'MISSING_RESULT'),
      durationMs: performance.now() - started, output: await execution.captureOutput() };
  } finally {
    options.signal?.removeEventListener('abort', abort);
    await execution.kill();
  }
}

function inside(root: string, file: string): string {
  const resolved = realpathSync(file);
  const distance = relative(realpathSync(root), resolved);
  if (!distance || distance === '..' || distance.startsWith('../') || isAbsolute(distance)) throw new Error('Asset path escapes its trusted root');
  return resolved;
}

function readAsset(root: string, file: string): string {
  const trustedRoot = realpathSync(root);
  const asset = inside(trustedRoot, file);
  const sameIdentity = (before: Stats, after: Stats) => before.dev === after.dev && before.ino === after.ino
    && before.mode === after.mode && before.uid === after.uid;
  const sameFile = (before: Stats, after: Stats) => after.isFile() && sameIdentity(before, after)
    && before.size === after.size && before.nlink === after.nlink
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
  const directories: { path: string; identity: Stats }[] = [];
  let parent = dirname(asset);
  for (;;) {
    const identity = lstatSync(parent);
    if (!identity.isDirectory()) throw new Error('Asset source directory identity changed');
    directories.push({ path: parent, identity });
    if (parent === trustedRoot) break;
    const next = dirname(parent);
    if (next === parent) throw new Error('Asset path escapes its trusted root');
    parent = next;
  }
  const checkPath = () => {
    if (realpathSync(root) !== trustedRoot || inside(trustedRoot, file) !== asset) throw new Error('Asset source path identity changed');
    for (const directory of directories) {
      const current = lstatSync(directory.path);
      if (!current.isDirectory() || !sameIdentity(directory.identity, current)) throw new Error('Asset source directory identity changed');
    }
  };
  const original = lstatSync(asset);
  if (!original.isFile() || original.size > 64 * 1024) throw new Error('Asset source exceeds file limit');
  if (!sameFile(original, statSync(asset))) throw new Error('Asset source identity changed');
  const descriptor = openSync(asset, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!sameFile(original, fstatSync(descriptor))) throw new Error('Asset source identity changed');
    checkPath();
    const buffer = Buffer.alloc(original.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, Math.min(16 * 1024, buffer.length - length), length);
      if (count === 0) break;
      length += count;
    }
    const observed = statSync(asset);
    if (length !== original.size || !sameFile(original, observed)
      || !sameFile(original, lstatSync(asset)) || !sameFile(original, fstatSync(descriptor))) {
      throw new Error('Asset source changed during bounded read');
    }
    checkPath();
    const bytes = buffer.subarray(0, length);
    const source = bytes.toString('utf8');
    if (!Buffer.from(source).equals(bytes)) throw new Error('Asset source must contain valid UTF-8 bytes');
    return source;
  } finally {
    closeSync(descriptor);
  }
}

function matches(query: string, name: string, description: string): boolean {
  const terms = new Set(query.toLowerCase().match(/[\p{L}\p{N}-]{3,}/gu) ?? []);
  return [...terms].some(term => `${name} ${description}`.toLowerCase().includes(term));
}

type ToolInputSchema = Extract<CandidateProposal, { kind: 'tool' }>['payload']['inputSchema'];

function compileSchema(schema: ToolInputSchema) {
  if (Buffer.byteLength(canonicalLearningJson(schema)) > 8192) throw new Error('Tool schema exceeds byte limit');
  const inspect = (value: unknown, depth: number): void => {
    if (depth > 16) throw new Error('Tool schema exceeds depth limit');
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      if (['$ref', '$dynamicRef', 'patternProperties'].includes(key)) throw new Error('Tool schema references and patternProperties are unsupported');
      if (key === 'pattern' && (typeof entry !== 'string' || !/^\^\[[a-zA-Z0-9_.\/-]+\][+*?]?\$$/.test(entry))) {
        throw new Error('Tool schema pattern must be a bounded character class');
      }
      inspect(entry, depth + 1);
    }
  };
  inspect(schema, 0);
  return new Ajv({ strict: true }).compile(schema);
}

function checkParameterPaths(value: unknown): void {
  if (typeof value === 'string' && (/^[/\\]|^[a-zA-Z]:[/\\]|^file:/i.test(value))) throw new Error('Model parameters cannot select absolute paths');
  if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) {
    checkParameterPaths(key);
    checkParameterPaths(entry);
  }
}

export function prepareAssetProposal(input: unknown, inventory: ProposalInventory): PreparedAssetProposal {
  if (Buffer.byteLength(canonicalLearningJson(input)) > DISTILLATION_LIMITS.outputBytes) throw new Error('Asset proposal exceeds byte limit');
  const candidate = candidateProposalSchema.parse(input);
  if (candidate.kind !== 'skill' && candidate.kind !== 'tool') throw new Error('Expected skill or tool candidate');
  const query = `${candidate.title} ${candidate.statement}`;
  let content: string;
  let originalDigest: string | null = null;
  let targetRef = candidate.targetRef ?? null;
  let invocation: PreparedAssetProposal['invocation'];
  let checks: ProposalCheck[];
  let execution: PreparedAssetProposal['execution'];
  let inspected: string[];
  if (candidate.kind === 'skill') {
    const payload = candidate.payload;
    if (!payload.inputs.length || !payload.branches.length || !payload.recovery.length || !payload.prohibitedConditions.length) {
      throw new Error('Skill requires parameters, branches, recovery and prohibited conditions');
    }
    const inputs = payload.evaluationCases.map(entry => entry.input.trim().toLowerCase());
    if (new Set(inputs).size !== inputs.length) throw new Error('Skill behavior cases must have distinct independent inputs');
    const existing = inventory.skills.filter(entry => matches(`${query} ${payload.triggers.join(' ')}`, entry.name, entry.description));
    const target = payload.targetSkill ? inventory.skills.find(entry => `skill:${entry.name}` === payload.targetSkill) : undefined;
    if (payload.targetSkill && !target) throw new Error('Target skill is missing from the existing catalog');
    if (!target && existing.length) throw new Error(`Prefer an existing skill patch: ${existing.map(entry => entry.name).join(', ')}`);
    if (candidate.targetRef && candidate.targetRef !== payload.targetSkill) throw new Error('Skill target differs from catalog target');
    let source = '';
    if (target) {
      source = readAsset(target.source.root, target.source.file);
      originalDigest = hash(source);
      if (originalDigest !== payload.originalDigest) throw new Error('Original skill digest changed');
      targetRef = `skill:${target.name}`;
      const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      if (!frontmatter) throw new Error('Existing skill must retain frontmatter metadata');
      const metadata = z.object({ name: z.literal(target.name), 'disable-model-invocation': z.unknown().optional(), 'user-invocable': z.unknown().optional(),
        'allowed-tools': z.union([z.string(), z.array(z.string())]).optional(), 'disallowed-tools': z.union([z.string(), z.array(z.string())]).optional(),
      }).passthrough().parse(load(frontmatter[1]));
      invocation = { automatic: !target['disable-model-invocation'] && (metadata['disable-model-invocation'] === undefined || metadata['disable-model-invocation'] === false),
        userInvocable: target['user-invocable'] && (metadata['user-invocable'] === undefined || metadata['user-invocable'] === true),
        allowedTools: metadata['allowed-tools'] ?? [], disallowedTools: metadata['disallowed-tools'] ?? [] };
    } else {
      if (payload.originalDigest) throw new Error('A new skill cannot claim an original digest');
      source = `---\nname: candidate-${hash(canonicalLearningJson(candidate)).slice(0, 12)}\ndescription: ${JSON.stringify(candidate.statement)}\ndisable-model-invocation: true\nuser-invocable: false\n---\n`;
      invocation = { automatic: false, userInvocable: false, allowedTools: [], disallowedTools: [] };
    }
    content = `${source}\n## Candidate amendment (requires human review)\n\n${canonicalLearningJson({
      parameters: payload.inputs, triggers: payload.triggers, prohibitedConditions: payload.prohibitedConditions,
      branches: payload.branches, recovery: payload.recovery, completion: payload.completion, proposedChange: payload.patch,
    })}\n`;
    checks = payload.evaluationCases.map((entry, index) => ({ id: `behavior-${index + 1}`, ...entry }));
    execution = { requiresIsolatedTask: true, autoInstall: false, timeoutMs: DISTILLATION_LIMITS.timeoutMs,
      dependencies: [], permissions: [], sideEffects: 'none', idempotency: 'Verification must not change production state', recovery: payload.recovery.join('\n') };
    inspected = inventory.skills.map(entry => `${entry.name}:${entry.source.file}`);
  } else {
    const payload = candidate.payload;
    if (!['cli', 'script', 'plugin'].every(kind => inventory.toolSearches.includes(kind as 'cli' | 'script' | 'plugin'))) throw new Error('Search CLI, script and plugin inventory first');
    if (targetRef) {
      const kind = targetRef.split(':')[0];
      if (!['cli', 'script', 'plugin'].includes(kind)) throw new Error('Explicit tool target must identify a CLI, script or plugin');
      const target = inventory.tools.find(entry => entry.ref === targetRef);
      if (!target || target.kind !== kind) throw new Error('Explicit tool target kind differs from trusted inventory');
      if (!target.source) throw new Error('Explicit tool target requires trusted source bytes');
      originalDigest = hash(readAsset(target.source.root, target.source.file));
    }
    const existing = inventory.tools.filter(entry => payload.existingTools.includes(entry.ref) || payload.existingTools.includes(entry.name)
      || matches(query, entry.name, entry.description));
    if (!targetRef && existing.length) throw new Error(`Reuse existing tools before proposing source: ${existing.map(entry => entry.ref).join(', ')}`);
    if (payload.existingTools.some(ref => !inventory.tools.some(entry => entry.ref === ref || entry.name === ref))) throw new Error('Existing tool claims are absent from searched inventory');
    const validInput = compileSchema(payload.inputSchema);
    const validOutput = compileSchema(payload.outputSchema);
    const normal = payload.tests.filter(entry => entry.kind === 'normal');
    const parameters = normal.map(entry => {
      const value: unknown = JSON.parse(entry.input);
      checkParameterPaths(value);
      if (!validInput(value) || !validOutput(JSON.parse(entry.expected))) throw new Error('Normal tool case does not satisfy input/output schemas');
      return canonicalLearningJson(value);
    });
    if (new Set(parameters).size < 2) throw new Error('Tool verification requires two distinct valid parameter sets');
    const refusals = payload.tests.filter(entry => entry.kind === 'refusal');
    if (!refusals.length || refusals.some(entry => {
      try { return validInput(JSON.parse(entry.input)); } catch { return false; }
    })) throw new Error('Malicious refusal cases must contain schema-invalid input');
    content = payload.source;
    checks = payload.tests.map((entry, index) => ({ id: `behavior-${index + 1}`, ...entry }));
    checks.push(
      { id: 'control-cancellation', kind: 'cancellation', input: 'Cancel before and during execution', expected: 'Execution stops; no further side effects; recovery remains possible' },
      { id: 'control-timeout', kind: 'timeout', input: `Exceed ${payload.timeoutMs}ms`, expected: 'Execution terminates at the deadline; report partial effects' },
      { id: 'control-permission', kind: 'permission-denied', input: 'Deny the declared permissions', expected: 'Refuse without elevation or installation' },
    );
    if (!checks.some(entry => entry.kind === 'recovery')) checks.push({ id: 'control-recovery', kind: 'recovery', input: 'Retry after interrupted execution', expected: `${payload.idempotency}\n${payload.recovery}` });
    execution = { requiresIsolatedTask: true, autoInstall: false, timeoutMs: payload.timeoutMs, dependencies: payload.dependencies,
      permissions: payload.permissions, sideEffects: payload.sideEffects, idempotency: payload.idempotency, recovery: payload.recovery };
    inspected = inventory.tools.map(entry => `${entry.ref}:${entry.provenance}`);
  }
  if (Buffer.byteLength(content) > 64 * 1024) throw new Error('Prepared asset exceeds catalog file limit');
  return { status: 'verification-prepared', kind: candidate.kind, effectiveness: 'not-run', proposal: candidate,
    artifact: { content, digest: hash(content), originalDigest, targetRef }, invocation, checks, execution, search: { query, inspected } };
}

export async function verifyAssetProposal(prepared: PreparedAssetProposal,
  selectTask: (check: ProposalCheck, version: 'original' | 'proposed', options: ProviderOperationOptions) => ProposalVerificationTask | Promise<ProposalVerificationTask>,
  options: ProviderOperationOptions = {},
): Promise<{ status: 'verification-observed'; assurance: 'diagnostic-only'; comparisons: { checkId: string; original?: ProposalObservation; proposed: ProposalObservation }[] }> {
  if (prepared.status !== 'verification-prepared' || hash(prepared.artifact.content) !== prepared.artifact.digest) throw new Error('Prepared artifact digest changed');
  let repositoryKey: string | undefined;
  let sharedInputTree: string | undefined;
  const prepareTask = async (check: ProposalCheck, version: 'original' | 'proposed') => {
    if (options.signal?.aborted) throw options.signal.reason;
    let onAbort!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(options.signal?.reason);
    });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    let selected: ProposalVerificationTask;
    try {
      selected = await Promise.race([Promise.resolve().then(() => {
        if (options.signal?.aborted) throw options.signal.reason;
        return selectTask(Object.freeze({ ...check }), version, options);
      }), interrupted]);
      if (options.signal?.aborted) throw options.signal.reason;
    } finally { options.signal?.removeEventListener('abort', onAbort); }
    const task = { ...selected, workspace: { ...selected.workspace, repository: { ...selected.workspace.repository }, snapshot: { ...selected.workspace.snapshot } },
      sandbox: selected.sandbox, harness: selected.harness ? { ...selected.harness } : undefined };
    if (!['filesystem', 'vm'].includes(task.isolation)) throw new Error('Verification requires filesystem or VM isolation');
    if (!task.workspace.id || !task.workspace.runId || !task.workspace.path || !task.workspace.repository.url || !task.workspace.snapshot.commit
      || !task.sandbox.id || !task.verification.id) throw new Error('Verification requires complete repository and sandbox ownership');
    const workspacePath = realpathSync(task.workspace.path);
    if (workspacePath !== realpathSync(task.sandbox.workspacePath) || workspacePath !== realpathSync(task.sandbox.worktreePath)) {
      throw new Error('Repository workspace and sandbox worktree ownership differ');
    }
    const identity = canonicalLearningJson({ repository: task.workspace.repository, commit: task.workspace.snapshot.commit });
    if (repositoryKey !== undefined && repositoryKey !== identity) throw new Error('Cannot compare tasks with different repository identities, refs or snapshot baseline commits');
    repositoryKey = identity;
    if (isAbsolute(task.artifactPath)) throw new Error('Verification artifact path must be relative to the sandbox');
    const artifact = inside(workspacePath, resolve(workspacePath, task.artifactPath));
    const expectedDigest = version === 'original' ? prepared.artifact.originalDigest : prepared.artifact.digest;
    if (!expectedDigest || hash(readAsset(workspacePath, artifact)) !== expectedDigest) throw new Error('Staged verification artifact digest differs from proposal');
    const treeDigest = inputTreeDigest(workspacePath, artifact);
    if (sharedInputTree !== undefined && treeDigest !== sharedInputTree) throw new Error('Proposal input tree context differs between selected tasks');
    sharedInputTree = treeDigest;
    const policy = sandboxPolicy(task.sandbox, workspacePath);
    const taskDigest = hash(canonicalLearningJson({ workspace: { ...task.workspace, path: workspacePath },
      sandbox: { id: task.sandbox.id, workspacePath, worktreePath: workspacePath }, artifactPath: task.artifactPath,
      isolation: task.isolation, verifierId: task.verification.id, policyDigest: policy ? hash(policy) : null, inputTreeDigest: treeDigest }));
    const context = { artifactDigest: expectedDigest, runId: task.workspace.runId, workspaceId: task.workspace.id,
      sandboxId: task.sandbox.id, verifierId: task.verification.id, taskDigest };
    return { task, check: Object.freeze({ ...check }), version, workspacePath, artifact, context, policy, treeDigest };
  };
  const jobs = [];
  for (const check of prepared.checks) {
    if (prepared.artifact.originalDigest) jobs.push(await prepareTask(check, 'original'));
    jobs.push(await prepareTask(check, 'proposed'));
  }
  const observe = async (job: Awaited<ReturnType<typeof prepareTask>>): Promise<ProposalObservation> => {
    const { task, check, version, workspacePath, artifact, context, policy, treeDigest } = job;
    const checkArtifact = () => {
      if (task.sandbox.id !== context.sandboxId || realpathSync(task.sandbox.workspacePath) !== workspacePath
        || realpathSync(task.sandbox.worktreePath) !== workspacePath) throw new Error('Sandbox ownership changed after task selection');
      if (inside(workspacePath, resolve(workspacePath, task.artifactPath)) !== artifact || hash(readAsset(workspacePath, artifact)) !== context.artifactDigest) {
        throw new Error('Verification changed the staged artifact digest');
      }
      if (inputTreeDigest(workspacePath, artifact) !== treeDigest) throw new Error('Proposal input tree context changed after task selection');
    };
    if (options.signal?.aborted) throw options.signal.reason;
    checkArtifact();
    const staticOnly = task.verification.capabilities['static-analysis'] && !task.verification.capabilities['test-execution'];
    if (!staticOnly && !task.verification.capabilities['test-execution']) return { ...context, status: 'unsupported', reason: 'Provider does not support behavior execution' };
    if (!task.harness) return { ...context, status: 'not-executed', reason: 'No trusted case harness selected' };
    if (!policy || !(task.sandbox instanceof LocalSandbox)) return { ...context, status: 'unsupported', reason: 'No supported OS-enforced sandbox execution capability' };
    const binding = Object.freeze(receiptBindingSchema.parse({ executionId: randomUUID(), harnessId: task.harness.id,
      checkId: check.id, checkDigest: hash(canonicalLearningJson(check)), inputDigest: hash(check.input),
      artifactDigest: context.artifactDigest, version, taskDigest: context.taskDigest }));
    const command = task.harness.command(Object.freeze({ binding, check, artifactPath: task.artifactPath, timeoutMs: prepared.execution.timeoutMs }));
    if (!Array.isArray(command) || !command[0]?.trim() || command.some(argument => typeof argument !== 'string' || argument.includes('\0'))) {
      throw new Error('Trusted harness must select an argv command');
    }
    checkArtifact();
    const result = await runSandboxCommand(task.sandbox, workspacePath, policy, command, prepared.execution.timeoutMs, options);
    if (options.signal?.aborted) throw options.signal.reason;
    checkArtifact();
    if (staticOnly) return { ...context, status: 'static-observed', staticObservation: { passed: result.passed, durationMs: result.durationMs, output: result.output } };
    let raw: unknown;
    try {
      if (!result.output || Buffer.byteLength(result.output) > DISTILLATION_LIMITS.outputBytes) throw new Error();
      raw = JSON.parse(result.output);
    } catch { return { ...context, status: 'not-executed', reason: 'Harness returned no valid case receipt' }; }
    const parsed = receiptSchema.safeParse(raw);
    if (!parsed.success) return { ...context, status: 'not-executed', reason: 'Harness returned no valid case receipt' };
    const receipt = parsed.data;
    if (canonicalLearningJson(receipt.binding) !== canonicalLearningJson(binding)) throw new Error('Harness receipt binding differs from selected case, input, artifact or task');
    if (receipt.result.status !== 'executed') return { ...context, status: receipt.result.status, reason: receipt.result.reason };
    if (receipt.result.passed && !result.passed) throw new Error('Harness receipt claims success despite verifier failure');
    const execution = Object.freeze({ id: result.id, sandboxId: task.sandbox.id, mechanism: 'darwin-seatbelt' as const,
      policyDigest: hash(policy), snapshotCommit: task.workspace.snapshot.commit, argv: result.argv,
      cwd: result.cwd, commandDigest: result.commandDigest, inputTreeDigest: treeDigest });
    return { ...context, status: 'behavior-executed', passed: receipt.result.passed, durationMs: result.durationMs,
      receipt, execution, receiptDigest: hash(canonicalLearningJson({ receipt, execution })) };
  };
  const comparisons = [];
  let index = 0;
  for (const check of prepared.checks) {
    const original = prepared.artifact.originalDigest ? await observe(jobs[index++]) : undefined;
    const proposed = await observe(jobs[index++]);
    comparisons.push({ checkId: check.id, original, proposed });
  }
  if (options.signal?.aborted) throw options.signal.reason;
  return { status: 'verification-observed', assurance: 'diagnostic-only', comparisons };
}
