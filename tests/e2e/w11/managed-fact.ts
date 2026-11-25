import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect } from 'vitest';
import { recallCases } from './recall-v1.js';

const execute = promisify(execFile);
export const driver = fileURLToPath(new URL('../../fixtures/w11/managed-fact-consumer.mjs', import.meta.url));
const fact = recallCases.find(entry => entry.id === 'fact-01')!;

export function grade(answer: unknown, key: string) {
  expect(answer).toEqual({ answer: fact.asset.source, source: `knowledge:${key}; target:wiki:${fact.asset.key}`,
    productVersion: fact.query.target!.productVersions!.parcel });
}

export async function verifyManagedFact(input: {
  binary: string; runtime: string; fixture: string; runDirectory: string; itemId: string; cliVersion: string;
  entryCase: (typeof recallCases)[number];
  receipt: { publication: { key: string; targetRef: string }; producerRun: string; producerSession: string };
  restoreAuthority?: () => Promise<void>;
}) {
  const { binary, runtime, fixture, runDirectory, itemId, cliVersion, entryCase, receipt } = input;
  const userHome = userInfo().homedir;
  const workspace = join(runDirectory, 'workspace');
  await mkdir(workspace);
  const env = { ...process.env, HOME: fixture, USERPROFILE: fixture, AFK_EVENT_STORE_DIR: join(fixture, 'events') };
  const negative = entryCase.expected === 'exclude';
  const scope = entryCase.query.scope;
  const version = entryCase.query.target!.productVersions!.parcel;
  const origin = `knowledge:${receipt.publication.key}; target:${receipt.publication.targetRef}`;
  await writeFile(join(runDirectory, 'publication.json'), JSON.stringify({ cliVersion, ...receipt }, null, 2));
  console.info(`Managed ${entryCase.id} evidence: ${runDirectory}`);
  await execute(process.execPath, [driver, 'consume', runtime, fixture, entryCase.query.prompt, scope, runDirectory, itemId], {
    cwd: workspace, timeout: 180_000, env: { ...env, PWD: workspace, INIT_CWD: workspace,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? join(userHome, '.config'),
      XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? join(userHome, '.local/share') },
  });
  const report = JSON.parse(await readFile(join(runDirectory, 'result.json'), 'utf8'));
  expect(report.result).toEqual({ success: true });
  expect(report.workItemId).toBe(`${scope}#${itemId}`);
  expect(report.retrievals).toHaveLength(1);
  const [retrieval] = report.retrievals;
  expect(retrieval.query).toMatchObject({ scope, prompt: expect.stringContaining(entryCase.query.prompt),
    applicability: { environment: 'staging', version }, target: { project: scope, productVersions: { parcel: version } } });
  expect(retrieval.origins).toEqual(negative ? [] : [origin]);
  expect(report.events).toContainEqual(expect.objectContaining({ kind: 'step.completed', stepId: 'implement', outcome: 'succeeded' }));
  const native = report.events.find((event: { kind: string }) => event.kind === 'agent.session_recorded');
  expect(native?.sessionId).toMatch(/^ses_/);
  expect(native.sessionId).not.toBe(receipt.producerSession);
  expect(report.runId).not.toBe(receipt.producerRun);
  const answer = join(workspace, 'answer.json');
  expect((await lstat(answer)).isFile()).toBe(true);
  const response = JSON.parse(await readFile(answer, 'utf8'));
  if (!negative) {
    expect(report.events).toContainEqual(expect.objectContaining({ kind: 'decision.made', command: 'experience.recall', accepted: true }));
    grade(response, receipt.publication.key);
    return;
  }
  expect(response).toEqual({ answer: null, source: null, productVersion: null });
  expect(report.events).not.toContainEqual(expect.objectContaining({ command: 'experience.recall', accepted: true }));
  await expect(lstat(join(workspace, '.afk/experience-context.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  await input.restoreAuthority?.();
  const positiveVersion = fact.query.target!.productVersions!.parcel;
  const control = { ...retrieval.query, scope: fact.asset.scope, applicability: { ...retrieval.query.applicability, version: positiveVersion },
    target: { ...retrieval.query.target, project: fact.asset.scope, productVersions: { parcel: positiveVersion } } };
  const controlFile = join(runDirectory, 'control-query.json');
  await writeFile(controlFile, JSON.stringify(control));
  const gathered = await execute(process.execPath, [binary, 'plugin', 'invoke', 'context.provider', 'context.knowledge', 'gather', '--input', controlFile], { env, cwd: fixture });
  const fragments = JSON.parse(gathered.stdout);
  expect(fragments).toEqual([{ origin, content: expect.stringContaining(fact.asset.source) }]);
  const exported = await execute('opencode', ['session', 'export', native.sessionId, '--standalone'], { cwd: workspace, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, HOME: userHome, PWD: workspace, XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? join(userHome, '.local/share') } });
  const transcript = JSON.parse(exported.stdout);
  expect(transcript.info.id).toBe(native.sessionId);
  expect(transcript.messages).toContainEqual(expect.objectContaining({ type: 'user', text: expect.stringContaining(entryCase.query.prompt) }));
  expect(transcript.messages).toContainEqual(expect.objectContaining({ type: 'assistant' }));
  for (const marker of [receipt.publication.key, receipt.publication.targetRef, fact.asset.source]) {
    expect(JSON.stringify(transcript.messages).includes(marker)).toBe(false);
  }
  await writeFile(join(runDirectory, 'non-exposure.json'), JSON.stringify({ runId: report.runId, workItemId: report.workItemId,
    sessionId: native.sessionId, nativeMessages: transcript.messages.length, nativeExportSha256: createHash('sha256').update(exported.stdout).digest('hex'),
    exposedSourceMarkers: [], provider: 'context.knowledge', retrieval, control: { query: control, origins: [fragments[0].origin] } }, null, 2));
}
