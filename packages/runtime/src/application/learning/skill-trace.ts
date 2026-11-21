import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { buildFrozenContext } from '../../infrastructure/sandbox/container/frozen-input.js';
import type { FrozenExecutionResult } from '../../infrastructure/sandbox/container/frozen-execution.js';
import type { PreparedProposalExperiment, ProposalSemanticExecutionContext } from './proposal-semantics.js';
import { learningDigestSchema } from './requests.js';
import { DISTILLATION_LIMITS } from './contracts.js';

const read = z.object({ path: z.string().regex(/^\/business\/[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/), digest: learningDigestSchema }).strict();
export const skillTraceBindingSchema = z.object({ checkerDigest: learningDigestSchema, reads: z.array(read).max(16) }).strict();
const traceSchema = z.object({ protocol: z.literal('skill-trace-v1'), completed: z.literal(true),
  inputDigest: learningDigestSchema, outputDigest: learningDigestSchema, businessValid: z.boolean(),
  loaded: z.object({ path: z.string(), digest: learningDigestSchema }).strict(),
  calls: z.array(z.object({ tool: z.literal('Read'), result: read }).strict()).max(16) }).strict();

const launcher = `const fs = require('node:fs');
const {createHash} = require('node:crypto');
const {spawnSync} = require('node:child_process');
const [artifact, input, digest] = process.argv.slice(1);
const checker = '/opt/afk/checkers/skill-trace-v1.mjs';
if (fs.realpathSync(checker) !== checker || createHash('sha256').update(fs.readFileSync(checker)).digest('hex') !== digest) process.exit(78);
const child = spawnSync(process.execPath, [checker, artifact, input], {cwd:'/scratch', stdio:['ignore','pipe','ignore','pipe'], maxBuffer:65536});
if (child.error || child.signal || child.status === null || !child.output[3]?.length) process.exit(78);
process.stdout.write(child.stdout);
process.stderr.write(child.output[3]);
process.exitCode = child.status;`;

export function skillTraceArgv(path: string, input: string, checkerDigest: string): string[] {
  return ['/usr/local/bin/node', '-e', launcher, '--', `/workspace/${path}`, input, checkerDigest];
}

export function declaredSkillReads(reads: readonly z.infer<typeof read>[], resources: readonly z.infer<typeof read>[] = []) {
  return reads.every(observed => resources.some(resource => observed.path === `/business/${resource.path}` && observed.digest === resource.digest));
}

export function observeSkillTrace(experiment: PreparedProposalExperiment, execution: Readonly<FrozenExecutionResult>,
  context?: ProposalSemanticExecutionContext) {
  if (!context || !experiment.skillTrace) throw new Error('Missing frozen skill trace binding');
  const { options, operationId, containerId } = context;
  const { evidence } = execution;
  if (options.scratch || options.control || !isDeepStrictEqual(options.argv, experiment.argv)
    || !isDeepStrictEqual(options.argv, skillTraceArgv(experiment.artifactPath, experiment.input, experiment.skillTrace.checkerDigest))
    || evidence.mechanism !== 'docker-frozen-image' || evidence.cwd !== '/workspace' || evidence.operationId !== operationId
    || evidence.containerId !== containerId || evidence.baseImageId !== options.baseImageId || evidence.inputDigest !== options.input.digest
    || evidence.contextDigest !== buildFrozenContext(options.input, options.baseImageId, operationId).digest
    || Buffer.byteLength(execution.stderr) > (options.maxOutputBytes ?? DISTILLATION_LIMITS.outputBytes)) throw new Error('Skill trace differs from frozen execution');
  const trace = traceSchema.parse(JSON.parse(execution.stderr));
  const artifact = options.input.manifest.find(entry => entry.kind === 'file' && entry.path === experiment.artifactPath);
  if (!artifact || trace.loaded.path !== `/workspace/${artifact.path}` || trace.loaded.digest !== artifact.digest
    || trace.inputDigest !== createHash('sha256').update(experiment.input).digest('hex')) throw new Error('Skill trace differs from loaded skill or input');
  if (trace.outputDigest !== createHash('sha256').update(execution.stdout).digest('hex')) throw new Error('Skill trace differs from business output');
  return { trace, passed: trace.businessValid && isDeepStrictEqual(trace.calls.map(call => call.result), experiment.skillTrace.reads) };
}
