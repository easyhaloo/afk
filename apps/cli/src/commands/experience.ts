import { Command, InvalidArgumentError, Option } from 'commander';
import { constants, promises as fs } from 'node:fs';
import { ExperienceStore, experienceScope, experienceStorePath, learningDirectory, queryLearningState,
  candidateProposalSchema, candidateStateSchema, verifyAdoptionRun, verifyExperienceRun,
  type LearningCandidate, type LearningJob, type LearningState, type LearningValidationResult } from '@afk/runtime/execution';
import type { PluginRuntime } from '@afk/runtime/plugin-sdk';
import type { CommandRegistrationContext } from '../command-registry.js';

type Store = Pick<ExperienceStore, 'recordFailure' | 'list' | 'get' | 'recall' | 'verify' | 'revoke' | 'export' | 'import' | 'copy' | 'metrics' | 'adopt' | 'close'>;

export interface ExperienceCommandComposition extends CommandRegistrationContext {
  createRuntime?: () => Promise<PluginRuntime>;
  createStore?: () => Store;
  verifyRun?: typeof verifyExperienceRun;
  verifyAdoptionRun?: typeof verifyAdoptionRun;
  queryLearningState?: typeof queryLearningState;
}

function parseScope(value: string): string {
  try {
    if (experienceScope(`${value}#1`) === value) return value;
  } catch {}
  throw new InvalidArgumentError('scope must be a canonical project (platform:projectKey)');
}

function parseText(value: string): string {
  if (!value.trim() || value.includes('\0')) throw new InvalidArgumentError('expected non-empty text without NUL characters');
  return value.trim();
}

function parseLimit(value: string): number {
  const count = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(count) || count < 0 || count > 100) throw new InvalidArgumentError('limit must be an integer from 0 to 100');
  return count;
}

function parseOffset(value: string): number {
  const offset = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(offset) || offset < 0) throw new InvalidArgumentError('offset must be a non-negative safe integer');
  return offset;
}

function parseCandidateId(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value) || value.length !== 64) throw new InvalidArgumentError('candidate ID must be 64 lowercase hexadecimal characters');
  return value;
}

function parseVersion(value: string): number {
  const version = parseOffset(value);
  if (version < 1) throw new InvalidArgumentError('version must be a positive safe integer');
  return version;
}

function learningCode(value?: string): string | undefined {
  return value && ['analysis_cancelled', 'analysis_failed', 'analysis_invalid_output', 'analysis_outcome_unknown',
    'analysis_output_limit', 'analysis_timed_out', 'analysis_unsupported', 'attempts_exhausted', 'budget_exhausted',
    'evidence_unavailable', 'learning_disabled', 'source_invalidated', 'source_limit', 'source_not_allowed', 'source_unstable', 'storage_blocked'].includes(value)
    ? value : undefined;
}

function collectEvidence(value: string, previous: string[] = []): string[] {
  return [...previous, parseText(value)];
}

async function readExchange(file: string): Promise<string> {
  const maximum = 1024 * 1024;
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error('Exchange must be a regular JSON file of at most 1048576 bytes');
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maximum) throw new Error('Experience exchange exceeds byte limit (1048576)');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } finally { await handle.close(); }
}

export function registerExperienceCommands(program: Command, composition: ExperienceCommandComposition = {}): void {
  const experience = program.command('experience').description('Inspect and govern scoped execution experiences');
  const withStore = async (operation: (store: Store) => void | Promise<void>): Promise<void> => {
    const store = composition.createStore ? composition.createStore() : new ExperienceStore({ file: experienceStorePath() });
    try { await operation(store); }
    finally { store.close(); }
  };
  const requireScopedRecord = (store: Store, id: string, scope: string): void => {
    const record = store.get(id, scope);
    if (!record || record.scope !== scope) throw new Error('Experience not found in scope');
  };
  const emit = (records: ReturnType<Store['list']>, json?: boolean): void => {
    const output = json ? JSON.stringify(records, null, 2) : records.map(record => `${record.id} [${record.status}] ${record.trigger}\n  ${record.action}`).join('\n');
    process.stdout.write(`${output}\n`);
  };

  const queryLearning = async <Kind extends keyof LearningState>(kind: Kind, scope: string): Promise<LearningState[Kind]> => {
    try {
      const records = composition.pluginRuntime
        ? await composition.pluginRuntime.dispatchSystemAction(`learning.${kind}`, { scope }) as LearningState[Kind]
        : (composition.queryLearningState ?? queryLearningState)({ directory: learningDirectory(), scope })[kind];
      if (kind === 'jobs') {
        return (records as LearningJob[]).filter(record => record.scope === scope).map(record => {
          const { jobId, sourceId, sourceRunId, workItemId, status, reasonCode, attempts } = record;
          if (!['pending', 'blocked', 'failed', 'processed'].includes(status)) throw new Error('Invalid learning status');
          return { jobId: parseCandidateId(jobId), scope, sourceId, sourceRunId, workItemId, status, reasonCode: learningCode(reasonCode),
            attempts: attempts.map(({ requestKey, callId, day, startedAt, ownerPid, host, status, analysisRunId, sessionId, finishedAt, errorCode, usage }) => ({
              requestKey, callId, day, startedAt, ownerPid, host, status, analysisRunId, sessionId, finishedAt, errorCode: learningCode(errorCode),
              ...(usage ? { usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens } } : {}),
            })) };
        }) as LearningState[Kind];
      }
      return (records as LearningCandidate[]).filter(record => record.proposal.applicability.project === scope)
        .map(({ id, requestKey, version, state, digest, evidenceDigest, proposal }) => ({ id: parseCandidateId(id), requestKey,
          version, state: candidateStateSchema.parse(state), digest, evidenceDigest, proposal: candidateProposalSchema.parse(proposal) })) as LearningState[Kind];
    } catch { throw new Error('Learning query failed'); }
  };
  const learningId = (record: LearningJob | LearningCandidate): string => 'jobId' in record ? record.jobId : record.id;
  const emitLearning = (records: (LearningJob | LearningCandidate)[], json?: boolean, single = false): void => {
    const output = json ? JSON.stringify(single ? records[0] : records, null, 2) : records.map(record => {
      const reason = 'reasonCode' in record && record.reasonCode ? ` ${record.reasonCode}` : '';
      return `${learningId(record)} [${'status' in record ? record.status : record.state}]${reason}`;
    }).join('\n');
    process.stdout.write(`${output}\n`);
  };

  for (const kind of ['jobs', 'candidates'] as const) {
    experience.command(kind)
      .description(`Read scoped learning ${kind}, ordered by full ${kind === 'jobs' ? 'jobId' : 'id'} ascending`)
      .requiredOption('--scope <project>', 'Canonical platform:projectKey', parseScope)
      .option('--limit <count>', 'Maximum records to return (0..100)', parseLimit, 100)
      .option('--offset <count>', 'Records to skip in ID order', parseOffset, 0)
      .option('--json', 'Emit existing learning DTOs as JSON')
      .action(async options => {
        const records = await queryLearning(kind, options.scope);
        records.sort((first, second) => learningId(first) < learningId(second) ? -1 : learningId(first) > learningId(second) ? 1 : 0);
        emitLearning(records.slice(options.offset).slice(0, options.limit), options.json);
      });
  }

  experience.command('inspect')
    .description('Read one learning candidate in its exact project scope')
    .argument('<candidateId>', '64 lowercase hexadecimal characters', parseCandidateId)
    .requiredOption('--scope <project>', 'Canonical platform:projectKey', parseScope)
    .option('--json', 'Emit the existing candidate DTO as JSON')
    .action(async (candidateId, options) => {
      const records = await queryLearning('candidates', options.scope);
      const record = records.find(candidate => candidate.id === candidateId);
      if (!record) throw new Error('Candidate not found in scope');
      emitLearning([record], options.json, true);
    });

  experience.command('validate')
    .description('Independently validate a learning candidate using a saved checker binding')
    .argument('<candidateId>', '64 lowercase hexadecimal characters', parseCandidateId)
    .requiredOption('--scope <project>', 'Canonical platform:projectKey', parseScope)
    .requiredOption('--expected-version <version>', 'Current candidate version', parseVersion)
    .requiredOption('--checker <id>', 'Saved checker identity', parseText)
    .option('--json', 'Emit the validation result as JSON')
    .action(async (candidateId, options) => {
      const owned = !composition.pluginRuntime && !composition.createRuntime;
      let plugins: PluginRuntime | undefined;
      try {
        const active = composition.pluginRuntime ?? await (composition.createRuntime
          ? composition.createRuntime() : import('../composition-root.js').then(module => module.createCliPluginRuntime()));
        if (!active) throw new Error('Learning validation unavailable');
        plugins = active;
        const result = await active.dispatchSystemAction('learning.validate', { scope: options.scope, candidateId,
          expectedVersion: options.expectedVersion, checkerId: options.checker }) as LearningValidationResult;
        process.stdout.write(`${options.json ? JSON.stringify(result) : result.status === 'validated'
          ? `${result.candidateId} [validated] version ${result.validatedVersion}` : `[blocked] ${result.code}`}\n`);
        if (result.status === 'blocked') process.exitCode = 1;
      } catch { throw new Error('Learning validation failed'); }
      finally {
        if (owned) {
          try { await plugins?.dispose(); }
          catch { throw new Error('Learning validation failed'); }
        }
      }
    });

  experience.command('list')
    .description('List experiences in one canonical project scope')
    .requiredOption('--scope <project>', 'Canonical platform:projectKey', parseScope)
    .addOption(new Option('--status <status>', 'Experience status').choices(['candidate', 'verified', 'revoked']))
    .option('--limit <count>', 'Maximum records to return', parseLimit)
    .option('--json', 'Emit JSON')
    .action(options => withStore(store => {
      const records = store.list({ scope: options.scope, status: options.status, limit: options.limit })
        .filter(record => record.scope === options.scope);
      emit(records, options.json);
    }));

  experience.command('recall')
    .description('Recall verified experience for a scoped query')
    .requiredOption('--scope <project>', 'Canonical platform:projectKey', parseScope)
    .requiredOption('--query <text>', 'Current task or failure to match', parseText)
    .option('--json', 'Emit JSON')
    .action(options => withStore(store => {
      const records = store.recall({ scope: options.scope, prompt: options.query }).filter(record => record.scope === options.scope);
      emit(records, options.json);
    }));

  experience.command('record')
    .description('Record a candidate failure experience for a canonical work item')
    .requiredOption('--scope <project>', 'Canonical platform:projectKey', parseScope)
    .requiredOption('--trigger <text>', 'Observed failure trigger', parseText)
    .requiredOption('--root-cause <text>', 'Established root cause', parseText)
    .requiredOption('--action <text>', 'Proposed corrective action', parseText)
    .requiredOption('--run-id <id>', 'Source execution run ID', parseText)
    .requiredOption('--work-item-id <id>', 'Canonical work item ID', parseText)
    .requiredOption('--evidence <refs...>', 'Failure evidence references', collectEvidence)
    .action(options => {
      if (experienceScope(options.workItemId) !== options.scope) throw new Error('Work item does not belong to scope');
      return withStore(store => {
        const record = store.recordFailure({ scope: options.scope, trigger: options.trigger, rootCause: options.rootCause,
          action: options.action, source: { runId: options.runId, workItemId: options.workItemId }, evidence: options.evidence });
        process.stdout.write(`Recorded candidate ${record.id}\n`);
      });
    });

  experience.command('verify <id>')
    .description('Verify a scoped experience with correction evidence')
    .requiredOption('--scope <project>', 'Canonical platform:projectKey', parseScope)
    .requiredOption('--run-id <id>', 'Successful verification run ID', parseText)
    .requiredOption('--action <text>', 'Verified corrective action', parseText)
    .option('--root-cause <text>', 'Corrected root cause', parseText)
    .option('--root <path>', 'Local event-store root (defaults to AFK_EVENT_STORE_DIR)', parseText)
    .requiredOption('--evidence <refs...>', 'Verification evidence references', collectEvidence)
    .action((id, options) => withStore(async store => {
      parseText(id);
      requireScopedRecord(store, id, options.scope);
      const evidence = await (composition.verifyRun ?? verifyExperienceRun)({ scope: options.scope, runId: options.runId,
        evidence: options.evidence, ...(options.root === undefined ? {} : { root: options.root }) });
      store.verify(id, { evidence, runId: options.runId, action: options.action,
        ...(options.rootCause === undefined ? {} : { rootCause: options.rootCause }) });
      process.stdout.write(`Verified experience ${id}\n`);
    }));

  experience.command('revoke <id>')
    .description('Revoke an experience in an explicit project scope')
    .requiredOption('--scope <project>', 'Canonical platform:projectKey', parseScope)
    .action((id, options) => withStore(store => {
      parseText(id);
      requireScopedRecord(store, id, options.scope);
      store.revoke(id);
      process.stdout.write(`Revoked experience ${id}\n`);
    }));

  experience.command('export')
    .description('Export up to 100 live scoped lessons as portable JSON without verification authority (maximum 1 MiB)')
    .requiredOption('--scope <project>', 'Canonical platform:projectKey', parseScope)
    .option('--limit <count>', 'Maximum records to export (default 100)', parseLimit)
    .option('--output <file>', 'Write a new JSON file; otherwise emit JSON to stdout', parseText)
    .action(options => withStore(async store => {
      const json = store.export({ scope: options.scope, limit: options.limit });
      if (options.output) await fs.writeFile(options.output, `${json}\n`, { flag: 'wx', mode: 0o600 });
      else process.stdout.write(`${json}\n`);
    }));

  experience.command('import')
    .description('Import portable JSON into an explicit target project as candidates; local QA verification is required')
    .requiredOption('--scope <project>', 'Target canonical platform:projectKey', parseScope)
    .requiredOption('--file <file>', 'Portable JSON file (maximum 1 MiB, 100 lessons)', parseText)
    .action(async options => {
      const json = await readExchange(options.file);
      return withStore(store => emit(store.import({ scope: options.scope, json }), true));
    });

  experience.command('copy <id>')
    .description('Explicitly copy a live verified source lesson into another project as a candidate')
    .requiredOption('--scope <project>', 'Source canonical platform:projectKey', parseScope)
    .requiredOption('--target-scope <project>', 'Target canonical platform:projectKey', parseScope)
    .action((id, options) => withStore(store => emit([store.copy({ id, scope: options.scope, targetScope: options.targetScope })], true)));

  experience.command('metrics')
    .description('Read bounded persisted counts for retained scoped lessons; retrieval is separate from explicit adoption')
    .requiredOption('--scope <project>', 'Canonical platform:projectKey', parseScope)
    .option('--json', 'Emit JSON')
    .action(options => withStore(store => {
      const counts = store.metrics({ scope: options.scope });
      process.stdout.write(`${options.json ? JSON.stringify(counts) : `Retrievals: ${counts.retrievals}\nExplicit adoptions: ${counts.adoptions}\nRecurrences: ${counts.recurrences}`}\n`);
    }));

  experience.command('adopt <id>')
    .description('Explicitly acknowledge use of a verified lesson in an intact target run/task; this does not measure observed use (maximum 64 per lesson)')
    .requiredOption('--scope <project>', 'Canonical platform:projectKey', parseScope)
    .requiredOption('--run-id <id>', 'Run where the lesson was used', parseText)
    .requiredOption('--work-item-id <id>', 'Canonical target work item ID', parseText)
    .option('--root <path>', 'Local event-store root (defaults to AFK_EVENT_STORE_DIR)', parseText)
    .action((id, options) => {
      if (experienceScope(options.workItemId) !== options.scope) throw new Error('Work item does not belong to scope');
      return withStore(async store => {
        requireScopedRecord(store, id, options.scope);
        await (composition.verifyAdoptionRun ?? verifyAdoptionRun)({ scope: options.scope, runId: options.runId, workItemId: options.workItemId,
          ...(options.root === undefined ? {} : { root: options.root }) });
        const counts = store.adopt({ id, scope: options.scope, source: { runId: options.runId, workItemId: options.workItemId } });
        process.stdout.write(`${JSON.stringify(counts)}\n`);
      });
    });
}
