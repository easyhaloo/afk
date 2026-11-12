import { promises as fs } from 'node:fs';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlEventStore } from '@afk/runtime/infrastructure/observability/jsonl-event-store';
import { workspaceDataDirectory } from '@afk/runtime/infrastructure/workspace';
import { claudeProjectSlug } from '@afk/runtime/shared/agent-transcript-path';
import { registerRetroCommands, renderRetroHtml, reportSchema } from './retro.js';

const analysisMocks = vi.hoisted(() => ({ executeAnalysis: vi.fn() }));
vi.mock('@afk/runtime/execution', async importOriginal => ({
  ...await importOriginal<typeof import('@afk/runtime/execution')>(),
  executeAnalysis: analysisMocks.executeAnalysis,
}));

function analysisResult(report: unknown) {
  return { analysisRunId: 'retro-analysis', output: { type: 'goal_complete', report } };
}

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  analysisMocks.executeAnalysis.mockReset();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function createRetroFixture(options: { indexedPath?: string; workspace: string; eventRoot: string; sessionId: string }): Promise<void> {
  await fs.mkdir(options.workspace, { recursive: true });
  await fs.mkdir(join(workspaceDataDirectory(options.workspace), 'executions'), { recursive: true });
  await fs.writeFile(join(workspaceDataDirectory(options.workspace), 'executions', 'run-1.jsonl'), '');
  const store = new JsonlEventStore({ root: options.eventRoot });
  await store.append([{
    id: 'event-1', schemaVersion: 1, type: 'agent.session_recorded', sequence: 0,
    occurredAt: '2026-10-17T00:00:00.000Z', context: { traceId: 'trace-1', runId: 'run-1', workItemId: 'work-1', profileId: 'test', attempt: 1, actor: { kind: 'system', id: 'agent' } },
    correlationId: 'run-1', data: { kind: 'agent.session_recorded', sessionId: options.sessionId, ...(options.indexedPath ? { transcriptPath: options.indexedPath } : {}) },
  }]);
}

describe('retro command', () => {
  it('normalizes skill category names while validating the saved report contract', () => {
    const report = reportSchema.parse({
      version: 1,
      retroId: 'retro-1',
      executionId: 'run-1',
      runId: 'run-1',
      workItemId: 'local:work#1',
      source: 'final',
      summary: 'summary',
      metrics: { sessionCount: 1, toolCallCount: 2, failedToolCallCount: 0, retryCount: 0, checkFailureCount: 0, missingEvidenceCount: 0 },
      findings: [{
        id: 'F-1', category: 'process', severity: 'low', title: 'title', evidence: ['evidence://1'],
        rootCause: 'cause', recommendation: 'recommendation', confidence: 0.5, disposition: 'proposal',
      }],
      evidence: ['evidence://1'],
      generatedAt: '2026-10-17T00:00:00.000Z',
    });
    expect(report.findings[0].category).toBe('automated_checks');
  });

  it('renders a self-contained HTML report with escaped report content', () => {
    const report = reportSchema.parse({
      version: 1, retroId: 'retro-1', executionId: 'run-1', runId: 'run-1', workItemId: 'local:work#1',
      source: 'final', summary: '<unsafe>',
      metrics: { sessionCount: 1, toolCallCount: 2, failedToolCallCount: 0, retryCount: 0, checkFailureCount: 0, missingEvidenceCount: 0 },
      findings: [], evidence: ['evidence://1'], generatedAt: '2026-10-17T00:00:00.000Z',
    });
    const html = renderRetroHtml(report);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('&lt;unsafe&gt;');
    expect(html).toContain('evidence://1');
    expect(html).toContain('AFK 复盘报告');
    expect(html).toContain('摘要');
    expect(html).toContain('执行指标');
  });

  it('registers run and show with the required run inputs', () => {
    const program = new Command().name('afk').exitOverride();
    registerRetroCommands(program);
    const retro = program.commands.find(command => command.name() === 'retro');
    const run = retro?.commands.find(command => command.name() === 'run');
    const show = retro?.commands.find(command => command.name() === 'show');
    expect(run?.options.find(option => option.long === '--run-id')?.mandatory).toBe(true);
    expect(run?.options.find(option => option.long === '--workspace')?.mandatory).toBe(true);
    expect(show).toBeDefined();
  });

  it('shows a saved report without invoking the analysis provider', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'afk-retro-show-'));
    roots.push(root);
    const reportPath = join(root, 'report.json');
    await fs.writeFile(reportPath, JSON.stringify({ version: 1, retroId: 'retro-1' }));
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; });
    const program = new Command().name('afk');
    registerRetroCommands(program);
    await program.parseAsync(['node', 'afk', 'retro', 'show', reportPath, '--json']);
    expect(JSON.parse(output.join(''))).toEqual({ version: 1, retroId: 'retro-1' });
  });

  it('renders a saved report as human-readable text unless --json is set', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'afk-retro-show-text-'));
    roots.push(root);
    const reportPath = join(root, 'report.json');
    await fs.writeFile(reportPath, JSON.stringify({ version: 1, retroId: 'retro-1', summary: 'Summary text' }));
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; });
    const program = new Command().name('afk');
    registerRetroCommands(program);
    await program.parseAsync(['node', 'afk', 'retro', 'show', reportPath]);
    expect(output.join('')).toContain('Summary text');
    expect(output.join('')).not.toContain('"retroId"');
  });

  it('uses the indexed transcript path when the AFK session id differs from the provider id', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'afk-retro-indexed-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const eventRoot = join(root, 'events');
    const transcriptPath = join(root, 'native-session.jsonl');
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(transcriptPath, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }] } }) + '\n');
    await createRetroFixture({ workspace, eventRoot, indexedPath: transcriptPath, sessionId: 'synthetic-session' });
    analysisMocks.executeAnalysis.mockResolvedValue(analysisResult({ summary: 'ok', findings: [] }));

    const { runRetro } = await import('./retro.js');
    const report = await runRetro({ runId: 'run-1', executionId: 'run-1', workItemId: 'work-1', workspace, root: eventRoot, provider: 'claude-code' });

    expect(report.sessions).toEqual([{ sessionId: 'synthetic-session', source: 'transcript_found', transcriptPath }]);
    expect(report.metrics.toolCallCount).toBe(1);
  });

  it('analyzes only sanitized inline evidence without personal skill or repository mounts', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'afk-retro-inline-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const eventRoot = join(root, 'events');
    const transcriptPath = join(root, 'native-session.jsonl');
    await fs.mkdir(workspace);
    await fs.writeFile(transcriptPath, JSON.stringify({ type: 'user', message: { content: `password=hunter2 ${workspace}/private-file.ts` } }));
    await createRetroFixture({ workspace, eventRoot, indexedPath: transcriptPath, sessionId: 'session-1' });
    analysisMocks.executeAnalysis.mockResolvedValue(analysisResult({ summary: 'ok', findings: [] }));
    const { runRetro } = await import('./retro.js');
    await runRetro({ runId: 'run-1', executionId: 'run-1', workspace, root: eventRoot, provider: 'claude-code' });
    expect(analysisMocks.executeAnalysis).toHaveBeenCalledOnce();
    const [{ prompt, provider }] = analysisMocks.executeAnalysis.mock.calls[0] as [{ prompt: string; provider: { name: string } }];
    expect(provider.name).toBe('claude-code');
    expect(prompt).toContain('EvidencePack');
    expect(prompt).not.toContain('hunter2');
    expect(prompt).not.toContain(root);
    expect(prompt).not.toContain('/.claude/skills/retro');
  });

  it.each(['invented', 'source-uri', 'mixed', 'known'])('binds retro finding evidence to this pack: %s', async reference => {
    const root = await fs.mkdtemp(join(tmpdir(), 'afk-retro-refs-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const eventRoot = join(root, 'events');
    const transcriptPath = join(root, 'session.jsonl');
    await createRetroFixture({ workspace, eventRoot, indexedPath: transcriptPath, sessionId: 'session-1' });
    await fs.writeFile(transcriptPath, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }] } }));
    await fs.writeFile(join(workspaceDataDirectory(workspace), 'executions', 'run-1.jsonl'), '{"kind":"completed"}\n');
    analysisMocks.executeAnalysis.mockImplementation(async ({ prompt }: { prompt: string }) => {
      const pack = JSON.parse(prompt.split('\n').at(-1)!);
      const evidence = reference === 'known' ? [pack.entries[0].ref.id] : reference === 'source-uri' ? [`evidence://${pack.sources[0].sourceDigest}`]
        : reference === 'mixed' ? [pack.entries[0].ref.id, 'evidence:invented'] : ['evidence:invented'];
      return analysisResult({ summary: 'analysis', findings: [{ id: 'f1', category: 'information_access', severity: 'low', title: 'finding', evidence,
        rootCause: 'cause', recommendation: 'record', confidence: 1, disposition: 'record_only' }] });
    });
    const { runRetro } = await import('./retro.js');
    const report = await runRetro({ runId: 'run-1', executionId: 'run-1', workspace, root: eventRoot, provider: 'claude-code' });
    if (reference === 'known') {
      expect(report.source).toBe('final');
      expect(report.findings[0].id).toBe('f1');
    } else {
      expect(report.source).toBe('failure');
      expect(report.summary).toMatch(/unknown evidence/i);
      expect(report.findings[0].id).toBe('retro-execution-failed');
    }
  });

  it('rejects unknown finding references in an existing cached report', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'afk-retro-cached-refs-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const eventRoot = join(root, 'events');
    await createRetroFixture({ workspace, eventRoot, sessionId: 'session-1' });
    analysisMocks.executeAnalysis.mockImplementation(async ({ prompt }: { prompt: string }) => {
      const pack = JSON.parse(prompt.split('\n').at(-1)!);
      return analysisResult({ summary: 'partial analysis', findings: [{ id: 'f1', category: 'information_access', severity: 'low', title: 'finding',
        evidence: [pack.entries[0].ref.id], rootCause: 'cause', recommendation: 'record', confidence: 1, disposition: 'record_only' }] });
    });
    const { runRetro } = await import('./retro.js');
    const options = { runId: 'run-1', executionId: 'run-1', workspace, root: eventRoot, provider: 'claude-code' as const };
    const first = await runRetro(options);
    expect(first.source).toBe('provisional');
    const reportPath = join(workspaceDataDirectory(workspace), 'retro', first.retroId, 'report.json');
    await fs.writeFile(reportPath, JSON.stringify({ ...first, findings: [{ ...first.findings[0], evidence: ['evidence:invented'] }] }));
    const second = await runRetro(options);
    expect(analysisMocks.executeAnalysis).toHaveBeenCalledTimes(2);
    expect(second.source).toBe('provisional');
    expect(second.findings[0].evidence).not.toContain('evidence:invented');
  });

  it('counts retries from the frozen journal evidence when the live journal changes during analysis', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'afk-retro-frozen-journal-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const eventRoot = join(root, 'events');
    await createRetroFixture({ workspace, eventRoot, sessionId: 'session-1' });
    const journalPath = join(workspaceDataDirectory(workspace), 'executions', 'run-1.jsonl');
    await fs.writeFile(journalPath, '{"kind":"retry","attempt":1}\n');
    analysisMocks.executeAnalysis.mockImplementation(async () => {
      await fs.appendFile(journalPath, '{"kind":"retry","attempt":2}\n');
      return analysisResult({ summary: 'analysis', findings: [] });
    });
    const { runRetro } = await import('./retro.js');
    const report = await runRetro({ runId: 'run-1', executionId: 'run-1', workspace, root: eventRoot, provider: 'claude-code' });
    const pack = JSON.parse(await fs.readFile(join(workspaceDataDirectory(workspace), 'retro', report.retroId, 'input.json'), 'utf8'));
    expect(pack.entries.filter((entry: { position: { sourceId: string } }) => entry.position.sourceId === 'journal-1')).toHaveLength(1);
    expect((await fs.readFile(journalPath, 'utf8')).match(/retry/g)).toHaveLength(2);
    expect(report.metrics.retryCount).toBe(1);
  });

  it('does not follow transcript paths from a corrupt audit stream', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'afk-retro-corrupt-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const eventRoot = join(root, 'events');
    await createRetroFixture({ workspace, eventRoot, indexedPath: join(root, 'private.jsonl'), sessionId: 'session-1' });
    const auditPath = join(eventRoot, `${Buffer.from('run-1').toString('base64url')}.jsonl`);
    await fs.writeFile(auditPath, (await fs.readFile(auditPath, 'utf8')).replace('session-1', 'tampered-session'));
    analysisMocks.executeAnalysis.mockResolvedValue(analysisResult({ summary: 'incomplete', findings: [] }));
    const { runRetro } = await import('./retro.js');
    const report = await runRetro({ runId: 'run-1', executionId: 'run-1', workspace, root: eventRoot, provider: 'claude-code' });
    expect(report.sessions).toEqual([]);
    expect(report.source).toBe('provisional');
    expect(report.metrics.missingEvidenceCount).toBeGreaterThan(0);
  });

  it.each([false, true])('reads provider updates instead of archive copies (indexed archive: %s)', async indexedArchive => {
    const root = await fs.mkdtemp(join(tmpdir(), 'afk-retro-archive-'));
    roots.push(root);
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const workspace = join(root, 'workspace');
      const eventRoot = join(root, 'events');
      const archivedPath = join(root, '.afk', 'transcripts', 'agent-session.jsonl');
      await fs.mkdir(workspace, { recursive: true });
      await fs.mkdir(join(root, '.afk', 'transcripts'), { recursive: true });
      await fs.writeFile(archivedPath, JSON.stringify({ sessionId: 'agent-session' }) + '\n');
      const projectDir = join(root, '.claude', 'projects', claudeProjectSlug(realpathSync(workspace)));
      const transcriptPath = join(projectDir, 'agent-session.jsonl');
      await fs.mkdir(projectDir, { recursive: true });
      await fs.writeFile(transcriptPath, JSON.stringify({ type: 'assistant', sessionId: 'agent-session', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }] } }) + '\n');
      await createRetroFixture({ workspace, eventRoot, sessionId: 'agent-session', ...(indexedArchive ? { indexedPath: archivedPath } : {}) });
      analysisMocks.executeAnalysis.mockResolvedValue(analysisResult({ summary: 'ok', findings: [] }));

      const { runRetro } = await import('./retro.js');
      const report = await runRetro({ runId: 'run-1', executionId: 'run-1', workItemId: 'work-1', workspace, root: eventRoot, provider: 'claude-code' });

      expect(report.sessions?.[0]).toMatchObject({ sessionId: 'agent-session', transcriptPath });
      expect(report.metrics.toolCallCount).toBe(1);

      await fs.appendFile(transcriptPath, JSON.stringify({ type: 'assistant', sessionId: 'agent-session', message: { content: [{ type: 'tool_use', id: 'tool-2', name: 'Bash', input: {} }] } }) + '\n');
      const updated = await runRetro({ runId: 'run-1', executionId: 'run-1', workItemId: 'work-1', workspace, root: eventRoot, provider: 'claude-code' });
      expect(updated.metrics.toolCallCount).toBe(2);
      expect(updated.retroId).not.toBe(report.retroId);

      await fs.unlink(transcriptPath);
      const missing = await runRetro({ runId: 'run-1', executionId: 'run-1', workItemId: 'work-1', workspace, root: eventRoot, provider: 'claude-code' });
      expect(missing.sessions?.[0]?.source).toBe('transcript_missing');
      expect(missing.metrics.toolCallCount).toBe(0);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it('marks a legacy session as missing instead of guessing from another session in the same workspace', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'afk-retro-unindexed-'));
    roots.push(root);
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const workspace = join(root, 'workspace');
      const eventRoot = join(root, 'events');
      await fs.mkdir(workspace, { recursive: true });
      const realWorkspace = realpathSync(workspace);
      const projectDir = join(root, '.claude', 'projects', claudeProjectSlug(realWorkspace));
      const transcriptPath = join(projectDir, 'native-session.jsonl');
      await fs.mkdir(projectDir, { recursive: true });
      await fs.writeFile(transcriptPath, JSON.stringify({ cwd: realWorkspace, sessionId: 'native-session' }) + '\n' + JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }] } }) + '\n');
      await createRetroFixture({ workspace, eventRoot, sessionId: 'synthetic-session' });
      analysisMocks.executeAnalysis.mockResolvedValue(analysisResult({ summary: 'ok', findings: [] }));

      const { runRetro } = await import('./retro.js');
      const report = await runRetro({ runId: 'run-1', executionId: 'run-1', workItemId: 'work-1', workspace, root: eventRoot, provider: 'claude-code' });

      expect(report.sessions?.[0]?.source).toBe('transcript_missing');
      expect(report.metrics.toolCallCount).toBe(0);
      expect(report.source).toBe('provisional');
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});
