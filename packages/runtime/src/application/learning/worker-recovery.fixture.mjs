import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeCodeProvider } from '../../domain/agents/claude-code.ts';
import { buildEvidencePack } from './evidence.ts';
import { LearningWorker, submitDistillation } from './worker.ts';

const root = process.argv[2];
const file = join(root, 'evidence.txt');
writeFileSync(file, 'Require approval before publishing.');
const pack = await buildEvidencePack({ sources: [{ id: 'session-1', kind: 'journal', path: file, allowedRoot: root, format: 'text' }] });
const directory = join(root, 'learning');
await submitDistillation({ directory, pack, request: { version: 1, scope: 'github:acme/api', sourceId: 'run:r1',
  sourceRunId: 'r1', evidenceDigest: pack.digest, analyzerVersion: '1', reason: 'completed' } });
const worker = new LearningWorker({ directory, enabled: true, provider: new ClaudeCodeProvider() });
await worker.watch(new AbortController().signal);
