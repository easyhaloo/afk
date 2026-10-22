import { promises as fs } from 'node:fs';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlEventStore } from '@afk/runtime/infrastructure/observability/jsonl-event-store';
import { claudeProjectSlug } from '@afk/runtime/shared/agent-transcript-path';
import { registerRetroCommands, renderRetroHtml, reportSchema } from './retro.js';

const childProcessMocks = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: childProcessMocks.execFile }));

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  childProcessMocks.execFile.mockReset();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function createRetroFixture(options: { indexedPath?: string; workspace: string; eventRoot: string; sessionId: string }): Promise<void> {
  await fs.mkdir(join(options.workspace, '.afk', 'executions'), { recursive: true });
  await fs.writeFile(join(options.workspace, '.afk', 'executions', 'run-1.jsonl'), '');
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

  it('uses the indexed transcript path when the AFK session id differs from the provider id', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'afk-retro-indexed-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const eventRoot = join(root, 'events');
    const transcriptPath = join(root, 'native-session.jsonl');
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(transcriptPath, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }] } }) + '\n');
    await createRetroFixture({ workspace, eventRoot, indexedPath: transcriptPath, sessionId: 'synthetic-session' });
    childProcessMocks.execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: (error: null, result: { stdout: string; stderr: string }) => void) => callback(null, { stdout: JSON.stringify({ summary: 'ok', findings: [] }), stderr: '' }));

    const { runRetro } = await import('./retro.js');
    const report = await runRetro({ runId: 'run-1', executionId: 'run-1', workItemId: 'work-1', workspace, root: eventRoot, provider: 'claude-code' });

    expect(report.sessions).toEqual([{ sessionId: 'synthetic-session', source: 'transcript_found', transcriptPath }]);
    expect(report.metrics.toolCallCount).toBe(1);
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
      childProcessMocks.execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: (error: null, result: { stdout: string; stderr: string }) => void) => callback(null, { stdout: JSON.stringify({ summary: 'ok', findings: [] }), stderr: '' }));

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
      childProcessMocks.execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: (error: null, result: { stdout: string; stderr: string }) => void) => callback(null, { stdout: JSON.stringify({ summary: 'ok', findings: [] }), stderr: '' }));

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
