import { chmodSync, existsSync, mkdtempSync, promises as fs, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeProvider } from '../../domain/agents/claude-code.js';
import { CursorProvider } from '../../domain/agents/cursor.js';
import { executeAnalysis } from './analysis-runner.js';

const directories: string[] = [];
const supportedFlags = ['--safe-mode', '--tools', '--permission-mode', '--permission-prompts',
  '--strict-mcp-config', '--mcp-config', '--disable-slash-commands', '--setting-sources',
  '--settings', '--no-session-persistence', '--no-chrome', '--session-id'];
const envelope = { type: 'goal_complete', distillation: { version: 1, candidates: [], warnings: [] } };

function fixture(body?: string, help = supportedFlags.join(' ')) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'learning-cli-')));
  directories.push(directory);
  const executable = join(directory, 'claude');
  const capture = join(directory, 'capture.json');
  writeFileSync(executable, `#!${process.execPath}\nif (process.argv.includes('--help')) {
    console.log(${JSON.stringify(help)}); process.exit(0);
  }
  require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid }));
  process.stdin.resume();
  ${body ?? `console.log(JSON.stringify({ type: 'result', session_id: process.argv[process.argv.indexOf('--session-id') + 1], result: ${JSON.stringify(JSON.stringify(envelope))}, usage: { input_tokens: 7, output_tokens: 3 } }));`}
  `);
  chmodSync(executable, 0o700);
  vi.stubEnv('PATH', `${directory}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`);
  return { capture, directory };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('restricted analysis process', () => {
  it('uses an isolated fresh session, captures usage and cleans its working directory', async () => {
    const { capture } = fixture();
    const onStarted = vi.fn(() => { expect(existsSync(capture)).toBe(false); });
    const result = await executeAnalysis({ provider: new ClaudeCodeProvider(), jobId: 'job-1', prompt: 'Analyze bounded evidence.', onStarted });
    expect(result).toMatchObject({ output: envelope, usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } });
    expect(onStarted).toHaveBeenCalledWith({ analysisRunId: result.analysisRunId, sessionId: result.sessionId });
    expect(result.analysisRunId).not.toBe('job-1');
    const recorded = JSON.parse(readFileSync(capture, 'utf8'));
    expect(recorded.cwd).not.toBe(process.cwd());
    expect(recorded.argv).toContain('--safe-mode');
    expect(recorded.argv[recorded.argv.indexOf('--tools') + 1]).toBe('');
    expect(existsSync(recorded.cwd)).toBe(false);
  });

  it('refuses an older CLI before model execution and rejects unqualified providers', async () => {
    const { capture } = fixture(undefined, '--tools --print');
    await expect(executeAnalysis({ provider: new ClaudeCodeProvider(), jobId: 'job-1', prompt: 'Analyze.' })).rejects.toThrow('analysis_unsupported');
    expect(existsSync(capture)).toBe(false);
    await expect(executeAnalysis({ provider: new CursorProvider(), jobId: 'job-1', prompt: 'Analyze.' })).rejects.toThrow('analysis_unsupported');
  });

  it('enforces a deadline and terminates only its owned process', async () => {
    const { capture } = fixture("process.on('SIGINT', () => {}); setInterval(() => {}, 1000);");
    await expect(executeAnalysis({ provider: new ClaudeCodeProvider(), jobId: 'job-timeout', prompt: 'Analyze.', timeoutMs: 2000 })).rejects.toThrow('analysis_timed_out');
    const recorded = JSON.parse(readFileSync(capture, 'utf8'));
    await vi.waitFor(() => expect(() => process.kill(recorded.pid, 0)).toThrow(), { timeout: 2000 });
    expect(existsSync(recorded.cwd)).toBe(false);
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });

  it('honors cancellation without exposing the cancellation reason', async () => {
    const { capture } = fixture("process.on('SIGINT', () => {}); setInterval(() => {}, 1000);");
    const controller = new AbortController();
    const pending = executeAnalysis({ provider: new ClaudeCodeProvider(), jobId: 'job-cancel', prompt: 'Analyze.', signal: controller.signal });
    const observed = expect(pending).rejects.toThrow('analysis_cancelled');
    await vi.waitFor(() => expect(existsSync(capture)).toBe(true), { timeout: 2000 });
    controller.abort(new Error('private-cancellation-reason'));
    await observed;
    const recorded = JSON.parse(readFileSync(capture, 'utf8'));
    await vi.waitFor(() => expect(() => process.kill(recorded.pid, 0)).toThrow(), { timeout: 2000 });
    expect(existsSync(recorded.cwd)).toBe(false);
  });

  it('does not leak CLI stderr or accept a failed analysis as output', async () => {
    fixture("console.error('private-token-example'); process.exit(2);");
    await expect(executeAnalysis({ provider: new ClaudeCodeProvider(), jobId: 'job-failed', prompt: 'Analyze.' })).rejects.toThrow(/^analysis_failed$/);
  });

  it('does not execute with already-cancelled input', async () => {
    const { capture } = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(executeAnalysis({ provider: new ClaudeCodeProvider(), jobId: 'job-1', prompt: 'Analyze.', signal: controller.signal })).rejects.toThrow('analysis_cancelled');
    expect(existsSync(capture)).toBe(false);
  });

  it('does not start an execution when cancelled during directory preparation', async () => {
    const { capture } = fixture();
    const controller = new AbortController();
    const mkdtemp = fs.mkdtemp.bind(fs);
    vi.spyOn(fs, 'mkdtemp').mockImplementationOnce(async (...args) => {
      const directory = await mkdtemp(...args);
      controller.abort();
      return directory;
    });
    const provider = new ClaudeCodeProvider();
    const createExecution = vi.spyOn(provider, 'createExecution');
    await expect(executeAnalysis({ provider, jobId: 'job-cancel-prepare', prompt: 'Analyze.', signal: controller.signal }))
      .rejects.toThrow('analysis_cancelled');
    expect(createExecution).not.toHaveBeenCalled();
    expect(existsSync(capture)).toBe(false);
  });
});
