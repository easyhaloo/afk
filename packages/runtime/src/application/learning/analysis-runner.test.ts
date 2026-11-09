import { chmodSync, existsSync, mkdtempSync, promises as fs, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeProvider } from '../../domain/agents/claude-code.js';
import { CursorProvider } from '../../domain/agents/cursor.js';
import type { AgentExecution, ExecutionResult } from '../../domain/agents/types.js';
import { executeAnalysis } from './analysis-runner.js';
import { LearningWorker, queryLearningState } from './worker.js';
import { spawnGuardedAnalysis } from '../../infrastructure/sandbox/providers/analysis-process-guard.js';
import * as analysisProcessGuard from '../../infrastructure/sandbox/providers/analysis-process-guard.js';

const directories: string[] = [];
const supportedFlags = ['--safe-mode', '--tools', '--permission-mode', '--permission-prompts',
  '--strict-mcp-config', '--mcp-config', '--disable-slash-commands', '--setting-sources',
  '--settings', '--no-session-persistence', '--no-chrome', '--session-id'];
const envelope = { type: 'goal_complete', distillation: { version: 1, candidates: [], warnings: [] } };
const nativeGuardAvailable = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');

function runnerFixture(help = supportedFlags.join(' ')) {
  const probe = vi.spyOn(analysisProcessGuard, 'spawnGuardedAnalysis').mockImplementation((_argv, options) =>
    spawn(process.execPath, ['-e', `console.log(${JSON.stringify(help)})`], options));
  const waitForResult = vi.fn(async (): Promise<ExecutionResult> => ({ version: 1, runId: 'fake-analysis',
    status: 'completed', provider: 'claude-code', structuredOutput: envelope, commits: [],
    usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } }));
  const interrupt = vi.fn(async () => {});
  const kill = vi.fn(async () => {});
  const execution = { metadata: { threadId: 'fake-session' }, waitForResult, interrupt, kill } as unknown as AgentExecution;
  const provider = new ClaudeCodeProvider();
  const createExecution = vi.spyOn(provider, 'createExecution').mockResolvedValue(execution);
  return { provider, createExecution, waitForResult, interrupt, kill, probe };
}

function fixture(body?: string, help = supportedFlags.join(' ')) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'learning-cli-')));
  directories.push(directory);
  const executable = join(directory, 'claude');
  const capture = join(directory, 'capture.json');
  writeFileSync(executable, `#!${process.execPath}\nif (process.argv.includes('--help')) {
    console.log(${JSON.stringify(help)}); process.exit(0);
  }
  require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid, ppid: process.ppid }));
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

describe('analysis platform refusal', () => {
  it.each(['linux', 'win32'])('reports analysis_unsupported on %s before CLI or execution startup', async platform => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const provider = new ClaudeCodeProvider();
    const createExecution = vi.spyOn(provider, 'createExecution');
    const mkdtemp = vi.spyOn(fs, 'mkdtemp');
    try {
      Object.defineProperty(process, 'platform', { value: platform });
      expect(() => spawnGuardedAnalysis(['unreachable-analysis-executable'], {})).toThrow('analysis_unsupported');
      await expect(executeAnalysis({ provider, jobId: 'unsupported-host', prompt: 'Analyze.' }))
        .rejects.toThrow(/^analysis_unsupported$/);
      expect(createExecution).not.toHaveBeenCalled();
      expect(mkdtemp).not.toHaveBeenCalled();
    } finally { Object.defineProperty(process, 'platform', descriptor); }
  });

  it.skipIf(nativeGuardAvailable)('refuses the actual host without native containment', async () => {
    const provider = new ClaudeCodeProvider();
    const createExecution = vi.spyOn(provider, 'createExecution');
    await expect(executeAnalysis({ provider, jobId: 'unsupported-native-host', prompt: 'Analyze.' }))
      .rejects.toThrow(/^analysis_unsupported$/);
    expect(createExecution).not.toHaveBeenCalled();
  });
});

describe('analysis runner contract with an inert probe and fake execution on every platform', () => {
  it('isolates sessions, captures usage and cleans the directory', async () => {
    const input = runnerFixture();
    const onStarted = vi.fn(() => { expect(input.createExecution).not.toHaveBeenCalled(); });
    const result = await executeAnalysis({ provider: input.provider, jobId: 'contract-session', prompt: 'Analyze.', onStarted });
    expect(result).toMatchObject({ sessionId: 'fake-session', output: envelope,
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } });
    expect(onStarted).toHaveBeenCalledWith({ analysisRunId: result.analysisRunId, sessionId: expect.any(String) });
    const options = input.createExecution.mock.calls[0]![0];
    expect(options).toMatchObject({ executionMode: 'batch', executionProfile: 'analysis' });
    expect(options.sessionId).not.toBe('contract-session');
    expect(options.worktreePath).not.toBe(process.cwd());
    expect(existsSync(options.worktreePath)).toBe(false);
    expect(input.kill).toHaveBeenCalledTimes(1);
  });

  it('refuses old CLI capabilities and unsupported providers before execution', async () => {
    const input = runnerFixture('--tools --print');
    await expect(executeAnalysis({ provider: input.provider, jobId: 'contract-old-cli', prompt: 'Analyze.' }))
      .rejects.toThrow(/^analysis_unsupported$/);
    expect(input.createExecution).not.toHaveBeenCalled();
    input.probe.mockClear();
    await expect(executeAnalysis({ provider: new CursorProvider(), jobId: 'contract-provider', prompt: 'Analyze.' }))
      .rejects.toThrow(/^analysis_unsupported$/);
    expect(input.probe).not.toHaveBeenCalled();
  });

  it('enforces a deadline and releases the execution and directory', async () => {
    const input = runnerFixture();
    input.waitForResult.mockImplementation(() => new Promise(() => {}));
    await expect(executeAnalysis({ provider: input.provider, jobId: 'contract-deadline', prompt: 'Analyze.', timeoutMs: 1000 }))
      .rejects.toThrow(/^analysis_timed_out$/);
    expect(input.interrupt).toHaveBeenCalledWith('manual');
    expect(input.kill).toHaveBeenCalledTimes(1);
    expect(existsSync(input.createExecution.mock.calls[0]![0].worktreePath)).toBe(false);
  });

  it('cancels execution without exposing the cancellation reason', async () => {
    const input = runnerFixture();
    input.waitForResult.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = executeAnalysis({ provider: input.provider, jobId: 'contract-cancel', prompt: 'Analyze.', signal: controller.signal });
    const observed = expect(pending).rejects.toThrow(/^analysis_cancelled$/);
    await vi.waitFor(() => expect(input.waitForResult).toHaveBeenCalledTimes(1));
    controller.abort(new Error('private-cancellation-reason'));
    await observed;
    expect(input.interrupt).toHaveBeenCalledWith('manual');
    expect(input.kill).toHaveBeenCalledTimes(1);
    expect(existsSync(input.createExecution.mock.calls[0]![0].worktreePath)).toBe(false);
  });

  it('rejects failed results without exposing private provider errors', async () => {
    const input = runnerFixture();
    input.waitForResult.mockResolvedValue({ version: 1, runId: 'fake-analysis', status: 'failed',
      provider: 'claude-code', commits: [], error: { code: 'private', message: 'private-token-example' } });
    await expect(executeAnalysis({ provider: input.provider, jobId: 'contract-failure', prompt: 'Analyze.' }))
      .rejects.toThrow(/^analysis_failed$/);
    expect(input.kill).toHaveBeenCalledTimes(1);
  });

  it('does not probe or execute already-cancelled input', async () => {
    const input = runnerFixture();
    const controller = new AbortController();
    controller.abort();
    await expect(executeAnalysis({ provider: input.provider, jobId: 'contract-pre-cancel', prompt: 'Analyze.', signal: controller.signal }))
      .rejects.toThrow(/^analysis_cancelled$/);
    expect(input.probe).not.toHaveBeenCalled();
    expect(input.createExecution).not.toHaveBeenCalled();
  });

  it('cancels during directory preparation before execution and removes the directory', async () => {
    const input = runnerFixture();
    const controller = new AbortController();
    let directory: string | undefined;
    const mkdtemp = fs.mkdtemp.bind(fs);
    vi.spyOn(fs, 'mkdtemp').mockImplementationOnce(async (...args) => {
      directory = await mkdtemp(...args);
      controller.abort();
      return directory;
    });
    await expect(executeAnalysis({ provider: input.provider, jobId: 'contract-prepare', prompt: 'Analyze.', signal: controller.signal }))
      .rejects.toThrow(/^analysis_cancelled$/);
    expect(input.createExecution).not.toHaveBeenCalled();
    expect(directory).toBeDefined();
    expect(existsSync(directory!)).toBe(false);
  });
});

describe.skipIf(!nativeGuardAvailable)('macOS native analysis containment (sandbox-exec required)', () => {
  it('contains preflight forks and terminates the probe after Worker SIGKILL', async () => {
    const { directory, capture } = fixture();
    const deniedFile = join(directory, 'preflight-denied.json');
    const escapedFile = join(directory, 'preflight-escaped.pid');
    writeFileSync(join(directory, 'claude'), `#!${process.execPath}
      const fs = require('node:fs');
      if (!process.argv.includes('--help')) process.exit(2);
      fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ pid: process.pid, ppid: process.ppid }));
      const denied = error => fs.writeFileSync(${JSON.stringify(deniedFile)}, JSON.stringify({ code: error.code }));
      try {
        const escaped = require('node:child_process').spawn('/bin/sh', ['-c', 'exec sleep 30'], { detached: true, stdio: 'ignore' });
        escaped.on('error', denied);
        if (escaped.pid) fs.writeFileSync(${JSON.stringify(escapedFile)}, String(escaped.pid));
      } catch (error) { denied(error); }
      process.on('SIGINT', () => {}); setInterval(() => {}, 1000);
    `);
    const parent = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./worker-recovery.fixture.mjs', import.meta.url)), directory],
      { cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe'] });
    let diagnostics = '';
    parent.stderr.on('data', chunk => { diagnostics += chunk; });
    let probe: { pid: number; ppid: number } | undefined;
    try {
      await vi.waitFor(() => {
        expect(parent.exitCode, diagnostics).toBeNull();
        probe = JSON.parse(readFileSync(capture, 'utf8'));
        expect(JSON.parse(readFileSync(deniedFile, 'utf8'))).toEqual({ code: 'EPERM' });
      }, { timeout: 8000 });
      const exited = once(parent, 'exit');
      const killedAt = Date.now();
      parent.kill('SIGKILL');
      await exited;
      await vi.waitFor(() => {
        expect(() => process.kill(probe!.pid, 0)).toThrow();
        expect(() => process.kill(probe!.ppid, 0)).toThrow();
      }, { timeout: 4500, interval: 50 });
      expect(Date.now() - killedAt).toBeLessThan(5000);
    } finally {
      parent.kill('SIGKILL');
      if (probe?.pid) { try { process.kill(probe.pid, 'SIGKILL'); } catch {} }
      if (existsSync(escapedFile)) {
        try { process.kill(-Number(readFileSync(escapedFile, 'utf8')), 'SIGKILL'); } catch {}
      }
    }
  });

  it('refuses to launch analysis when ownership cannot be established', async () => {
    const { directory, capture } = fixture("setInterval(() => {}, 1000);");
    writeFileSync(join(directory, 'ps'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(directory, 'ps'), 0o700);
    const guard = spawnGuardedAnalysis(['claude'], { cwd: directory, env: { ...process.env } });
    guard.stderr?.resume();
    let pid: number | undefined;
    try {
      await once(guard, 'exit');
      if (existsSync(capture)) pid = JSON.parse(readFileSync(capture, 'utf8')).pid;
      expect(existsSync(capture)).toBe(false);
    } finally {
      guard.kill('SIGKILL');
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
  });

  it.each([false, true])('contains or refuses detached shell escape through a short-lived intermediate (immediate analysis exit: %s)', async immediateExit => {
    const { directory, capture } = fixture(`
      const fs = require('node:fs');
      const path = require('node:path');
      const fixtureDirectory = path.dirname(process.argv[1]);
      const denied = error => {
        fs.writeFileSync(path.join(fixtureDirectory, 'escape-denied.json'), JSON.stringify({ code: error.code }));
        ${immediateExit ? 'process.exit(1);' : ''}
      };
      try {
        const child = require('node:child_process').spawn('/bin/sh', ['-c', 'sleep 30 & echo $! > "$1"', 'escape', path.join(fixtureDirectory, 'escaped.pid')], { detached: true, stdio: 'ignore' });
        child.on('error', denied);
        child.on('exit', () => {
          fs.writeFileSync(path.join(fixtureDirectory, 'intermediate-exited'), 'ready');
          ${immediateExit ? 'process.exit(1);' : ''}
        });
      } catch (error) { denied(error); }
      process.on('SIGINT', () => {}); setInterval(() => {}, 1000);
    `);
    const parent = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./worker-recovery.fixture.mjs', import.meta.url)), directory],
      { cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe'] });
    let diagnostics = '';
    parent.stderr.on('data', chunk => { diagnostics += chunk; });
    let analysis: { pid: number; cwd: string } | undefined;
    let escapedPid: number | undefined;
    let denial: { code: string } | undefined;
    try {
      await vi.waitFor(() => {
        expect(parent.exitCode, diagnostics).toBeNull();
        analysis = JSON.parse(readFileSync(capture, 'utf8'));
        const denied = join(directory, 'escape-denied.json');
        if (existsSync(denied)) denial = JSON.parse(readFileSync(denied, 'utf8'));
        else {
          escapedPid = Number(readFileSync(join(directory, 'escaped.pid'), 'utf8').trim());
          expect(escapedPid).toBeGreaterThan(0);
          expect(existsSync(join(directory, 'intermediate-exited'))).toBe(true);
        }
      }, { timeout: 8000 });
      const exited = once(parent, 'exit');
      const killedAt = Date.now();
      parent.kill('SIGKILL');
      await exited;
      await vi.waitFor(() => {
        expect(() => process.kill(analysis!.pid, 0)).toThrow();
        if (escapedPid) expect(() => process.kill(escapedPid!, 0)).toThrow();
      }, { timeout: 4500, interval: 50 });
      expect(Date.now() - killedAt).toBeLessThan(5000);
      if (denial) expect(denial.code).toBe('EPERM');
      else expect(escapedPid).toBeGreaterThan(0);
    } finally {
      parent.kill('SIGKILL');
      for (const pid of [analysis?.pid, escapedPid]) if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      if (analysis) rmSync(analysis.cwd, { recursive: true, force: true });
    }
  });

  it('does not signal a recorded PID whose start identity no longer matches', async () => {
    const { directory, capture } = fixture("setInterval(() => {}, 1000);");
    const changed = join(directory, 'changed-identity');
    const sampled = join(directory, 'sampled-identity');
    const executable = join(directory, 'ps');
    writeFileSync(executable, `#!${process.execPath}
      const fs = require('node:fs');
      let output = require('node:child_process').execFileSync('/bin/ps', process.argv.slice(2), { encoding: 'utf8' });
      if (fs.existsSync(${JSON.stringify(capture)})) {
        const { pid } = JSON.parse(fs.readFileSync(${JSON.stringify(capture)}, 'utf8'));
        output = output.split('\\n').map(line => {
          const match = line.trim().match(/^(\\d+)\\s+(\\d+)\\s+(.+)$/);
          if (!match || Number(match[1]) !== pid) return line;
          if (fs.existsSync(${JSON.stringify(changed)})) return match[1] + ' ' + match[2] + ' replaced-start-identity';
          return line;
        }).join('\\n');
      }
      fs.writeFileSync(${JSON.stringify(sampled)}, 'ready');
      process.stdout.write(output);
    `);
    chmodSync(executable, 0o700);
    const guard = spawnGuardedAnalysis(['claude'], { cwd: directory, env: { ...process.env }, detached: true });
    let diagnostics = '';
    guard.stderr?.on('data', chunk => { diagnostics += chunk; });
    let pid: number | undefined;
    try {
      await vi.waitFor(() => {
        expect(existsSync(sampled)).toBe(true);
        pid = JSON.parse(readFileSync(capture, 'utf8')).pid;
      }, { timeout: 3000 });
      writeFileSync(changed, 'simulate PID reuse');
      expect(guard.connected, diagnostics).toBe(true);
      const exited = once(guard, 'exit');
      guard.disconnect();
      await exited;
      expect(() => process.kill(pid!, 0)).not.toThrow();
    } finally {
      guard.kill('SIGKILL');
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
  });

  it('refuses detached descendants and kills analysis within five seconds of Worker SIGKILL without a restart', async () => {
    const { directory, capture } = fixture(`
      const { spawn } = require('node:child_process');
      const denied = error => require('node:fs').writeFileSync('descendant-denied.json', JSON.stringify({ code: error.code }));
      try {
        spawn(process.execPath, ['-e', "setInterval(() => {}, 1000)"], { detached: true, stdio: 'ignore' }).on('error', denied);
      } catch (error) { denied(error); }
      process.on('SIGINT', () => {}); setInterval(() => {}, 1000);
    `);
    const parent = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./worker-recovery.fixture.mjs', import.meta.url)), directory],
      { cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostics = '';
    parent.stderr.on('data', chunk => { diagnostics += chunk; });
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
    let analysis: { pid: number; ppid: number; cwd: string } | undefined;
    try {
      await vi.waitFor(() => {
        expect(parent.exitCode, diagnostics).toBeNull();
        analysis = JSON.parse(readFileSync(capture, 'utf8'));
        expect(JSON.parse(readFileSync(join(analysis!.cwd, 'descendant-denied.json'), 'utf8'))).toEqual({ code: 'EPERM' });
      }, { timeout: 8000 });
      const exited = once(parent, 'exit');
      const killedAt = Date.now();
      parent.kill('SIGKILL');
      await exited;
      await vi.waitFor(() => {
        expect(() => process.kill(analysis!.pid, 0)).toThrow();
        expect(() => process.kill(analysis!.ppid, 0)).toThrow();
      }, { timeout: 4500, interval: 50 });
      expect(Date.now() - killedAt).toBeLessThan(5000);
      expect(() => process.kill(process.pid, 0)).not.toThrow();
      expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
      const analyze = vi.fn();
      const recovered = new LearningWorker({ directory: join(directory, 'learning'), enabled: true,
        provider: new ClaudeCodeProvider(), analyze });
      try {
        await recovered.runOnce();
        expect(analyze).not.toHaveBeenCalled();
        expect(queryLearningState({ directory: join(directory, 'learning'), scope: 'github:acme/api' }).jobs[0])
          .toMatchObject({ reasonCode: 'analysis_outcome_unknown', attempts: [{ status: 'started' }] });
      } finally { await recovered.close(); }
    } finally {
      parent.kill('SIGKILL');
      unrelated.kill('SIGKILL');
      if (analysis?.pid) { try { process.kill(analysis.pid, 'SIGKILL'); } catch {} }
      if (analysis) rmSync(analysis.cwd, { recursive: true, force: true });
    }
  });

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
