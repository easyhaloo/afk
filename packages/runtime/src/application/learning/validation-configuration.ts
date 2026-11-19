import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { frozenCheckerConfigurationSchema } from '../../infrastructure/verification/frozen-command.js';
import { DISTILLATION_LIMITS, learningScopeSchema } from './contracts.js';
import { proposalSemanticConfigurationSchema } from './proposal-semantics.js';
import { canonicalLearningJson, learningDigestSchema, learningIdentitySchema } from './requests.js';
import { lessonQaConfigurationSchema } from './validation-input.js';
import { factWorkspaceSchema } from './execution-ownership.js';

export { factWorkspaceSchema } from './execution-ownership.js';

const savedPath = z.string().min(1).max(4096).refine(value => isAbsolute(value) && resolve(value) === value && !/[\0\r\n]/.test(value));
const relativePath = z.string().min(1).max(4096).refine(value => !isAbsolute(value) && !/[\\\0\r\n]/.test(value)
  && !value.split('/').some(part => !part || part === '.' || part === '..'));
const sourceSchema = z.object({ id: learningIdentitySchema, kind: z.enum(['audit', 'journal', 'session']), path: savedPath,
  allowedRoot: savedPath, provider: z.enum(['claude-code', 'codex', 'opencode']).optional(),
  format: z.enum(['jsonl', 'json', 'text']).optional(), runId: learningIdentitySchema.optional(),
  range: z.object({ start: z.number().int().positive(), end: z.number().int().positive() }).strict()
    .refine(value => value.end >= value.start).optional(),
}).strict().refine(value => value.kind !== 'audit' || value.runId !== undefined);
const evidenceSchema = z.array(z.object({ digest: learningDigestSchema, sources: z.array(sourceSchema).min(1).max(64)
  .refine(sources => new Set(sources.map(source => source.id)).size === sources.length) }).strict()).min(1).max(64)
  .refine(entries => new Set(entries.map(entry => entry.digest)).size === entries.length);
const knowledgeCheckerSchema = z.object({ scope: learningScopeSchema, checkerId: learningIdentitySchema,
  providerId: learningIdentitySchema, version: learningIdentitySchema, authorizationFile: savedPath,
  allowLessonValidation: z.boolean().optional(),
  qa: lessonQaConfigurationSchema.extend({ root: savedPath }).optional(),
  target: z.object({ ref: learningIdentitySchema, root: savedPath, path: relativePath }).strict(),
  factAuthorityPaths: z.array(relativePath).min(1).max(16).refine(paths => new Set(paths).size === paths.length).optional(),
  evidence: evidenceSchema.optional(),
}).strict();

const factExecutionSchema = z.object({ command: z.array(z.string().max(4096).refine(value => !value.includes('\0'))).min(1).max(64)
  .refine(command => savedPath.safeParse(command[0]).success), timeoutMs: z.number().int().positive().max(DISTILLATION_LIMITS.timeoutMs),
  checkerFiles: z.array(z.object({ path: savedPath, digest: learningDigestSchema }).strict()).max(64)
    .refine(files => new Set(files.map(file => file.path)).size === files.length), workspace: factWorkspaceSchema,
  frozen: frozenCheckerConfigurationSchema.optional(),
}).strict().refine(value => value.frozen
  ? value.checkerFiles.length === 0 && posix.isAbsolute(value.command[0]) && posix.normalize(value.command[0]) === value.command[0]
    && value.command.includes('/workspace/.verification-request.json') && value.command.includes('/workspace/.verification-target.json')
  : value.checkerFiles.some(file => file.path === value.command[0]));
const factCommandCheckerSchema = knowledgeCheckerSchema.extend({ mode: z.literal('fact-command'), kind: z.literal('fact'),
  qa: z.never().optional(), allowLessonValidation: z.never().optional(), executionAuthorizationFile: savedPath,
  execution: factExecutionSchema }).strict();
export type FactCommandCheckerConfiguration = z.infer<typeof factCommandCheckerSchema>;
export const factExecutionGrantSchema = z.object({ version: z.literal(1), purpose: z.literal('fact-validation-execution'),
  revoked: z.boolean(), scope: learningScopeSchema, checkerId: learningIdentitySchema, checkerVersion: learningIdentitySchema,
  checkerDigest: learningDigestSchema, kind: z.literal('fact'), execution: factExecutionSchema }).strict();

const assetPath = relativePath.refine(value => !value.split('/').includes('.git'));
const absoluteAssetPath = savedPath.refine(value => !value.includes('\\'));
const repositorySchema = z.object({ providerId: learningIdentitySchema,
  repository: z.object({ url: learningIdentitySchema, ref: learningIdentitySchema.optional() }).strict(),
  root: absoluteAssetPath, expectedCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
}).strict();
const assetSchema = z.object({ ref: learningIdentitySchema
  .refine(value => /^(?:cli|script|plugin|skill):[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
    && !value.split(/[/:]/).some(part => part === '.' || part === '..')).nullable(),
  path: assetPath }).strict();
const sandboxSchema = z.object({ engine: z.literal('docker'), baseImageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  scratchHelper: z.object({ path: absoluteAssetPath, digest: learningDigestSchema }).strict().optional() }).strict();
const adapterIdSchema = z.enum(['node-json-argv-v1', 'skill-trace-v1']);

function boundedJson(value: unknown): boolean {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  const addBytes = (amount: number): boolean => (bytes += amount) <= DISTILLATION_LIMITS.outputBytes;
  const inspect = (entry: unknown, depth: number): boolean => {
    if (++nodes > 4096 || depth > 32) return false;
    if (entry === null || typeof entry === 'boolean') return addBytes(entry === null ? 4 : entry ? 4 : 5);
    if (typeof entry === 'string') return entry.length <= DISTILLATION_LIMITS.outputBytes && addBytes(Buffer.byteLength(JSON.stringify(entry)));
    if (typeof entry === 'number') return Number.isFinite(entry) && addBytes(Buffer.byteLength(JSON.stringify(entry)));
    if (typeof entry !== 'object' || ancestors.has(entry)) return false;
    const array = Array.isArray(entry);
    if (Object.getPrototypeOf(entry) !== (array ? Array.prototype : Object.prototype)) return false;
    const keys = Reflect.ownKeys(entry);
    if (keys.length > 4097 || !addBytes(2)) return false;
    ancestors.add(entry);
    if (array) {
      if (keys.length !== entry.length + 1 || entry.length > 4096) return false;
      for (let index = 0; index < entry.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(entry, String(index));
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)
          || (index > 0 && !addBytes(1)) || !inspect(descriptor.value, depth + 1)) return false;
      }
    } else {
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index];
        if (typeof key !== 'string' || key.length > DISTILLATION_LIMITS.outputBytes) return false;
        const descriptor = Object.getOwnPropertyDescriptor(entry, key);
        if (!descriptor?.enumerable || !('value' in descriptor) || (index > 0 && !addBytes(1))
          || !addBytes(Buffer.byteLength(JSON.stringify(key)) + 1) || !inspect(descriptor.value, depth + 1)) return false;
      }
    }
    ancestors.delete(entry);
    return true;
  };
  try { return inspect(value, 0); } catch { return false; }
}

const semanticExperimentSchema = proposalSemanticConfigurationSchema.extend({ adapter: adapterIdSchema }).superRefine((value, context) => {
  const reject = () => context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid configured semantic contract' });
  if (new Set(value.assertions.map(assertion => assertion.id)).size !== value.assertions.length) reject();
  for (const assertion of value.assertions) {
    if (!boundedJson(assertion.expected)) reject();
    if (assertion.path !== undefined && !['stdout-json', 'stderr-json', 'control'].includes(assertion.source)) reject();
    if (assertion.source === 'exit-code' && (!Number.isSafeInteger(assertion.expected)
      || Number(assertion.expected) < 0 || Number(assertion.expected) > 255)) reject();
  }
  const controlled = value.kind === 'cancellation' || value.kind === 'timeout';
  const recovering = value.kind === 'recovery';
  if (value.recovery !== undefined && !recovering) reject();
  if (!controlled && !recovering && value.callInput !== undefined) reject();
  if (value.callInput !== undefined) {
    try { if (!boundedJson(JSON.parse(value.callInput))) reject(); } catch { reject(); }
  }
  if (value.recovery !== undefined) {
    if (value.callInput === undefined || value.callInput === value.recovery.callInput) reject();
    try { if (!boundedJson(JSON.parse(value.recovery.callInput))) reject(); } catch { reject(); }
  }
  if (controlled ? value.control?.kind !== value.kind : value.control !== undefined || value.assertions.some(assertion => assertion.source === 'control')) reject();
  const exits = value.assertions.filter(assertion => assertion.source === 'exit-code');
  if (exits.length !== 1 || !value.assertions.some(assertion => assertion.source !== 'exit-code')) reject();
  else if (controlled ? exits[0].expected !== 137 : value.kind === 'normal' || value.recovery !== undefined ? exits[0].expected !== 0
    : value.kind === 'refusal' && exits[0].expected === 0) reject();
  if (controlled && !value.assertions.some(assertion => assertion.source === 'control')) reject();
  if (value.kind === 'normal') {
    try { if (!boundedJson(JSON.parse(value.input))) reject(); } catch { reject(); }
  }
});
const semanticSchema = z.object({ protocol: z.literal('proposal-semantic-v1'), adapter: adapterIdSchema,
  revision: learningIdentitySchema, cases: z.array(z.object({ checkId: learningIdentitySchema, checkDigest: learningDigestSchema,
    experiment: semanticExperimentSchema }).strict()).min(1).max(16)
    .refine(cases => new Set(cases.map(entry => entry.checkId)).size === cases.length),
}).strict().refine(value => value.cases.every(entry => entry.experiment.adapter === value.adapter));

function matchesAssetKind(kind: 'tool' | 'skill', ref: string | null, adapter: z.infer<typeof adapterIdSchema>): boolean {
  return kind === 'tool' ? adapter === 'node-json-argv-v1' && (ref === null || /^(?:cli|script|plugin):/.test(ref))
    : adapter === 'skill-trace-v1' && (ref === null || ref.startsWith('skill:'));
}

const skillLoadSchema = z.object({ protocol: z.literal('claude-explicit-load-v1'), adapter: z.literal('skill-trace-v1'),
  revision: learningIdentitySchema, hostBinaryDigest: learningDigestSchema,
  hostControls: z.object({ observerDigest: learningDigestSchema, cases: z.array(z.object({ checkId: learningIdentitySchema,
    checkDigest: learningDigestSchema, denied: assetPath, fallback: assetPath.optional() }).strict()).min(2).max(16)
    .refine(cases => new Set(cases.map(entry => entry.checkId)).size === cases.length) }).strict().optional(),
  cases: z.array(z.object({ checkId: learningIdentitySchema, checkDigest: learningDigestSchema, resource: assetPath }).strict())
    .min(1).max(16).refine(cases => new Set(cases.map(entry => entry.checkId)).size === cases.length),
}).strict();

const skillObservationSchema = z.object({ grantDigest: learningDigestSchema, hostBinaryDigest: learningDigestSchema,
  hostTrace: z.object({ source: z.literal('claude-seatbelt-loopback-read-v1'), observerDigest: learningDigestSchema,
    runs: z.array(z.object({ edition: z.enum(['original', 'proposed']), checkId: learningIdentitySchema, snapshotDigest: learningDigestSchema,
      expandedBodyDigest: learningDigestSchema, events: z.array(z.discriminatedUnion('outcome', [
        z.object({ outcome: z.literal('denied'), path: assetPath }).strict(),
        z.object({ outcome: z.literal('read'), path: assetPath, digest: learningDigestSchema }).strict(),
      ])).min(1).max(2) }).strict()).min(2).max(32) }).strict().optional(),
  loads: z.array(z.object({ edition: z.enum(['original', 'proposed']), checkId: learningIdentitySchema,
    artifactDigest: learningDigestSchema, inputDigest: learningDigestSchema, expandedBodyDigest: learningDigestSchema,
    resource: assetPath, resourceDigest: learningDigestSchema }).strict()).min(2).max(32),
}).strict();

const assetCheckerSchema = z.object({ mode: z.literal('repository-asset'), scope: learningScopeSchema,
  checkerId: learningIdentitySchema, version: learningIdentitySchema, kind: z.enum(['tool', 'skill']),
  executionAuthorizationFile: absoluteAssetPath, repository: repositorySchema, asset: assetSchema,
  inventory: z.object({ file: absoluteAssetPath, digest: learningDigestSchema }).strict(), sandbox: sandboxSchema,
  semantic: z.union([semanticSchema, skillLoadSchema]), evidence: evidenceSchema.optional(),
}).strict().refine(value => matchesAssetKind(value.kind, value.asset.ref, value.semantic.adapter))
  .refine(value => value.semantic.protocol === 'claude-explicit-load-v1' || !value.semantic.cases.some(entry => entry.experiment.recovery !== undefined) || value.sandbox.scratchHelper !== undefined)
  .refine(value => value.semantic.protocol === 'claude-explicit-load-v1' || value.kind !== 'skill' || value.semantic.cases.every(entry => ['normal', 'refusal', 'recovery'].includes(entry.experiment.kind)))
  .refine(value => {
    const location = relative(value.repository.root, value.executionAuthorizationFile);
    return isAbsolute(location) || location === '..' || location.startsWith(`..${sep}`);
  });
const scopedUnique = (checkers: { scope: string; checkerId: string }[]): boolean =>
  new Set(checkers.map(checker => canonicalLearningJson([checker.scope, checker.checkerId]))).size === checkers.length;

export const validationConfigurationSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), checkers: z.array(knowledgeCheckerSchema).min(1).max(64).refine(scopedUnique) }).strict(),
  z.object({ version: z.literal(2), checkers: z.array(z.union([
    knowledgeCheckerSchema.extend({ mode: z.literal('knowledge') }), assetCheckerSchema, factCommandCheckerSchema,
  ])).min(1).max(64).refine(scopedUnique) }).strict(),
]);
export type ValidationConfiguration = z.infer<typeof validationConfigurationSchema>;
export type KnowledgeValidationCheckerConfiguration = z.infer<typeof knowledgeCheckerSchema> | FactCommandCheckerConfiguration;

export function selectKnowledgeValidationChecker(config: ValidationConfiguration, scope: string, checkerId: string): KnowledgeValidationCheckerConfiguration | undefined {
  if (config.version === 1) return config.checkers.find(checker => checker.scope === scope && checker.checkerId === checkerId);
  const entry = config.checkers.find(checker => (checker.mode === 'knowledge' || checker.mode === 'fact-command') && checker.scope === scope && checker.checkerId === checkerId);
  if (entry?.mode === 'fact-command') return entry;
  if (entry?.mode !== 'knowledge') return undefined;
  const { mode, ...knowledge } = entry;
  return knowledge;
}

export const proposalExecutionGrantSchema = z.object({ version: z.literal(1), purpose: z.literal('proposal-validation-execution'),
  skillObservation: skillObservationSchema.optional(),
  revoked: z.boolean(), scope: learningScopeSchema, checkerId: learningIdentitySchema, checkerVersion: learningIdentitySchema,
  candidateId: learningDigestSchema, candidateVersion: z.number().int().positive().safe(),
  candidateDigest: learningDigestSchema, evidenceDigest: learningDigestSchema,
  checkerDigest: learningDigestSchema, kind: z.enum(['tool', 'skill']), repository: repositorySchema, asset: assetSchema,
  inventoryDigest: learningDigestSchema, sandbox: sandboxSchema,
  adapter: z.object({ id: adapterIdSchema, revision: learningIdentitySchema, hostRuntimeRevision: learningIdentitySchema }).strict(),
  allowed: z.object({ dependencies: z.array(z.never()).max(0), permissions: z.array(z.never()).max(0), sideEffects: z.literal('none') }).strict(),
  limits: z.object({ timeoutMs: z.number().int().positive().safe().max(120_000),
    maxOutputBytes: z.number().int().positive().safe().max(DISTILLATION_LIMITS.outputBytes) }).strict(),
}).strict().refine(value => matchesAssetKind(value.kind, value.asset.ref, value.adapter.id) && (!value.skillObservation || value.kind === 'skill'));
export type ProposalExecutionGrant = z.infer<typeof proposalExecutionGrantSchema>;
