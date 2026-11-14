import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { StreamingAgentExecution } from './streaming.js';
import { CodexProvider } from '../../../domain/agents/codex.js';
import { mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { ClaudeCodeProvider } from '../../../domain/agents/claude-code.js';

function command(script: string) {
  return { argv: [process.execPath, '-e', script], cwd: process.cwd() };
}

const PROCESS_METADATA = { provider: 'claude-code', transport: 'process' } as const;

describe('StreamingAgentExecution', () => {
  describe('UTF-8 byte streaming', () => {
    async function receive(chunks: Buffer[], stream: 'stdout' | 'stderr' = 'stdout', exitCode = 0) {
      const provider = new ClaudeCodeProvider();
      const parseLine = vi.fn(provider.parseLine.bind(provider));
      const script = `process.stdin.resume(); process.stdin.once('end', () => {
        const chunks = ${JSON.stringify(chunks.map(chunk => [...chunk]))};
        const write = () => {
          const chunk = chunks.shift();
          if (!chunk) { process.exitCode = ${exitCode}; return; }
          process.${stream}.write(Buffer.from(chunk));
          setTimeout(write, 120);
        };
        write();
      });`;
      const execution = new StreamingAgentExecution({ command: command(script), prompt: 'inert UTF-8 fixture',
        signalType: 'goal_complete', worktreePath: process.cwd(), metadata: { ...PROCESS_METADATA }, parseLine });
      execution.start();
      const child = (execution as unknown as { proc: ChildProcessWithoutNullStreams }).proc;
      const received: number[] = [];
      child[stream].on('data', (chunk: Buffer) => received.push(chunk.length));
      try {
        await once(child, 'close', { signal: AbortSignal.timeout(5000) });
        expect(received).toEqual(chunks.map(chunk => chunk.length));
        const result = await execution.waitForResult({ completionTimeoutMs: 5000 });
        return { result, output: await execution.captureOutput(), metadata: execution.metadata, parseLine };
      } finally { await execution.kill(); }
    }

    function splitDetail(payload: string): Buffer[] {
      const bytes = Buffer.from(payload);
      const latin = bytes.indexOf(Buffer.from('é'));
      const chinese = bytes.indexOf(Buffer.from('错'));
      const emoji = bytes.indexOf(Buffer.from('🧪'));
      const cuts = [0, latin + 1, chinese + 1, chinese + 2, emoji + 1, emoji + 2, emoji + 3, bytes.length];
      return cuts.slice(1).map((end, index) => bytes.subarray(cuts[index]!, end));
    }

    for (const source of ['native', 'legacy'] as const) {
      it.each(['\n', '\r\n', ''])('preserves ' + source + ' details across byte chunks (ending: %j)', async ending => {
        const detail = 'é错误🧪';
        const event = { type: 'result', is_error: true, session_id: 'utf8-session',
          usage: { input_tokens: 2, output_tokens: 3 },
          ...(source === 'native' ? { errors: [detail] } : { result: detail }) };
        const line = JSON.stringify(event);
        const observed = await receive(splitDetail(line + ending));
        expect(observed.output).toBe(line + ending);
        expect(observed.parseLine).toHaveBeenCalledWith(line + (ending === '\r\n' ? '\r' : ''));
        const events = new ClaudeCodeProvider().parseLine(line);
        expect(events.map(event => event.type)).toEqual(['usage', 'session', 'error', 'result']);
        expect(observed.result).toMatchObject({ status: 'failed', exitCode: 0,
          error: { code: 'AGENT_ERROR', message: events.find(event => event.type === 'error')!.error.message },
          usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } });
        expect(observed.metadata.threadId).toBe('utf8-session');
      });
    }

    it.each(['\n', ''])('preserves stderr details and nonzero-exit precedence (ending: %j)', async ending => {
      const detail = 'é错误🧪' + ending;
      const observed = await receive(splitDetail(detail), 'stderr', 7);
      expect(observed.output).toBe(detail);
      expect(observed.result).toMatchObject({ status: 'failed', exitCode: 7,
        error: { code: 'NON_ZERO_EXIT', message: detail.trim() } });
    });

    it.each(['\n', ''])('preserves a Unicode completion across byte chunks (ending: %j)', async ending => {
      const line = JSON.stringify({ type: 'result', result: JSON.stringify({ type: 'goal_complete', summary: 'é错误🧪' }) });
      const observed = await receive(splitDetail(line + ending));
      expect(observed.result).toMatchObject({ status: 'completed', structuredOutput: { type: 'goal_complete', summary: 'é错误🧪' } });
    });

    it.each(['stdout', 'stderr'] as const)('flushes an incomplete %s codepoint once at EOF', async stream => {
      const bytes = Buffer.concat([Buffer.from(stream === 'stdout' ? '{"type":"result","result":"' : 'diagnostic:'), Buffer.from([0xf0, 0x9f])]);
      const observed = await receive([bytes], stream, stream === 'stderr' ? 7 : 0);
      expect(observed.output).toBe(bytes.toString('utf8'));
      expect(observed.result).toMatchObject({ status: 'failed', error: stream === 'stdout'
        ? { code: 'MISSING_RESULT' } : { code: 'NON_ZERO_EXIT', message: bytes.toString('utf8') } });
    });
  });

  it.skipIf(process.platform === 'win32').each(['ignore', 'inherit'] as const)(
    'confirms detached descendants are stopped after the root exits naturally (%s output)', async output => {
      const script = `const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
          { detached: true, stdio: ['ignore', '${output}', 'ignore'] });
        console.log('descendant:' + child.pid); child.unref();`;
      const execution = new StreamingAgentExecution({ command: command(script), prompt: 'go', signalType: 'goal_complete',
        worktreePath: process.cwd(), metadata: PROCESS_METADATA });
      execution.start();
      const root = (execution as unknown as { proc: ChildProcessWithoutNullStreams }).proc;
      let descendant: number | undefined;
      try {
        await once(root, 'exit', { signal: AbortSignal.timeout(5000) });
        await vi.waitFor(async () => expect(await execution.captureOutput()).toMatch(/descendant:\d+/));
        descendant = Number((await execution.captureOutput()).match(/descendant:(\d+)/)![1]);
        expect(() => process.kill(descendant!, 0)).not.toThrow();
        await execution.kill();
        expect(() => process.kill(descendant!, 0)).toThrow();
      } finally {
        if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch {} }
        await execution.kill();
      }
    });

  it('resolves concurrent kills only after the child has actually exited', async () => {
    const execution = new StreamingAgentExecution({ command: command('console.log("ready"); setInterval(() => {}, 1000)'),
      prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(), metadata: PROCESS_METADATA });
    execution.start();
    const child = (execution as unknown as { proc: ChildProcessWithoutNullStreams }).proc;
    let exited = false;
    child.once('exit', () => { exited = true; });
    try {
      await vi.waitFor(async () => expect(await execution.captureOutput()).toContain('ready'));
      await Promise.all([execution.kill(), execution.kill()]);
      expect(exited).toBe(true);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      await execution.kill();
      if (!exited) await once(child, 'exit', { signal: AbortSignal.timeout(2000) });
    }
  });

  it.skipIf(process.platform === 'win32')('does not stop another execution in the same workspace', async () => {
    const executions = [0, 1].map(() => new StreamingAgentExecution({ command: command('console.log("ready:" + process.pid); setInterval(() => {}, 1000)'),
      prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(), metadata: PROCESS_METADATA }));
    for (const execution of executions) execution.start();
    try {
      for (const execution of executions) await vi.waitFor(async () => expect(await execution.captureOutput()).toMatch(/ready:\d+/));
      const otherPid = Number((await executions[1].captureOutput()).match(/ready:(\d+)/)![1]);
      await executions[0].kill();
      expect(() => process.kill(otherPid, 0)).not.toThrow();
    } finally { await Promise.all(executions.map(execution => execution.kill())); }
  });

  it('rejects an unconfirmed stop and allows a later termination retry', async () => {
    const execution = new StreamingAgentExecution({ command: command('console.log("ready"); setInterval(() => {}, 1000)'),
      prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(), metadata: PROCESS_METADATA });
    execution.start();
    const child = (execution as unknown as { proc: ChildProcessWithoutNullStreams }).proc;
    const signalling = vi.spyOn(execution as unknown as { signalProcess(signal: NodeJS.Signals): void }, 'signalProcess');
    try {
      await vi.waitFor(async () => expect(await execution.captureOutput()).toContain('ready'));
      signalling.mockImplementation(() => {});
      await expect(execution.kill()).rejects.toThrow(/did not exit/);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      signalling.mockRestore();
      await execution.kill();
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      signalling.mockRestore();
      await execution.kill();
    }
  });

  describe('stdout drain after process exit', () => {
    const executions: StreamingAgentExecution[] = [];
    const inheritedPids: number[] = [];

    afterEach(async () => {
      for (const execution of executions.splice(0)) {
        const child = (execution as unknown as { proc: ChildProcessWithoutNullStreams }).proc;
        child.stdout.resume();
        child.stderr.resume();
        await execution.kill();
      }
      for (const pid of inheritedPids.splice(0)) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    });

    async function exitedWithPausedOutput(script: string, analysisParentGuard = false, native = true) {
      const provider = new ClaudeCodeProvider();
      const execution = new StreamingAgentExecution({
        command: command(script), prompt: 'inert local fixture', signalType: 'goal_complete',
        worktreePath: process.cwd(), metadata: PROCESS_METADATA, analysisParentGuard,
        parseLine: native ? provider.parseLine.bind(provider) : undefined,
      });
      executions.push(execution);
      execution.start();
      const child = (execution as unknown as { proc: ChildProcessWithoutNullStreams }).proc;
      child.stdout.pause();
      child.stderr.pause();
      const events: string[] = [];
      child.on('exit', () => events.push('exit'));
      child.stdout.on('data', () => events.push('data'));
      child.on('close', () => events.push('close'));
      const closed = once(child, 'close');
      await once(child, 'exit', { signal: AbortSignal.timeout(5000) });
      expect(events[0]).toBe('exit');
      return { execution, child, closed, events };
    }

    async function exitedWithInheritedOutput(pipe: 'stdout' | 'stderr') {
      const holder = 'setInterval(() => {}, 10000)';
      const script = `process.stdin.resume(); process.stdin.once('end', () => {
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['-e', ${JSON.stringify(holder)}], {
          detached: true, stdio: ['ignore', ${pipe === 'stdout' ? "'inherit'" : "'ignore'"}, ${pipe === 'stderr' ? "'inherit'" : "'ignore'"}],
        });
        child.unref(); process.stdout.write('holder:' + child.pid + '\\n');
      });`;
      const execution = new StreamingAgentExecution({ command: command(script), prompt: 'inert local fixture',
        signalType: 'goal_complete', worktreePath: process.cwd(), metadata: PROCESS_METADATA });
      executions.push(execution);
      execution.start();
      const child = (execution as unknown as { proc: ChildProcessWithoutNullStreams }).proc;
      const closed = once(child, 'close');
      await once(child, 'exit', { signal: AbortSignal.timeout(5000) });
      await vi.waitFor(async () => expect(await execution.captureOutput()).toMatch(/holder:\d+/));
      const pid = Number((await execution.captureOutput()).match(/holder:(\d+)/)![1]);
      inheritedPids.push(pid);
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(child[pipe].destroyed).toBe(false);
      return { execution, child, closed };
    }

    for (const analysisParentGuard of [false, true]) {
      it.skipIf(analysisParentGuard && (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')))
        .each([true, false])('consumes a valid result after exit before close (guarded: ' + analysisParentGuard + ', newline: %s)', async newline => {
          const payload = JSON.stringify({ type: 'result', result: JSON.stringify({ type: 'goal_complete', summary: 'tail delivered' }),
            usage: { input_tokens: 2, output_tokens: 3 } }) + (newline ? '\n' : '');
          const data = await exitedWithPausedOutput(`process.stdin.resume(); process.stdin.once('end', () => process.stdout.write(${JSON.stringify(payload)}, () => process.exit(0)));`, analysisParentGuard);
          data.child.stdout.resume();
          data.child.stderr.resume();
          await data.closed;
          expect(data.events).toEqual(['exit', 'data', 'close']);
          await expect(data.execution.waitForResult({ completionTimeoutMs: 5000 })).resolves.toMatchObject({
            status: 'completed', exitCode: 0, structuredOutput: { type: 'goal_complete', summary: 'tail delivered' },
            usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
          });
        });

      it.skipIf(analysisParentGuard && (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')))
        .each(['truncated', 'truncated-error'] as const)('rejects an embedded marker in truncated native JSON (guarded: ' + analysisParentGuard + ', %s)', async kind => {
          const payload = JSON.stringify({ type: 'result', ...(kind === 'truncated-error' ? { is_error: true } : {}),
            result: '<goal_complete>{}</goal_complete>' }).slice(0, -1);
          const data = await exitedWithPausedOutput(`process.stdin.resume(); process.stdin.once('end', () => process.stdout.write(${JSON.stringify(payload)}, () => process.exit(0)));`, analysisParentGuard);
          data.child.stdout.resume();
          data.child.stderr.resume();
          await data.closed;
          expect(data.events).toEqual(['exit', 'data', 'close']);
          await expect(data.execution.waitForResult({ completionTimeoutMs: 4000 })).resolves.toMatchObject({
            status: 'failed', error: { code: 'MISSING_RESULT' },
          });
        });

      for (const native of [false, true]) {
        it.skipIf(analysisParentGuard && (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')))
          .each(['', 'Finished local work: '] as const)('preserves a raw completion marker after exit (guarded: ' + analysisParentGuard + ', native: ' + native + ', prefix: %s)', async prefix => {
            const payload = `${prefix}<goal_complete>{}</goal_complete>`;
            const data = await exitedWithPausedOutput(`process.stdin.resume(); process.stdin.once('end', () => process.stdout.write(${JSON.stringify(payload)}, () => process.exit(0)));`, analysisParentGuard, native);
            data.child.stdout.resume();
            data.child.stderr.resume();
            await data.closed;
            expect(data.events).toEqual(['exit', 'data', 'close']);
            await expect(data.execution.waitForResult({ completionTimeoutMs: 4000 })).resolves.toMatchObject({
              status: 'completed', exitCode: 0, structuredOutput: { type: 'goal_complete' },
            });
          });
      }
    }

    it.each([false, true])('does not infer completion from JSON framing outside a result event (native: %s)', async native => {
      for (const payload of [
        JSON.stringify({ type: 'assistant', message: '<goal_complete>{}</goal_complete>' }),
        '  {"type":"result","result":"<goal_complete>{}</goal_complete>"',
        '[{"result":"<goal_complete>{}</goal_complete>"}',
        '"<goal_complete>{}</goal_complete>',
      ]) {
        const data = await exitedWithPausedOutput(`process.stdin.resume(); process.stdin.once('end', () => process.stdout.write(${JSON.stringify(payload)}, () => process.exit(0)));`, false, native);
        data.child.stdout.resume();
        data.child.stderr.resume();
        await data.closed;
        expect(data.events).toEqual(['exit', 'data', 'close']);
        await expect(data.execution.waitForResult({ completionTimeoutMs: 4000 })).resolves.toMatchObject({
          status: 'failed', error: { code: 'MISSING_RESULT' },
        });
      }
    });

    it('waits for the native envelope before accepting its marker and trailing error state', async () => {
      const payload = JSON.stringify({ type: 'result', result: '<goal_complete>{}</goal_complete>', is_error: true });
      const split = payload.indexOf(',"is_error"');
      const provider = new ClaudeCodeProvider();
      const execution = new StreamingAgentExecution({
        command: command(`process.stdin.resume(); process.stdin.once('end', () => {
          process.stdout.write(${JSON.stringify(payload.slice(0, split))});
          setTimeout(() => process.stdout.write(${JSON.stringify(payload.slice(split))}), 1000);
        });`),
        prompt: 'inert local fixture', signalType: 'goal_complete', worktreePath: process.cwd(), metadata: PROCESS_METADATA,
        parseLine: provider.parseLine.bind(provider),
      });
      executions.push(execution);
      execution.start();
      await expect(execution.waitForResult({ completionTimeoutMs: 4000 })).resolves.toMatchObject({
        status: 'failed', error: { code: 'AGENT_ERROR' },
      });
    });

    it('preserves non-zero exit and late stderr over a late valid result', async () => {
      const payload = JSON.stringify({ type: 'result', result: JSON.stringify({ type: 'goal_complete' }) }) + '\n';
      const data = await exitedWithPausedOutput(`process.stdin.resume(); process.stdin.once('end', () => {
        process.stdout.write(${JSON.stringify(payload)}, () => process.stderr.write('late failure diagnostic', () => process.exit(7)));
      });`);
      data.child.stdout.resume();
      data.child.stderr.resume();
      await data.closed;
      await expect(data.execution.waitForResult()).resolves.toMatchObject({ status: 'failed', exitCode: 7,
        error: { code: 'NON_ZERO_EXIT', message: 'late failure diagnostic' } });
    });

    it('preserves a late native error instead of promoting its completion marker', async () => {
      const payload = JSON.stringify({ type: 'result', is_error: true, result: JSON.stringify({ type: 'goal_complete' }) }) + '\n';
      const data = await exitedWithPausedOutput(`process.stdin.resume(); process.stdin.once('end', () => process.stdout.write(${JSON.stringify(payload)}, () => process.exit(0)));`);
      data.child.stdout.resume();
      data.child.stderr.resume();
      await data.closed;
      await expect(data.execution.waitForResult()).resolves.toMatchObject({ status: 'failed', exitCode: 0,
        error: { code: 'AGENT_ERROR' } });
    });

    it('rejects a truncated late result instead of inferring a completion', async () => {
      const payload = JSON.stringify({ type: 'result', result: JSON.stringify({ type: 'goal_complete' }) }).slice(0, -8);
      const data = await exitedWithPausedOutput(`process.stdin.resume(); process.stdin.once('end', () => process.stdout.write(${JSON.stringify(payload)}, () => process.exit(0)));`);
      data.child.stdout.resume();
      data.child.stderr.resume();
      await data.closed;
      await expect(data.execution.waitForResult()).resolves.toMatchObject({ status: 'failed', exitCode: 0,
        error: { code: 'MISSING_RESULT' } });
    });

    it.skipIf(process.platform === 'win32').each(['stdout', 'stderr'] as const)('bounds draining an inherited %s pipe after exit', async pipe => {
      const data = await exitedWithInheritedOutput(pipe);
      const started = Date.now();
      await expect(data.execution.waitForResult({ completionTimeoutMs: 6000 })).resolves.toMatchObject({
        status: 'failed', exitCode: 0, error: { code: 'MISSING_RESULT' },
      });
      expect(Date.now() - started).toBeLessThan(3500);
      expect(data.child.stdout.destroyed).toBe(true);
      expect(data.child.stderr.destroyed).toBe(true);
      await data.closed;
    });

    it.skipIf(process.platform === 'win32').each(['cancel', 'timeout', 'idle', 'kill'] as const)('preserves %s while inherited output is draining', async operation => {
      const data = await exitedWithInheritedOutput('stdout');
      if (operation === 'cancel') await data.execution.interrupt('manual');
      if (operation === 'kill') await data.execution.kill();
      const result = await data.execution.waitForResult({ completionTimeoutMs: operation === 'timeout' ? 0 : 6000,
        ...(operation === 'idle' ? { idleTimeoutMs: 10 } : {}) });
      expect(result.status).toBe(operation === 'cancel' ? 'aborted' : operation === 'kill' ? 'failed' : 'timed_out');
      if (operation === 'idle') expect(result.error?.code).toBe('AGENT_IDLE');
      expect(data.child.stdout.destroyed).toBe(true);
      expect(data.child.stderr.destroyed).toBe(true);
      await data.closed;
    });
  });

  for (const analysisParentGuard of [false, true]) {
    it.skipIf(analysisParentGuard && (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')))(`reports startup failure without crashing on a closed prompt pipe (guarded: ${analysisParentGuard})`, () => {
      const source = new URL('./streaming.ts', import.meta.url).href;
      const script = `
        const { StreamingAgentExecution } = await import(${JSON.stringify(source)});
        const execution = new StreamingAgentExecution({
          command: { argv: [process.execPath, '-e', 'process.exit(2)'], cwd: process.cwd() },
          analysisParentGuard: ${analysisParentGuard}, prompt: 'x'.repeat(256 * 1024), signalType: 'goal_complete',
          worktreePath: process.cwd(), metadata: { provider: 'claude-code', transport: 'process' },
        });
        try {
          execution.start();
          const result = await execution.waitForResult({ completionTimeoutMs: 3000 });
          console.log(JSON.stringify({ status: result.status }));
        } finally { await execution.kill(); }
      `;
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script],
        { cwd: process.cwd(), encoding: 'utf8', timeout: 10000 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({ status: 'failed' });
    });
  }

  it.skipIf(process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))('does not signal a potentially reused analysis process group after its guard exits', async () => {
    const execution = new StreamingAgentExecution({
      command: command("console.log('guard:' + process.ppid)"), analysisParentGuard: true,
      prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(), metadata: PROCESS_METADATA,
    });
    execution.start();
    await execution.waitForResult({ completionTimeoutMs: 5000 });
    const guardPid = Number((await execution.captureOutput()).match(/guard:(\d+)/)?.[1]);
    expect(guardPid).toBeGreaterThan(0);
    const kill = vi.spyOn(process, 'kill');
    try {
      await execution.kill();
      expect(kill).not.toHaveBeenCalledWith(-guardPid, 'SIGKILL');
    } finally { kill.mockRestore(); }
  });

  it.skipIf(process.platform === 'win32').each([false, true])('kills a surviving child after its wrapper exits on interrupt (detached: %s)', async detached => {
    const execution = new StreamingAgentExecution({
      command: command(`const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', "process.on('SIGINT', () => {}); console.log('ready:' + process.pid); setInterval(() => {}, 1000)"], { detached: ${detached}, stdio: ['ignore', 'pipe', 'ignore'] }); child.stdout.pipe(process.stdout); console.log('wrapper:' + process.pid); setInterval(() => {}, 1000)`),
      prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(), metadata: PROCESS_METADATA,
    });
    execution.start();
    let childPid: number | undefined;
    try {
      await vi.waitFor(async () => expect(await execution.captureOutput()).toContain('ready:'), { timeout: 2000 });
      const output = await execution.captureOutput();
      childPid = Number(output.match(/ready:(\d+)/)?.[1]);
      const wrapperPid = Number(output.match(/wrapper:(\d+)/)?.[1]);
      expect(Number.isInteger(childPid)).toBe(true);
      await execution.interrupt('manual');
      await vi.waitFor(() => expect(() => process.kill(wrapperPid, 0)).toThrow(), { timeout: 2000 });
      expect(() => process.kill(childPid!, 0)).not.toThrow();
      await execution.kill();
      await vi.waitFor(() => expect(() => process.kill(childPid!, 0)).toThrow(), { timeout: 2000 });
    } finally {
      if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
      await execution.kill();
    }
  });
  it.skipIf(process.platform === 'win32')('can forcibly terminate an interrupted process that ignores SIGINT', async () => {
    const execution = new StreamingAgentExecution({
      command: command("process.on('SIGINT', () => {}); console.log('ready:' + process.pid); setInterval(() => {}, 1000)"),
      prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(), metadata: PROCESS_METADATA,
    });
    execution.start();
    let processId: number | undefined;
    try {
      await vi.waitFor(async () => expect(await execution.captureOutput()).toContain('ready:'), { timeout: 2000 });
      processId = Number((await execution.captureOutput()).match(/ready:(\d+)/)?.[1]);
      expect(Number.isInteger(processId)).toBe(true);
      await execution.interrupt('manual');
      await execution.kill();
      await vi.waitFor(() => expect(() => process.kill(processId!, 0)).toThrow(), { timeout: 1000 });
    } finally {
      if (processId) { try { process.kill(processId, 'SIGKILL'); } catch {} }
    }
  });
  it('collects Codex tools per line before output truncation and deduplicates replayed items', async () => {
    const started = { type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'private command', status: 'in_progress' } };
    const completed = { type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution', exit_code: 3, status: 'completed', aggregated_output: 'success private output' } };
    const lines = [
      JSON.stringify(started), JSON.stringify(started), JSON.stringify(completed), JSON.stringify(completed),
      '{malformed', 'x'.repeat(6000),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '<goal_complete>{"type":"goal_complete"}</goal_complete>' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'mcp-1', type: 'mcp_tool_call', server: 'docs', tool: 'lookup', status: 'completed', arguments: { token: 'private token' }, result: { content: 'private output' } } }),
    ];
    const execution = new StreamingAgentExecution({
      command: command(`process.stdout.write(${JSON.stringify(lines.join('\n') + '\n')})`),
      prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(),
      metadata: { provider: 'codex', transport: 'exec' },
      parseLine: new CodexProvider().parseLine.bind(new CodexProvider()),
    });
    execution.start();
    const result = await execution.waitForResult({ completionTimeoutMs: 5_000 });
    expect(result.status).toBe('completed');
    expect(result.tools).toEqual([
      { id: 'cmd-1', name: 'command_execution', result: 'failed', exitCode: 3 },
      { id: 'mcp-1', name: 'docs.lookup', result: 'succeeded' },
    ]);
    expect(JSON.stringify(result.tools)).not.toContain('private');
    expect(await execution.captureOutput()).not.toContain('cmd-1');
  });

  it.each(['failed', 'missing_result', 'aborted', 'timed_out'])('returns incomplete tool metadata when %s', async status => {
    const line = JSON.stringify({ type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'private command' } });
    const script = `console.log(${JSON.stringify(line)}); console.log('ready'); ${status === 'failed' ? 'process.exit(3)' : status === 'missing_result' ? '' : 'setInterval(() => {}, 10000)'}`;
    const execution = new StreamingAgentExecution({
      command: command(script), prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(),
      metadata: { provider: 'codex', transport: 'exec' },
    });
    execution.start();
    const deadline = Date.now() + 1000;
    while (!(await execution.captureOutput()).includes('ready') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(await execution.captureOutput()).toContain('ready');
    if (status === 'aborted') await execution.interrupt('manual');
    const result = await execution.waitForResult({ completionTimeoutMs: status === 'timed_out' ? 0 : 5_000 });
    expect(result.status).toBe(status === 'missing_result' ? 'failed' : status);
    expect(result.tools).toEqual([{ id: 'cmd-1', name: 'command_execution', result: 'in_progress' }]);
  });

  it('completes from Codex JSONL and preserves normalized token usage', async () => {
    const usage = JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 12, cached_input_tokens: 2, output_tokens: 5 },
    });
    const result = JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: '<goal_complete>{"type":"goal_complete","kind":"task","summary":"codex fixture complete"}</goal_complete>',
      },
    });
    const execution = new StreamingAgentExecution({
      command: command(`console.log(${JSON.stringify(usage)}); console.log(${JSON.stringify(result)})`),
      prompt: 'go',
      signalType: 'goal_complete',
      worktreePath: process.cwd(),
      metadata: { provider: 'codex', transport: 'exec' },
      parseLine: new CodexProvider().parseLine.bind(new CodexProvider()),
    });
    execution.start();

    await expect(execution.waitForResult({ completionTimeoutMs: 5_000 })).resolves.toMatchObject({
      status: 'completed',
      structuredOutput: { type: 'goal_complete', kind: 'task', summary: 'codex fixture complete' },
      usage: { inputTokens: 14, outputTokens: 5, totalTokens: 19 },
    });
    expect(execution.metadata).toEqual({ provider: 'codex', transport: 'exec' });
  });

  it('captures thread_id from thread.started and surfaces it in metadata', async () => {
    const threadStarted = JSON.stringify({ type: 'thread.started', thread_id: '01a13312-d9c5-7033-8230-20484caff784' });
    const result = JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: '<goal_complete>{"type":"goal_complete","summary":"done"}</goal_complete>',
      },
    });
    const execution = new StreamingAgentExecution({
      command: command(`console.log(${JSON.stringify(threadStarted)}); console.log(${JSON.stringify(result)})`),
      prompt: 'go',
      signalType: 'goal_complete',
      worktreePath: process.cwd(),
      metadata: { provider: 'codex', transport: 'exec' },
      parseLine: new CodexProvider().parseLine.bind(new CodexProvider()),
    });
    execution.start();

    await expect(execution.waitForResult({ completionTimeoutMs: 5_000 })).resolves.toMatchObject({ status: 'completed' });
    expect(execution.metadata.threadId).toBe('01a13312-d9c5-7033-8230-20484caff784');
  });

  it('buffers JSONL records split across stdout chunks', async () => {
    const payload = JSON.stringify({ type: 'result', result: '<goal_complete>{"type":"goal_complete"}</goal_complete>' });
    const execution = new StreamingAgentExecution({ command: command(`process.stdout.write(${JSON.stringify(payload.slice(0, 20))}); setTimeout(() => process.stdout.write(${JSON.stringify(payload.slice(20) + '\n')}), 5)`), prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(), metadata: PROCESS_METADATA });
    execution.start();
    await expect(execution.waitForResult({ completionTimeoutMs: 5_000 })).resolves.toMatchObject({ status: 'completed' });
  });

  it('accepts a completion marker whose payload omits the redundant type field', async () => {
    const payload = JSON.stringify({ type: 'result', result: '<goal_complete>{"summary":"done"}</goal_complete>' });
    const execution = new StreamingAgentExecution({ command: command(`console.log(${JSON.stringify(payload)})`), prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(), metadata: PROCESS_METADATA });
    execution.start();

    await expect(execution.waitForResult({ completionTimeoutMs: 5_000 })).resolves.toMatchObject({
      status: 'completed',
      structuredOutput: { type: 'goal_complete', summary: 'done' },
    });
  });

  it('extracts a completion marker after ordinary result text', async () => {
    const result = [
      'Implemented and verified the requested change.',
      '',
      '<goal_complete>{"type":"goal_complete","kind":"task","summary":"done"}</goal_complete>',
    ].join('\n');
    const payload = JSON.stringify({ type: 'result', result });
    const execution = new StreamingAgentExecution({ command: command(`console.log(${JSON.stringify(payload)})`), prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(), metadata: PROCESS_METADATA });
    execution.start();

    await expect(execution.waitForResult({ completionTimeoutMs: 5_000 })).resolves.toMatchObject({
      status: 'completed',
      structuredOutput: { type: 'goal_complete', kind: 'task', summary: 'done' },
    });
  });

  it('completes when a valid marker arrives before the child exits', async () => {
    const payload = JSON.stringify({ type: 'result', result: '<goal_complete>{"type":"goal_complete"}</goal_complete>' });
    const execution = new StreamingAgentExecution({
      command: command(`console.log(${JSON.stringify(payload)}); setInterval(() => {}, 1_000)`),
      prompt: 'go',
      signalType: 'goal_complete',
      worktreePath: process.cwd(),
      metadata: PROCESS_METADATA,
    });
    execution.start();

    await expect(execution.waitForResult({ completionTimeoutMs: 5_000 })).resolves.toMatchObject({
      status: 'completed',
      structuredOutput: { type: 'goal_complete' },
    });
  });

  it('completes from a marker in an unterminated stdout record', async () => {
    const payload = JSON.stringify({ type: 'result', result: '<goal_complete>{"type":"goal_complete"}</goal_complete>' });
    const execution = new StreamingAgentExecution({
      command: command(`process.stdout.write(${JSON.stringify(payload)}); setInterval(() => {}, 10_000)`),
      prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(),
      metadata: PROCESS_METADATA,
    });
    execution.start();

    await expect(execution.waitForResult({ completionTimeoutMs: 5_000 })).resolves.toMatchObject({
      status: 'completed',
      structuredOutput: { type: 'goal_complete' },
    });
  });

  it('fails when the child exits non-zero even after emitting a result', async () => {
    const payload = JSON.stringify({ type: 'result', result: '<goal_complete>{"type":"goal_complete"}</goal_complete>' });
    const execution = new StreamingAgentExecution({ command: command(`console.log(${JSON.stringify(payload)}); process.exit(3)`), prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(), metadata: PROCESS_METADATA });
    execution.start();
    await expect(execution.waitForResult({ completionTimeoutMs: 5_000 })).resolves.toMatchObject({ status: 'failed', exitCode: 3 });
  });

  it('includes the final stdout tail when a child exits without stderr', async () => {
    const payload = JSON.stringify({ type: 'assistant', message: 'provider failure: invalid request' });
    const execution = new StreamingAgentExecution({
      command: command(`console.log(${JSON.stringify(payload)}); process.exit(1)`),
      prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(),
      metadata: PROCESS_METADATA,
    });
    execution.start();

    await expect(execution.waitForResult({ completionTimeoutMs: 5_000 })).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'NON_ZERO_EXIT', message: expect.stringContaining('provider failure') },
    });
  });

  it('includes the final agent result when it exits successfully without a completion marker', async () => {
    const payload = JSON.stringify({ type: 'result', result: 'implemented the changes but forgot the AFK marker' });
    const execution = new StreamingAgentExecution({ command: command(`console.log(${JSON.stringify(payload)})`), prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(), metadata: PROCESS_METADATA });
    execution.start();

    await expect(execution.waitForResult({ completionTimeoutMs: 5_000 })).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'MISSING_RESULT', message: expect.stringContaining('implemented the changes but forgot the AFK marker') },
    });
  });

  it('captures batch stdout for runtime diagnostics', async () => {
    const payload = JSON.stringify({ type: 'result', result: '<goal_complete>{"type":"goal_complete"}</goal_complete>' });
    const execution = new StreamingAgentExecution({ command: command(`console.log(${JSON.stringify(payload)})`), prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(), metadata: PROCESS_METADATA });
    execution.start();

    await expect(execution.waitForResult({ completionTimeoutMs: 5_000 })).resolves.toMatchObject({ status: 'completed' });
    await expect(execution.captureOutput()).resolves.toContain('goal_complete');
  });

  it('kills the full batch process group, including child agent processes', async () => {
    const execution = new StreamingAgentExecution({
      command: command("const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: 'ignore' }); console.log(child.pid); setInterval(() => {}, 10000);"),
      prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(),
      metadata: PROCESS_METADATA,
    });
    execution.start();
    const childPid = await new Promise<number>((resolve, reject) => {
      const deadline = Date.now() + 1_000;
      const poll = async () => {
        const pid = Number((await execution.captureOutput()).trim());
        if (pid > 0) return resolve(pid);
        if (Date.now() >= deadline) return reject(new Error('child PID was not captured'));
        setTimeout(poll, 10);
      };
      void poll();
    });
    expect(childPid).toBeGreaterThan(0);

    await execution.kill();
    await new Promise(resolve => setTimeout(resolve, 100));
    try {
      process.kill(childPid, 0);
      throw new Error(`child process ${childPid} is still alive`);
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe('ESRCH');
    }
  });

  it('kills descendants that create their own process groups after completion', async () => {
    const payload = JSON.stringify({ type: 'result', result: '<goal_complete>{"type":"goal_complete"}</goal_complete>' });
    const execution = new StreamingAgentExecution({
      command: command(`const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { detached: true, stdio: 'ignore' }); console.log(child.pid); console.log(${JSON.stringify(payload)}); setInterval(() => {}, 10000);`),
      prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(),
      metadata: PROCESS_METADATA,
    });
    execution.start();

    const childPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child PID was not captured')), 1_000);
      const poll = async () => {
        const pid = Number((await execution.captureOutput()).split('\n')[0]);
        if (pid > 0) {
          clearTimeout(timer);
          resolve(pid);
          return;
        }
        setTimeout(poll, 10);
      };
      void poll();
    });

    await expect(execution.waitForResult({ completionTimeoutMs: 5_000 })).resolves.toMatchObject({ status: 'completed' });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(() => process.kill(childPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  });

  describe('telemetryPath getter', () => {
    let tmp: string;
    const origHome = process.env.HOME;

    beforeEach(() => {
      tmp = '/tmp/afk-slug-test-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      mkdirSync(tmp, { recursive: true });
      process.env.HOME = tmp;
    });

    afterEach(() => {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
      process.env.HOME = origHome;
    });

    it('resolves to a real transcript file by deriving the correct slug', async () => {
      // Real Claude Code slug convention: leading '-' then each '/' -> '-'
      // e.g. /Users/shenggangshu/llm/afk -> -Users-shenggangshu-llm-afk
      const worktreePath = join(tmp, 'project', 'repo');
      mkdirSync(worktreePath, { recursive: true });
      const sessionId = 'c0ffee11-2222-3333-4444-555566667777';

      const execution = new StreamingAgentExecution({
        command: command(`console.log('ok')`),
        prompt: 'go',
        signalType: 'goal_complete',
        worktreePath,
        sessionId,
        metadata: PROCESS_METADATA,
      });

      // The temp dir lives under /tmp, which is a symlink to /private/tmp on
      // macOS. Ask the filesystem where it really is rather than assuming.
      const realSlug = realpathSync(worktreePath).replace(/\//g, '-');
      const projectDir = join(tmp, '.claude', 'projects', realSlug);
      mkdirSync(projectDir, { recursive: true });
      const transcriptPath = join(projectDir, `${sessionId}.jsonl`);
      writeFileSync(transcriptPath, '{"type":"cost-state","totalCostUSD":1,"modelUsage":{"m":{"inputTokens":100,"outputTokens":50,"thinkingTokens":0,"cacheReadInputTokens":0,"cacheCreationInputTokens":0}}}\n');

      expect(execution.telemetryPath).toBe(transcriptPath);
      expect(existsSync(execution.telemetryPath!)).toBe(true);
    });

    it('maps a real project path to the slug Claude Code actually uses', () => {
      // Literal expectation, verified against real directories on disk. Claude
      // replaces both path separators and dots with hyphens.
      const sessionId = 'c0ffee11-2222-3333-4444-555566667777';
      const execution = new StreamingAgentExecution({
        command: command(`console.log('ok')`),
        prompt: 'go',
        signalType: 'goal_complete',
        worktreePath: '/Users/shenggangshu/.loop-workspace/github/easyhaloo/afk',
        sessionId,
        metadata: PROCESS_METADATA,
      });

      expect(execution.telemetryPath).toBe(
        `${process.env.HOME}/.claude/projects/-Users-shenggangshu--loop-workspace-github-easyhaloo-afk/${sessionId}.jsonl`,
      );
    });
  });

  describe('context budget', () => {
    it.each([100, 101])('returns context_high at %i tokens without destroying the resumable process', async totalTokens => {
      const usage = JSON.stringify({ type: 'usage', usage: { inputTokens: totalTokens - 20, outputTokens: 20, totalTokens } });
      const completed = JSON.stringify({ type: 'result', result: JSON.stringify({ type: 'goal_complete' }) });
      const execution = new StreamingAgentExecution({
        command: command(`console.log(${JSON.stringify(usage)}); setTimeout(() => console.log(${JSON.stringify(completed)}), 1800); setInterval(() => {}, 10000)`),
        prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(), metadata: PROCESS_METADATA,
      });
      execution.start();
      try {
        const result = await execution.waitForResult({ completionTimeoutMs: 5000, contextHighTokens: 100 });
        expect(result).toMatchObject({ status: 'context_high', usage: { totalTokens } });
        expect(await execution.captureOutput()).not.toContain('goal_complete');
        const child = (execution as unknown as { proc: ChildProcessWithoutNullStreams }).proc;
        expect(child.exitCode).toBeNull();
        expect(() => process.kill(child.pid!, 0)).not.toThrow();
      } finally { await execution.kill(); }
    });

    it.each(['below', 'completed', 'failed', 'cancelled'] as const)('preserves %s instead of rotating the context', async outcome => {
      const usage = JSON.stringify({ type: 'usage', usage: { inputTokens: outcome === 'below' ? 79 : 80, outputTokens: 20, totalTokens: outcome === 'below' ? 99 : 100 } });
      const result = outcome === 'failed'
        ? JSON.stringify({ type: 'error', message: 'fixture failure' })
        : JSON.stringify({ type: 'result', result: JSON.stringify({ type: 'goal_complete' }) });
      const execution = new StreamingAgentExecution({
        command: command(`process.stdout.write(${JSON.stringify(`${usage}\n${result}\n`)}); ${outcome === 'failed' ? 'setTimeout(() => process.exit(3), 1200)' : 'setInterval(() => {}, 10000)'}`),
        prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(), metadata: PROCESS_METADATA,
      });
      execution.start();
      try {
        if (outcome === 'cancelled') await execution.interrupt('manual');
        await expect(execution.waitForResult({ completionTimeoutMs: 5000, contextHighTokens: 100 })).resolves.toMatchObject({
          status: outcome === 'failed' ? 'failed' : outcome === 'cancelled' ? 'aborted' : 'completed',
        });
      } finally { await execution.kill(); }
    });

    it('preserves an exhausted completion budget when the context is also full', async () => {
      const usage = JSON.stringify({ type: 'usage', usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 } });
      const execution = new StreamingAgentExecution({
        command: command(`console.log(${JSON.stringify(usage)}); setInterval(() => {}, 10000)`),
        prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(), metadata: PROCESS_METADATA,
      });
      execution.start();
      try {
        const child = (execution as unknown as { proc: ChildProcessWithoutNullStreams }).proc;
        await once(child.stdout, 'data');
        await expect(execution.waitForResult({ completionTimeoutMs: 0, contextHighTokens: 100 })).resolves.toMatchObject({
          status: 'timed_out', diagnostics: { timeout: { kind: 'completion', budgetMs: 0 } },
        });
      } finally { await execution.kill(); }
    });

    it.each([new ClaudeCodeProvider(), new CodexProvider()])('uses normalized native usage from $name', async provider => {
      const usage = JSON.stringify(provider.name === 'claude-code'
        ? { type: 'usage', usage: { input_tokens: 60, cache_creation_input_tokens: 10, cache_read_input_tokens: 10, output_tokens: 20 } }
        : { type: 'turn.completed', usage: { input_tokens: 70, cached_input_tokens: 10, output_tokens: 20 } });
      const execution = new StreamingAgentExecution({
        command: command(`console.log(${JSON.stringify(usage)}); setInterval(() => {}, 10000)`),
        prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(),
        metadata: { provider: provider.name, transport: 'process' }, parseLine: provider.parseLine!.bind(provider),
      });
      execution.start();
      try {
        await expect(execution.waitForResult({ completionTimeoutMs: 1500, contextHighTokens: 100 })).resolves.toMatchObject({
          status: 'context_high', usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
        });
      } finally { await execution.kill(); }
    });
  });

  describe('idle watchdog', () => {
    it.each(['stdout', 'stderr'] as const)('counts repeated %s chunks as activity after the output tail is full', async stream => {
      const completed = JSON.stringify({ type: 'result', result: JSON.stringify({ type: 'goal_complete' }) });
      const execution = new StreamingAgentExecution({
        command: command(`const ticker = setInterval(() => process.${stream}.write('x'.repeat(5000) + '\\n'), 30); setTimeout(() => { clearInterval(ticker); console.log(${JSON.stringify(completed)}); }, 1800)`),
        prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(), metadata: PROCESS_METADATA,
      });
      execution.start();
      try {
        await expect(execution.waitForResult({ completionTimeoutMs: 5000, idleTimeoutMs: 600 })).resolves.toMatchObject({ status: 'completed' });
      } finally { await execution.kill(); }
    });

    it('gives up on a batch agent that stops producing output', async () => {
      const execution = new StreamingAgentExecution({
        command: command('setInterval(() => {}, 10000)'),
        prompt: 'go',
        signalType: 'goal_complete',
        worktreePath: process.cwd(),
        metadata: PROCESS_METADATA,
      });
      execution.start();

      const result = await execution.waitForResult({ completionTimeoutMs: 600_000, idleTimeoutMs: 20 });

      expect(result.status).toBe('timed_out');
      expect(result.error).toMatchObject({ code: 'AGENT_IDLE' });
    });

    it('keeps waiting while the batch agent keeps producing output', async () => {
      const execution = new StreamingAgentExecution({
        command: command("setInterval(() => process.stdout.write('.'), 10); setTimeout(() => process.exit(0), 400)"),
        prompt: 'go',
        signalType: 'goal_complete',
        worktreePath: process.cwd(),
        metadata: PROCESS_METADATA,
      });
      execution.start();

      const result = await execution.waitForResult({ completionTimeoutMs: 600_000, idleTimeoutMs: 400 });

      expect(result.status).not.toBe('timed_out');
      expect(result.error?.code).not.toBe('AGENT_IDLE');
    });
  });
});
