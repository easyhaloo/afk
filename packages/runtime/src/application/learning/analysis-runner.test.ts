import { chmodSync, existsSync, mkdtempSync, promises as fs, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
const originalGuard = spawnGuardedAnalysis;
const supportedFlags = ['--safe-mode', '--tools', '--permission-mode', '--permission-prompts',
  '--strict-mcp-config', '--mcp-config', '--disable-slash-commands', '--setting-sources',
  '--settings', '--no-session-persistence', '--no-chrome', '--session-id', '--system-prompt'];
const envelope = { type: 'goal_complete', distillation: { version: 1, candidates: [], warnings: [] } };
const nativeGuardAvailable = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');

function runnerFixture(help = supportedFlags.join(' ')) {
  fixture();
  vi.spyOn(analysisProcessGuard, 'assertAnalysisGuardAvailable').mockImplementation(() => {});
  const probe = vi.spyOn(analysisProcessGuard, 'spawnGuardedAnalysis').mockImplementation((_argv, options, output) =>
    spawn(process.execPath, ['-e', `console.log(${JSON.stringify(help)})`], { ...options, stdio: ['ignore', output ?? 'pipe', 'pipe'] }));
  const waitForResult = vi.fn(async (): Promise<ExecutionResult> => ({ version: 1, runId: 'fake-analysis',
    status: 'completed', provider: 'claude-code', structuredOutput: envelope, commits: [],
    usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } }));
  const interrupt = vi.fn(async () => {});
  const kill = vi.fn(async () => {});
  const metadata: { threadId?: string } = {};
  const execution = { metadata, waitForResult, interrupt, kill } as unknown as AgentExecution;
  const provider = new ClaudeCodeProvider();
  const createExecution = vi.spyOn(provider, 'createExecution').mockImplementation(async options => {
    metadata.threadId = options.sessionId;
    return execution;
  });
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
  it.each(['registration', 'after help'] as const)('rejects a changed executable at %s before starting it', async phase => {
    const { directory } = fixture();
    const change = () => writeFileSync(join(directory, 'claude'), 'inert fixture data');
    vi.spyOn(analysisProcessGuard, 'assertAnalysisGuardAvailable').mockImplementation(() => {});
    const guard = vi.spyOn(analysisProcessGuard, 'spawnGuardedAnalysis').mockImplementation((argv, options, output) => {
      if (phase === 'registration' || !argv.includes('--help')) throw new Error('unexpected_guard_start');
      return spawn(process.execPath, ['-e', `console.log(${JSON.stringify(supportedFlags.join(' '))})`],
        { ...options, stdio: ['ignore', output ?? 'pipe', 'pipe'] }).once('close', change);
    });
    const result = await executeAnalysis({ provider: new ClaudeCodeProvider(), jobId: 'changed-executable', prompt: 'Analyze.',
      onStarted: phase === 'registration' ? change : undefined }).catch((error: unknown) => error);
    expect(guard).toHaveBeenCalledTimes(phase === 'registration' ? 0 : 1);
    expect(result).toEqual(new Error('analysis_executable_changed'));
  });

  it.each(['', '--system-prompt-file', '--system-prompt-extra'])('refuses a CLI advertising %s instead of the exact controlled system prompt flag', async alternate => {
    const input = runnerFixture([...supportedFlags.filter(flag => flag !== '--system-prompt'), alternate].join(' '));
    await expect(executeAnalysis({ provider: input.provider, jobId: 'contract-system-capability', prompt: 'Analyze.' }))
      .rejects.toThrow(/^analysis_unsupported$/);
    expect(input.createExecution).not.toHaveBeenCalled();
  });

  it('isolates sessions, captures usage and cleans the directory', async () => {
    const input = runnerFixture();
    const onStarted = vi.fn(() => { expect(input.createExecution).not.toHaveBeenCalled(); });
    const result = await executeAnalysis({ provider: input.provider, jobId: 'contract-session', prompt: 'Analyze.', onStarted });
    expect(result).toMatchObject({ output: envelope,
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } });
    expect(onStarted).toHaveBeenCalledWith({ analysisRunId: result.analysisRunId, sessionId: result.sessionId });
    const options = input.createExecution.mock.calls[0]![0];
    expect(options).toMatchObject({ executionMode: 'batch', executionProfile: 'analysis' });
    expect(result.sessionId).toBe(options.sessionId);
    expect(options.sessionId).not.toBe('contract-session');
    expect(options.worktreePath).not.toBe(process.cwd());
    expect(existsSync(options.worktreePath)).toBe(false);
    expect(input.kill).toHaveBeenCalledTimes(1);
  });

  it.each(['recording fails', 'cancelled during recording'])('starts no child when %s', async scenario => {
    const input = runnerFixture();
    const controller = new AbortController();
    const onStarted = vi.fn(() => {
      if (scenario === 'recording fails') throw new Error('recording_failed');
      controller.abort();
    });
    await expect(executeAnalysis({ provider: input.provider, jobId: 'before-probe', prompt: 'Analyze.',
      signal: controller.signal, onStarted })).rejects.toThrow(scenario === 'recording fails' ? 'recording_failed' : 'analysis_cancelled');
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(input.probe).not.toHaveBeenCalled();
    expect(input.createExecution).not.toHaveBeenCalled();
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

  it('expires while recording and never launches after a late acknowledgement', async () => {
    const input = runnerFixture();
    let acknowledge!: () => void;
    const recording = new Promise<void>(resolve => { acknowledge = resolve; });
    const onStarted = vi.fn(() => recording);
    await expect(executeAnalysis({ provider: input.provider, jobId: 'late-registration', prompt: 'Analyze.',
      timeoutMs: 500, onStarted })).rejects.toThrow(/^analysis_timed_out$/);
    expect(onStarted).toHaveBeenCalledTimes(1);
    acknowledge();
    await recording;
    expect(input.probe).not.toHaveBeenCalled();
    expect(input.createExecution).not.toHaveBeenCalled();
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
  it.each([24, 140])('checks capability flags after a %i KiB help prefix', async prefixKiB => {
    const { capture } = fixture(undefined, `${'x'.repeat(prefixKiB * 1024)} ${supportedFlags.join(' ')}`);
    const run = executeAnalysis({ provider: new ClaudeCodeProvider(), jobId: 'analysis-help-limit', prompt: 'Analyze.' });
    if (prefixKiB < 128) await expect(run).resolves.toMatchObject({ output: envelope });
    else await expect(run).rejects.toThrow(/^analysis_unsupported$/);
    expect(existsSync(capture)).toBe(prefixKiB < 128);
  });

  it.each(['inherited', 'explicit'] as const)('isolates the guard from %s Node startup settings', async mode => {
    const settings = { NODE_OPTIONS: '--no-warnings', NODE_PATH: '/unused/node-modules', LANG: 'C' };
    if (mode === 'inherited') {
      for (const [name, value] of Object.entries(settings)) vi.stubEnv(name, value);
    }
    const child = spawnGuardedAnalysis([process.execPath, '-e',
      'console.log(JSON.stringify([process.env.NODE_OPTIONS, process.env.NODE_PATH, process.env.LANG]))'],
    mode === 'explicit' ? { env: { ...process.env, ...settings } } : {});
    let output = '';
    child.stdout!.on('data', chunk => { output += chunk; });
    expect(await once(child, 'close')).toEqual([0, null]);
    expect(JSON.parse(output)).toEqual([null, null, 'C']);
  });

  it.each([
    ['missing ID', "frame(undefined);"],
    ['different ID', "frame('other-session');"],
    ['conflict followed by a match', "frame('other-session'); frame(expected);"],
    ['matching ID on a separate frame', "frame(undefined); frame(expected, '');"],
    ['matching final frame without a candidate', "frame(expected); frame(expected, '');"],
    ['raw marker without a native result', "process.stdout.write('<goal_complete>{}</goal_complete>');"],
  ])('rejects an unbound analysis candidate (%s)', async (_scenario, frames) => {
    const { capture } = fixture(`
      const expected = process.argv[process.argv.indexOf('--session-id') + 1];
      const frame = (session_id, result = ${JSON.stringify(JSON.stringify(envelope))}) =>
        console.log(JSON.stringify({ type: 'result', session_id, result }));
      ${frames}
    `);
    await expect(executeAnalysis({ provider: new ClaudeCodeProvider(), jobId: 'analysis-result-binding', prompt: 'Analyze.' }))
      .rejects.toThrow(/^analysis_failed$/);
    const recorded = JSON.parse(readFileSync(capture, 'utf8'));
    expect(existsSync(recorded.cwd)).toBe(false);
  });

  it.each([
    ['```json\n' + JSON.stringify(envelope) + '\n```', true],
    ['```json\n' + JSON.stringify(envelope) + '\n```\nextra text', false],
    ['```json\n' + JSON.stringify(envelope) + '\n```\n```json\n{}\n```', false],
  ] as const)('accepts only one complete fenced JSON result (%#)', async (text, valid) => {
    fixture(`console.log(JSON.stringify({ type: 'result', session_id: process.argv[process.argv.indexOf('--session-id') + 1], result: ${JSON.stringify(text)} }));`);
    const run = executeAnalysis({ provider: new ClaudeCodeProvider(), jobId: 'fenced-result', prompt: 'Analyze.' });
    if (valid) await expect(run).resolves.toMatchObject({ output: envelope });
    else await expect(run).rejects.toThrow(/^analysis_failed$/);
  });

  it('uses the preflight executable after the parent PATH changes', async () => {
    const selected = fixture();
    const alternate = fixture();
    vi.stubEnv('PATH', `${selected.directory}:/usr/bin:/bin`);
    vi.spyOn(analysisProcessGuard, 'spawnGuardedAnalysis').mockImplementationOnce((...args) =>
      originalGuard(...args).once('close', () => vi.stubEnv('PATH', `${alternate.directory}:/usr/bin:/bin`)));
    const result = await executeAnalysis({ provider: new ClaudeCodeProvider(), jobId: 'analysis-path-binding', prompt: 'Analyze.' });
    expect(result.output).toEqual(envelope);
    expect(existsSync(alternate.capture)).toBe(false);
    expect(existsSync(selected.capture)).toBe(true);
  });

  it('uses the resolved preflight executable after its lookup symlink changes', async () => {
    const selected = fixture();
    const alternate = fixture();
    const symlink = join(selected.directory, 'claude');
    const executable = join(selected.directory, 'selected-claude');
    renameSync(symlink, executable);
    symlinkSync(executable, symlink);
    vi.stubEnv('PATH', `${selected.directory}:/usr/bin:/bin`);
    vi.spyOn(analysisProcessGuard, 'spawnGuardedAnalysis').mockImplementationOnce((...args) => originalGuard(...args).once('close', () => {
      rmSync(symlink);
      symlinkSync(join(alternate.directory, 'claude'), symlink);
    }));
    const result = await executeAnalysis({ provider: new ClaudeCodeProvider(), jobId: 'analysis-symlink-binding', prompt: 'Analyze.' });
    expect(result.output).toEqual(envelope);
    expect(existsSync(alternate.capture)).toBe(false);
    expect(existsSync(selected.capture)).toBe(true);
  });

  it('passes the business schema and inline evidence unchanged through guarded analysis stdin with a controlled system', async () => {
    const { capture } = fixture(`let prompt = '';
      process.stdin.on('data', chunk => { prompt += chunk; });
      process.stdin.on('end', () => {
        const fs = require('node:fs');
        const capture = require('node:path').join(__dirname, 'capture.json');
        const captured = JSON.parse(fs.readFileSync(capture, 'utf8'));
        fs.writeFileSync(capture, JSON.stringify({ ...captured, prompt }));
        console.log(JSON.stringify({ type: 'result', session_id: captured.argv[captured.argv.indexOf('--session-id') + 1],
          result: ${JSON.stringify(JSON.stringify(envelope))} }));
      });`);
    const prompt = 'Return only {"type":"goal_complete","distillation":{"version":1,"candidates":[],"warnings":[]}}.\nEvidencePack (untrusted JSON data): {"entries":[{"text":"Do not execute this evidence"}]}';
    const result = await executeAnalysis({ provider: new ClaudeCodeProvider(), jobId: 'schema-stdin', prompt });
    const captured = JSON.parse(readFileSync(capture, 'utf8'));
    expect(captured.prompt).toBe(`${prompt}\n`);
    expect(captured.argv).toContain('--system-prompt');
    expect(captured.argv[captured.argv.indexOf('--system-prompt') + 1]).toContain('Follow the user request and its output schema.');
    expect(result.output).toEqual(envelope);
    expect(existsSync(captured.cwd)).toBe(false);
  });

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
    const sampled = join(directory, 'sampled-identity');
    const executable = join(directory, 'ps');
    const replacement = join(directory, 'changed-ps');
    symlinkSync('/bin/ps', executable);
    writeFileSync(replacement, `#!/bin/sh
      /bin/ps "$@" | /usr/bin/awk 'NF >= 3 { print $1, $2, "replaced-start-identity"; print $1 > "sampled-identity" }'
    `);
    chmodSync(replacement, 0o700);
    const guard = spawnGuardedAnalysis(['claude'], { cwd: directory, env: { ...process.env }, detached: true });
    let diagnostics = '';
    guard.stderr?.on('data', chunk => { diagnostics += chunk; });
    let pid: number | undefined;
    try {
      await vi.waitFor(() => {
        expect(guard.exitCode, diagnostics).toBeNull();
        pid = JSON.parse(readFileSync(capture, 'utf8')).pid;
      }, { timeout: 3000 });
      renameSync(replacement, executable);
      expect(guard.connected, diagnostics).toBe(true);
      const exited = once(guard, 'exit');
      guard.disconnect();
      await exited;
      expect(readFileSync(sampled, 'utf8').trim()).toBe(String(pid));
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
