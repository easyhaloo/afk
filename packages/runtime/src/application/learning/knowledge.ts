import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { z } from 'zod';
import { checkAbort } from '../../infrastructure/providers/dependencies.js';
import type { ProviderOperationOptions } from '../../plugin-sdk/capabilities.js';
import type { CandidateStore, LearningCandidate } from './candidate-store.js';
import { candidateProposalSchema, evidenceRefSchema, learningScopeSchema, type CandidateProposal } from './contracts.js';
import { redactEvidenceText } from './evidence.js';
import { canonicalLearningJson, learningDigestSchema } from './requests.js';
import { assertCurrentLessonPublication, verifyLessonPublication } from './lesson-publication-guard.js';

const publicationDescriptors = new AsyncLocalStorage<{ vault: string; fd: number }>();

export function withKnowledgePublicationDescriptor<Result>(vault: string, fd: number, operation: () => Result): Result {
  return publicationDescriptors.run({ vault: resolve(vault), fd }, operation);
}

const targetSchema = z.object({
  ref: z.string().regex(/^wiki:[A-Za-z0-9][A-Za-z0-9._/-]*$/), paths: z.array(z.string()).min(1).max(32),
  kinds: z.array(z.enum(['fact', 'process', 'lesson'])).min(1), inbox: z.boolean(), templatePath: z.string(),
  snapshot: z.boolean().optional(),
  indexPaths: z.array(z.string()).min(1).max(32), backlinkPaths: z.array(z.string()).min(1).max(32),
}).strict();
const policySchema = z.object({
  scope: learningScopeSchema, vault: z.string().min(1),
  rules: z.record(learningDigestSchema.nullable()), targets: z.array(targetSchema).min(1).max(64),
}).strict();
export type KnowledgePolicy = z.infer<typeof policySchema>;
const grantSchema = z.object({ version: z.literal(1), revoked: z.boolean(), allowWithdrawal: z.boolean(), policy: policySchema }).strict();
export type WikiPlan = { version: 1; summary: string; evidence: string[];
  changes: { path: string; expected_sha256: string | null; content: string }[] };
export type KnowledgePlan = {
  candidateId: string; candidateVersion: number; candidateDigest: string; evidenceDigest: string;
  validatorVersion: string; targetRef: string; policyDigest: string; authorizationFile: string; authorizationDigest: string; reused: boolean;
  classification: 'fact' | 'proposal' | 'unverified' | 'process' | 'lesson' | 'partial' | 'snapshot';
  applicability: CandidateProposal['applicability']; proposal: CandidateProposal;
  plan: WikiPlan; withdrawalContent: string; readSet: Record<string, string | null>; searches: { query: string; paths: string[] }[];
};
export type KnowledgePlanningInput = { store: CandidateStore; candidateId: string; expectedVersion: number; targetRef?: string;
  policy: KnowledgePolicy; wikiScript: string; authorizationFile: string; validationConfigurationFile?: string; signal?: AbortSignal };
export type WikiResult = { status: 'preview' | 'applied' | 'unchanged' };

export class WikiIngestError extends Error {
  constructor(message: string, readonly code: number, readonly recovery?: string) { super(message); }
}

export function knowledgeDigest(value: unknown): string {
  return createHash('sha256').update(canonicalLearningJson(value)).digest('hex');
}

function bytesDigest(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export const KNOWLEDGE_FILE_BYTES = 64 * 1024 * 1024;

export function assertKnowledgeDirectory(directory: string): void {
  if (!isAbsolute(directory)) throw new Error('Expected absolute directory path');
  let current = parse(directory).root;
  for (const part of resolve(directory).slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const stats = lstatSync(current);
      if (stats.isSymbolicLink()) throw new Error('Symbolic links are not allowed');
      if (!stats.isDirectory()) throw new Error('Expected directory path');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

export function knowledgeFile(vault: string, path: string, write = false): string {
  if (!path || isAbsolute(path) || /[\\\0\r\n\[\]#|]/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..' || part === 'node_modules' || part === '30-账户凭证'
      || (part.startsWith('.') && !(path === '.tools/wiki-lint.py' && !write)))) throw new Error('Protected or outside vault path');
  if (write && (!path.endsWith('.md') || ['agents.md', 'claude.md', 'skill.md'].includes(basename(path).toLowerCase()) || basename(path).startsWith('_'))) {
    throw new Error('Protected rules, template or non-Markdown path');
  }
  assertKnowledgeDirectory(vault);
  assertKnowledgeDirectory(dirname(join(vault, path)));
  const target = join(vault, path);
  try {
    const stats = lstatSync(target);
    if (stats.isSymbolicLink()) throw new Error('Symbolic links are not allowed');
    if (!stats.isFile()) throw new Error('Expected regular file path');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return target;
}

function readKnowledgeBytes(file: string, limit: number, privateFile = false, signal?: ProviderOperationOptions['signal']): Buffer {
  const check = () => checkAbort({ signal });
  const checkDirectory = () => {
    assertKnowledgeDirectory(dirname(file));
    if (privateFile) {
      const directory = lstatSync(dirname(file));
      if ((directory.mode & 0o077) || (process.getuid && directory.uid !== process.getuid())) throw new Error('Authorization directory must be private');
    }
  };
  check();
  checkDirectory();
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size > limit) throw new Error('Knowledge file unavailable or exceeds byte limit');
    if (privateFile && (before.nlink !== 1 || (before.mode & 0o077) || (process.getuid && before.uid !== process.getuid()))) {
      throw new Error('Authorization must be an owned private regular file');
    }
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      check();
      const count = readSync(descriptor, bytes, offset, Math.min(bytes.length - offset, 65536), offset);
      check();
      if (!count) break;
      offset += count;
    }
    const fingerprint = (stats: typeof before) => canonicalLearningJson([stats.dev, stats.ino, stats.size, stats.mode,
      stats.uid, stats.nlink, stats.mtimeMs, stats.ctimeMs]);
    let current: typeof before;
    try { current = lstatSync(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Knowledge file changed during read');
      throw error;
    }
    if (offset !== before.size || current.isSymbolicLink() || fingerprint(before) !== fingerprint(current)
      || fingerprint(before) !== fingerprint(fstatSync(descriptor))) throw new Error('Knowledge file changed during read');
    checkDirectory();
    check();
    return bytes.subarray(0, offset);
  } finally { closeSync(descriptor); }
}

function fileDigest(vault: string, path: string, signal?: ProviderOperationOptions['signal']): string | null {
  checkAbort({ signal });
  try { return bytesDigest(readKnowledgeBytes(knowledgeFile(vault, path), KNOWLEDGE_FILE_BYTES, false, signal)); }
  catch (error) { if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null; throw error; }
}

async function wiki(script: string, vault: string, arguments_: string[], input?: string, temporary?: string, signal?: AbortSignal): Promise<unknown> {
  checkAbort({ signal });
  const lock = publicationDescriptors.getStore();
  if (lock && lock.vault !== resolve(vault)) throw new WikiIngestError('Publication lock belongs to a different vault', 4);
  const { LEARNING_PUBLICATION_LOCK_FD: _inheritedDescriptor, ...environment } = process.env;
  return new Promise((resolveResult, reject) => {
    const child = spawn('python3', ['-B', script, ...arguments_, '--vault', vault, '--json'], {
      cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe', ...(lock ? [lock.fd] : [])], signal, killSignal: 'SIGKILL',
      env: { ...environment, ...(lock ? { LEARNING_PUBLICATION_LOCK_FD: '3' } : {}), ...(temporary ? { TMPDIR: temporary } : {}) },
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const stop = (message: string) => { failed = true; child.kill('SIGKILL'); reject(new WikiIngestError(message, 4)); };
    const timer = setTimeout(() => stop('Wiki operation timed out'), 120_000);
    child.stdout!.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) stop('Wiki output exceeds byte limit');
      else chunks.push(chunk);
    });
    child.stderr!.resume();
    child.stdin!.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(signal?.aborted ? signal.reason : new WikiIngestError('Wiki process could not start', 4)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failed) return;
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (code !== 0) throw new WikiIngestError(typeof result.error === 'string' ? result.error : 'Wiki operation failed',
          code ?? 4, typeof result.recovery === 'string' ? result.recovery : undefined);
        resolveResult(result);
      } catch (error) { reject(error instanceof WikiIngestError ? error : new WikiIngestError('Wiki returned invalid JSON', 4)); }
    });
    child.stdin!.end(input);
  });
}

export async function runWikiIngest(script: string, vault: string, plan: WikiPlan, apply: boolean, temporary?: string, signal?: AbortSignal): Promise<WikiResult> {
  return z.object({ status: z.enum(['preview', 'applied', 'unchanged']) }).parse(
    await wiki(script, vault, ['ingest', '--plan', '-', ...(apply ? ['--apply'] : [])], JSON.stringify(plan), temporary, signal));
}

async function readPage(script: string, vault: string, path: string, signal?: AbortSignal): Promise<{ content: string; sha256: string }> {
  knowledgeFile(vault, path);
  const page = z.object({ content: z.string(), sha256: learningDigestSchema, redacted: z.boolean() }).parse(await wiki(script, vault, ['read', path], undefined, undefined, signal));
  if (page.redacted) throw new Error('Sensitive or redacted page cannot be used for publication');
  if (bytesDigest(page.content) !== page.sha256) throw new Error('Full-page read differs from target hash');
  return page;
}

async function search(script: string, vault: string, query: string, signal?: AbortSignal): Promise<string[]> {
  const result = z.object({ total: z.number().int().nonnegative(), results: z.array(z.object({ path: z.string() })) })
    .parse(await wiki(script, vault, ['search', query, '--limit', '1000'], undefined, undefined, signal));
  if (result.total !== result.results.length) throw new Error('Knowledge search is incomplete');
  return result.results.map(entry => entry.path).sort();
}

function authorize(policy: KnowledgePolicy, signal?: ProviderOperationOptions['signal'], readSet?: Map<string, string | null>): void {
  checkAbort({ signal });
  policySchema.parse(policy);
  if (policy.vault !== resolve(policy.vault)) throw new Error('Vault must use a canonical absolute path');
  assertKnowledgeDirectory(policy.vault);
  if (!policy.rules['AGENTS.md'] || !Object.hasOwn(policy.rules, '.tools/wiki-lint.py')) throw new Error('Explicit rules and linter authorization required');
  if (new Set(policy.targets.map(target => target.ref)).size !== policy.targets.length) throw new Error('Duplicate target authorization');
  const read = (path: string) => {
    const observed = fileDigest(policy.vault, path, signal);
    if (readSet?.has(path) && readSet.get(path) !== observed) throw new Error('Authorization rule changed during read');
    readSet?.set(path, observed);
    return observed;
  };
  for (const [path, expected] of Object.entries(policy.rules)) {
    if (read(path) !== expected) throw new Error('Vault rules differ from authorization');
  }
  for (const target of policy.targets) {
    for (const path of [...target.paths, ...target.indexPaths, ...target.backlinkPaths]) {
      knowledgeFile(policy.vault, path, true);
      if (Object.keys(policy.rules).some(rule => rule.toLowerCase() === path.toLowerCase())) throw new Error('Cannot publish to rules path');
      let directory = dirname(path);
      while (directory !== '.') {
        const rule = `${directory}/AGENTS.md`;
        if (read(rule) !== null && !policy.rules[rule]) throw new Error('Directory rules require explicit authorization');
        directory = dirname(directory);
      }
    }
    knowledgeFile(policy.vault, target.templatePath);
  }
}

export function readKnowledgeGrant(file: string, options: Pick<ProviderOperationOptions, 'signal'> = {}): z.infer<typeof grantSchema> {
  checkAbort(options);
  if (!isAbsolute(file) || file !== resolve(file)) throw new Error('Persistent authorization requires an absolute canonical file');
  assertKnowledgeDirectory(dirname(file));
  const directory = lstatSync(dirname(file));
  if ((process.getuid && directory.uid !== process.getuid()) || (directory.mode & 0o077)) throw new Error('Authorization directory must be private');
  const bytes = readKnowledgeBytes(file, 1024 * 1024, true, options.signal);
  const grant = grantSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  if (grant.policy.vault !== resolve(grant.policy.vault)) throw new Error('Vault must use a canonical absolute path');
  if (file === grant.policy.vault || file.startsWith(`${grant.policy.vault}${sep}`)) throw new Error('Authorization must be outside vault');
  return grant;
}

export function readKnowledgeAuthorization(input: { authorizationFile: string; policy: KnowledgePolicy; signal?: ProviderOperationOptions['signal'] },
  withdrawal = false, readSet?: Map<string, string | null>): z.infer<typeof grantSchema> {
  checkAbort(input);
  const grant = readKnowledgeGrant(input.authorizationFile, input);
  if (knowledgeDigest(grant.policy) !== knowledgeDigest(input.policy)) throw new Error('Persistent authorization policy scope, vault or target changed');
  if (withdrawal ? !grant.allowWithdrawal : grant.revoked) throw new Error('Persistent authorization revoked');
  authorize(grant.policy, input.signal, readSet);
  return grant;
}

export function assertKnowledgeCandidate(input: Pick<KnowledgePlanningInput, 'store' | 'candidateId' | 'expectedVersion' | 'policy' | 'validationConfigurationFile'>): LearningCandidate {
  const candidate = input.store.getCandidate(input.candidateId);
  const receipt = input.store.getValidation(input.candidateId);
  const source = candidate && input.store.getRequest(candidate.requestKey);
  if (candidate && (!source || source.blockedReason || source.request.evidenceDigest !== candidate.evidenceDigest
    || source.request.scope !== input.policy.scope)) throw new Error('Knowledge source blocked, invalidated or evidence changed');
  if (!candidate || candidate.version !== input.expectedVersion || candidate.state !== 'validated' || !receipt?.passed
    || receipt.validatedVersion !== candidate.version || receipt.candidateDigest !== candidate.digest
    || receipt.evidenceDigest !== candidate.evidenceDigest || knowledgeDigest(candidate.proposal) !== candidate.digest) {
    throw new Error('Knowledge publication requires current version and validation receipt');
  }
  if (candidate.proposal.applicability.project !== input.policy.scope) throw new Error('Candidate project differs from authorized scope');
  if (candidate.proposal.kind === 'lesson') assertCurrentLessonPublication({ store: input.store, candidate,
    configurationFile: input.validationConfigurationFile });
  return candidate;
}

function sameKnowledge(existing: string, rendered: string): boolean {
  if (existing === rendered) return true;
  const block = /\n```json\n([^\n]+)\n```\n/;
  const previous = block.exec(existing)?.[1];
  const next = block.exec(rendered)?.[1];
  if (!previous || !next) return false;
  const schema = z.object({ classification: z.enum(['fact', 'proposal', 'unverified', 'process', 'partial', 'snapshot']),
    proposal: candidateProposalSchema, evidence: z.array(evidenceRefSchema).min(1), evidenceDigest: learningDigestSchema }).strict();
  const identity = (proposal: CandidateProposal) => {
    const { evidenceIds: _evidence, targetRef: _target, ...material } = proposal;
    return { ...material, payload: proposal.kind === 'process'
      ? { ...proposal.payload, steps: proposal.payload.steps.map(({ evidenceIds: _refs, ...step }) => step) } : proposal.payload };
  };
  try {
    const prior = schema.parse(JSON.parse(previous));
    const current = schema.parse(JSON.parse(next));
    if (prior.proposal.kind === 'lesson' || current.proposal.kind === 'lesson') return false;
    const sensitive = JSON.stringify(prior);
    return redactEvidenceText(sensitive) === sensitive && prior.classification === current.classification
      && knowledgeDigest(identity(prior.proposal)) === knowledgeDigest(identity(current.proposal))
      && existing === rendered.replace(next, () => previous);
  } catch { return false; }
}

function knowledgeRelation(existing: string, proposal: CandidateProposal): 'unrelated' | 'review' | 'contrary' {
  const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const identity = normalize(proposal.kind === 'fact' ? proposal.payload.subject : proposal.kind === 'process' ? proposal.payload.entry
    : proposal.kind === 'lesson' ? proposal.payload.trigger : proposal.title);
  const block = /\n```json\n([^\n]+)\n```\n/.exec(existing)?.[1];
  let rules: string[] = [];
  if (block) {
    try {
      const material = JSON.parse(block);
      const previous = candidateProposalSchema.parse(material.proposal);
      const previousIdentity = normalize(previous.kind === 'fact' ? previous.payload.subject : previous.kind === 'process' ? previous.payload.entry
        : previous.kind === 'lesson' ? previous.payload.trigger : previous.title);
      if (previousIdentity !== identity || knowledgeDigest(previous.applicability) !== knowledgeDigest(proposal.applicability)) return 'unrelated';
      if (previous.kind === 'fact' && ['fact', 'snapshot'].includes(material.classification)) rules = [normalize(previous.payload.rule)];
    } catch { return 'review'; }
  } else {
    const heading = /^#\s+(.+)$/m.exec(existing)?.[1];
    if (!heading || ![identity, normalize(proposal.title)].includes(normalize(heading))) return 'unrelated';
    rules = existing.split('\n').map(normalize).map(line => line.startsWith(`${identity} `) ? line.slice(identity.length + 1) : line);
  }
  if (proposal.kind === 'fact') {
    const polarity = (text: string) => {
      const affirmative = text.replace(/^(never |not |do not |must not )/, '').replace(/\b(is|are|should|must) not /g, '$1 ');
      return { affirmative, negative: affirmative !== text };
    };
    const current = polarity(normalize(proposal.payload.rule));
    if (rules.some(rule => {
      const previous = polarity(rule);
      return previous.negative !== current.negative && previous.affirmative === current.affirmative;
    })) return 'contrary';
  }
  return 'review';
}

export async function planKnowledgePublication(input: KnowledgePlanningInput): Promise<KnowledgePlan> {
  checkAbort(input);
  const { policy, store, wikiScript } = input;
  const authorizationDigest = knowledgeDigest(readKnowledgeAuthorization(input));
  const candidate = assertKnowledgeCandidate(input);
  const proposal = candidate.proposal;
  if (proposal.kind !== 'fact' && proposal.kind !== 'process' && proposal.kind !== 'lesson') throw new Error('Unsupported knowledge asset kind');
  if (input.targetRef && proposal.targetRef && input.targetRef !== proposal.targetRef) throw new Error('Publication target differs from validated candidate');
  const target = policy.targets.find(entry => entry.ref === (input.targetRef ?? proposal.targetRef) && entry.kinds.includes(proposal.kind as 'fact' | 'process' | 'lesson'));
  if (!target) throw new Error('Knowledge target and asset kind require explicit authorization');
  const source = store.getRequest(candidate.requestKey);
  if (!source || source.request.evidenceDigest !== candidate.evidenceDigest || source.request.scope !== policy.scope) throw new Error('Evidence snapshot differs from validated candidate');
  const ids = new Set([...proposal.evidenceIds, ...(proposal.kind === 'process' ? proposal.payload.steps.flatMap(step => step.evidenceIds) : [])]);
  const evidence = source.evidence.filter(entry => ids.has(entry.id));
  if (evidence.length !== ids.size) throw new Error('Unknown knowledge evidence reference');
  const serialized = JSON.stringify({ proposal, evidence });
  if (redactEvidenceText(serialized) !== serialized) throw new Error('Sensitive credentials or personal data cannot be published');
  const partial = evidence.some(entry => entry.completeness === 'partial' || entry.authority === 'inferred')
    || !proposal.applicability.versions.length || (proposal.kind === 'process' && proposal.payload.steps.some(step => step.missingEvidence));
  const snapshot = proposal.kind === 'fact' && (proposal.applicability.environments.length > 0
    || /\b(currently|deployed image|running image|runs? image)\b|当前|现网|生产环境/i.test(`${proposal.statement} ${proposal.payload.rule}`));
  if (snapshot && (!target.snapshot || !proposal.applicability.environments.length || !proposal.applicability.versions.length)) {
    throw new Error('Environment snapshot requires explicit destination, environment and version authorization');
  }
  if (!snapshot && target.snapshot) throw new Error('Snapshot destination cannot receive ordinary business knowledge');
  const classification = proposal.kind === 'fact' ? proposal.payload.classification === 'proposal' ? 'proposal' : partial ? 'unverified' : snapshot ? 'snapshot' : 'fact'
    : partial ? 'partial' : proposal.kind;
  if ((classification === 'proposal' || partial) && !target.inbox) throw new Error('Proposal or partial knowledge requires an authorized inbox');
  if (proposal.kind === 'process' && partial && !proposal.payload.steps.some(step => step.missingEvidence)) throw new Error('Partial process requires explicit node evidence gaps');
  const readSet: Record<string, string | null> = { ...policy.rules };
  const read = async (path: string) => {
    const page = await readPage(wikiScript, policy.vault, path, input.signal);
    if (Object.hasOwn(readSet, path) && readSet[path] !== page.sha256) throw new Error('Concurrent knowledge read conflict');
    readSet[path] = page.sha256;
    return page.content;
  };
  for (const path of Object.keys(policy.rules).filter(path => path.endsWith('.md') && policy.rules[path] !== null)) await read(path);
  const template = await read(target.templatePath);
  if (!template.includes('{{knowledge}}') || !template.includes('{{title}}')) throw new Error('Authorized template needs title and knowledge placeholders');
  const related = [...new Set([...target.indexPaths, ...target.backlinkPaths])];
  const links = related.map(path => `[[${path.slice(0, -3)}]]`).join(' ');
  const lesson = proposal.kind === 'lesson' ? verifyLessonPublication({ store, candidate,
    configurationFile: input.validationConfigurationFile }, { signal: input.signal }) : undefined;
  if (lesson?.status === 'blocked') throw new Error(`lesson_publication_${lesson.code}`);
  const material = canonicalLearningJson({ classification, proposal, evidence, evidenceDigest: candidate.evidenceDigest,
    ...(lesson?.status === 'current' ? { validation: { binding: lesson.binding, evidence: lesson.evidence } } : {}) });
  if (redactEvidenceText(material) !== material) throw new Error('Sensitive credentials or personal data cannot be published');
  const body = `## ${classification}${partial ? ' (partial)' : ''}\n\n\`\`\`json\n${material.replaceAll('`', '\\u0060').replaceAll('<', '\\u003c')}\n\`\`\`\n\n${links}`;
  const title = proposal.title.replace(/[\[\]<>#\r\n`]/g, ' ');
  const content = template.replaceAll('{{title}}', () => title).replaceAll('{{knowledge}}', () => body);
  const queries = [...new Set([proposal.kind === 'fact' ? proposal.payload.subject : proposal.kind === 'process' ? proposal.payload.entry : proposal.payload.trigger, proposal.title]
    .map(value => value.replace(/\s+/g, ' ').trim().toLowerCase()))];
  const searches: KnowledgePlan['searches'] = [];
  let existingPath: string | undefined;
  let existingContent: string | undefined;
  const ignored = new Set([...related, target.templatePath, ...Object.keys(policy.rules)]);
  const conflict = () => { store.transitionCandidate(candidate.id, candidate.version, 'conflict'); throw new Error('Existing knowledge conflict requires review'); };
  for (const query of queries) {
    const paths = await search(wikiScript, policy.vault, query, input.signal);
    const relevantPaths: string[] = [];
    searches.push({ query, paths: relevantPaths });
    for (const path of paths) {
      if (ignored.has(path)) continue;
      const existing = await read(path);
      if (!sameKnowledge(existing, content)) {
        const relation = knowledgeRelation(existing, proposal);
        if (relation === 'contrary') conflict();
        if (relation === 'unrelated' && !target.paths.includes(path)) { delete readSet[path]; continue; }
        throw new Error('Existing knowledge requires explicit identity and equivalence review');
      }
      if (!target.paths.includes(path)) throw new Error('Equivalent knowledge target requires authorization review');
      relevantPaths.push(path);
      if (!existingPath) { existingPath = path; existingContent = existing; }
    }
  }
  for (const path of target.paths) {
    if (fileDigest(policy.vault, path, input.signal) === null) readSet[path] = null;
    else {
      const existing = await read(path);
      if (!sameKnowledge(existing, content)) {
        if (knowledgeRelation(existing, proposal) === 'contrary') conflict();
        throw new Error('Existing target requires equivalence review');
      }
      if (!existingPath) { existingPath = path; existingContent = existing; }
    }
  }
  const path = existingPath ?? target.paths[0]!;
  const changes: WikiPlan['changes'] = [{ path, expected_sha256: readSet[path] ?? null, content: existingContent ?? content }];
  const link = `[[${path.slice(0, -3)}]]`;
  for (const relatedPath of related) {
    const original = await read(relatedPath);
    if (!original.includes(link)) changes.push({ path: relatedPath, expected_sha256: readSet[relatedPath]!,
      content: `${original}${original.endsWith('\n') ? '\n' : '\n\n'}${link}\n` });
  }
  const prepared: KnowledgePlan = { candidateId: candidate.id, candidateVersion: candidate.version,
    candidateDigest: candidate.digest, evidenceDigest: candidate.evidenceDigest,
    validatorVersion: store.getValidation(candidate.id)!.validatorVersion, targetRef: target.ref,
    policyDigest: knowledgeDigest(policy), authorizationFile: input.authorizationFile, authorizationDigest, reused: existingPath !== undefined, readSet, searches,
    classification, applicability: proposal.applicability, proposal,
    withdrawalContent: template.replaceAll('{{title}}', 'Withdrawn knowledge').replaceAll('{{knowledge}}',
      `knowledge_status: revoked\n\nCandidate ${candidate.id} version ${candidate.version} is withdrawn. Do not use as evidence.\n\n${links}`),
    plan: { version: 1, summary: proposal.statement, evidence: evidence.map(entry => canonicalLearningJson(entry)), changes } };
  await verifyKnowledgePlan(prepared, policy, wikiScript, input.signal);
  await runWikiIngest(wikiScript, policy.vault, prepared.plan, false, undefined, input.signal);
  await verifyKnowledgePlan(prepared, policy, wikiScript, input.signal);
  checkAbort(input);
  assertKnowledgeCandidate(input);
  return prepared;
}

export function knowledgeTargetDigest(plan: WikiPlan, observedVault?: string): string {
  return knowledgeDigest(plan.changes.map(change => ({ path: change.path,
    sha256: observedVault ? fileDigest(observedVault, change.path) : bytesDigest(change.content) })));
}

function navigationPaths(prepared: KnowledgePlan, policy: KnowledgePolicy): Set<string> {
  const target = policy.targets.find(entry => entry.ref === prepared.targetRef);
  if (!target) throw new Error('Navigation refresh target is unavailable');
  const protectedPaths = new Set([...Object.keys(policy.rules), target.templatePath, ...policy.targets.flatMap(entry => entry.paths)]);
  return new Set([...target.indexPaths, ...target.backlinkPaths].filter(path => !protectedPaths.has(path)));
}

export function assertKnowledgeNavigationReplacement(previous: KnowledgePlan, next: KnowledgePlan, policy: KnowledgePolicy): void {
  if (previous.reused || next.reused) throw new Error('Navigation replacement requires an unwritten primary asset');
  const navigation = navigationPaths(previous, policy);
  const { plan: previousPlan, readSet: previousReads, searches: previousSearches, ...previousBinding } = previous;
  const { plan: nextPlan, readSet: nextReads, searches: nextSearches, ...nextBinding } = next;
  if (canonicalLearningJson(previousBinding) !== canonicalLearningJson(nextBinding)
    || canonicalLearningJson({ ...previousPlan, changes: undefined }) !== canonicalLearningJson({ ...nextPlan, changes: undefined })
    || canonicalLearningJson(previousPlan.changes[0]) !== canonicalLearningJson(nextPlan.changes[0])
    || canonicalLearningJson(previousSearches) !== canonicalLearningJson(nextSearches)
    || canonicalLearningJson(Object.keys(previousReads).sort()) !== canonicalLearningJson(Object.keys(nextReads).sort())) {
    throw new Error('Navigation replacement changed publication identity or primary content');
  }
  for (const [path, expected] of Object.entries(previousReads)) {
    if (!navigation.has(path) && nextReads[path] !== expected) throw new Error('Navigation replacement changed a non-navigation read');
  }
  const link = `[[${previousPlan.changes[0]!.path.slice(0, -3)}]]`;
  const originals = new Map<WikiPlan, Map<string, string>>();
  for (const plan of [previousPlan, nextPlan]) {
    const navigationOriginals = new Map<string, string>();
    originals.set(plan, navigationOriginals);
    if (new Set(plan.changes.map(change => change.path)).size !== plan.changes.length) throw new Error('Duplicate navigation replacement path');
    for (const change of plan.changes.slice(1)) {
      const reads = plan === previousPlan ? previousReads : nextReads;
      if (!navigation.has(change.path) || reads[change.path] !== change.expected_sha256 || !['\n', '\n\n'].some(separator => {
        const suffix = `${separator}${link}\n`;
        if (!change.content.endsWith(suffix)) return false;
        const original = change.content.slice(0, -suffix.length);
        if ((original.endsWith('\n') ? '\n' : '\n\n') !== separator || original.includes(link)
          || bytesDigest(original) !== change.expected_sha256) return false;
        navigationOriginals.set(change.path, original);
        return true;
      })) throw new Error('Navigation replacement must preserve the complete original navigation');
    }
  }
  for (const path of navigation) {
    if (previousReads[path] === nextReads[path]) continue;
    const previousOriginal = originals.get(previousPlan)!.get(path);
    const nextOriginal = originals.get(nextPlan)!.get(path);
    if (previousOriginal === undefined || nextOriginal === undefined || !nextOriginal.startsWith(previousOriginal)) {
      throw new Error('Navigation replacement cannot adopt edits or deletions of existing navigation');
    }
  }
}

export function assertKnowledgePlanUnwritten(prepared: KnowledgePlan, policy: KnowledgePolicy): void {
  if (prepared.policyDigest !== knowledgeDigest(policy)) throw new Error('Publication policy changed');
  if (prepared.authorizationDigest !== knowledgeDigest(readKnowledgeAuthorization({ authorizationFile: prepared.authorizationFile, policy }))) {
    throw new Error('Publication authorization changed');
  }
  for (const [path, expected] of Object.entries(prepared.readSet)) {
    if (fileDigest(policy.vault, path) !== expected) throw new Error('Navigation replacement read changed before adoption');
  }
}

export async function refreshKnowledgeNavigation(prepared: KnowledgePlan, input: KnowledgePlanningInput): Promise<KnowledgePlan | undefined> {
  checkAbort(input);
  readKnowledgeAuthorization(input);
  if (prepared.policyDigest !== knowledgeDigest(input.policy) || prepared.reused) return undefined;
  const navigation = navigationPaths(prepared, input.policy);
  let drift = false;
  for (const [path, expected] of Object.entries(prepared.readSet)) {
    if (fileDigest(input.policy.vault, path, input.signal) === expected) continue;
    if (!navigation.has(path)) return undefined;
    drift = true;
  }
  if (!drift) return undefined;
  const replacement = await planKnowledgePublication(input);
  assertKnowledgeNavigationReplacement(prepared, replacement, input.policy);
  assertKnowledgePlanUnwritten(replacement, input.policy);
  checkAbort(input);
  return replacement;
}

export async function verifyKnowledgePlan(prepared: KnowledgePlan, policy: KnowledgePolicy, script: string, signal?: AbortSignal): Promise<void> {
  checkAbort({ signal });
  if (prepared.authorizationDigest !== knowledgeDigest(readKnowledgeAuthorization({ authorizationFile: prepared.authorizationFile, policy, signal }))) {
    throw new Error('Publication authorization changed');
  }
  if (prepared.policyDigest !== knowledgeDigest(policy)) throw new Error('Publication policy changed');
  for (const [path, expected] of Object.entries(prepared.readSet)) {
    const actual = fileDigest(policy.vault, path, signal);
    const change = prepared.plan.changes.find(entry => entry.path === path);
    if (actual !== expected && (!change || actual !== bytesDigest(change.content))) throw new Error('Knowledge read or target changed; conflict');
  }
  const changed = new Set(prepared.plan.changes.map(change => change.path));
  const target = policy.targets.find(entry => entry.ref === prepared.targetRef)!;
  const ignored = new Set([...target.indexPaths, ...target.backlinkPaths, target.templatePath, ...Object.keys(policy.rules)]);
  for (const previous of prepared.searches) {
    const current: string[] = [];
    for (const path of await search(script, policy.vault, previous.query, signal)) {
      if (changed.has(path) || ignored.has(path)) continue;
      const page = await readPage(script, policy.vault, path, signal);
      if (target.paths.includes(path) || knowledgeRelation(page.content, prepared.proposal) !== 'unrelated') current.push(path);
    }
    if (canonicalLearningJson(current) !== canonicalLearningJson(previous.paths.filter(path => !changed.has(path)))) {
      throw new Error('Knowledge search results changed; conflict');
    }
  }
  checkAbort({ signal });
}
