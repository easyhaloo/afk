import { Command, InvalidArgumentError, Option } from 'commander';
import { ExperienceStore, experienceScope, experienceStorePath, verifyExperienceRun } from '@afk/runtime/execution';
import type { CommandRegistrationContext } from '../command-registry.js';

type Store = Pick<ExperienceStore, 'recordFailure' | 'list' | 'get' | 'recall' | 'verify' | 'revoke' | 'close'>;

export interface ExperienceCommandComposition extends CommandRegistrationContext {
  createStore?: () => Store;
  verifyRun?: typeof verifyExperienceRun;
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

function collectEvidence(value: string, previous: string[] = []): string[] {
  return [...previous, parseText(value)];
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
}
