import { describe, expect, it, vi } from 'vitest';
import { createJumpserverCli, execute } from './jms-cli.js';

describe('shared JumpServer adapter', () => {
  it('passes probe commands as argv values', async () => {
    const exec = vi.fn(async () => ({ ok: true, stdout: 'true', stderr: '' }));
    await createJumpserverCli({ exec }).probeAssetReachability({ asset: 'web-01', serverAlias: 'dev', command: 'true' });
    expect(exec).toHaveBeenCalledWith('jms', ['exec', 'web-01@dev', 'true']);
  });

  describe('execAssetCommand', () => {
    it('forwards the whole command vector as structured argv without shell joining', async () => {
      const exec = vi.fn(async () => ({ ok: true, stdout: '', stderr: '', code: 0 }));
      const cli = createJumpserverCli({ exec });
      await cli.execAssetCommand({ target: 'web-01@dev', argv: ['sh', '-c', 'echo "a b"; ls | wc -l'], timeoutMs: 900 });
      expect(exec).toHaveBeenCalledTimes(1);
      const [command, args, cwd, input, options] = exec.mock.calls[0];
      expect(command).toBe('jms');
      expect(cwd).toBeUndefined();
      expect(input).toBeUndefined();
      expect(options).toEqual({ timeoutMs: 900, preserveOutput: true });
      // Each user token stays a distinct argv element — no quoting/escaping applied.
      expect(args).toEqual(['exec', 'web-01@dev', 'sh', '-c', 'echo "a b"; ls | wc -l']);
    });

    it('rejects an empty command vector without spawning a process', async () => {
      const exec = vi.fn();
      const cli = createJumpserverCli({ exec });
      const result = await cli.execAssetCommand({ target: 'web-01@dev', argv: [] });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain('at least one argument');
      expect(exec).not.toHaveBeenCalled();
    });
  });

  describe('uploadFile', () => {
    it('builds a structured file-transfer argv', async () => {
      const exec = vi.fn(async () => ({ ok: true, stdout: '', stderr: '', code: 0 }));
      const cli = createJumpserverCli({ exec });
      await cli.uploadFile({ target: 'web-01@dev', source: '/tmp/a.bin', destination: '/root/b.bin' });
      expect(exec).toHaveBeenCalledWith('jms', ['file', 'upload', 'web-01@dev', '/tmp/a.bin', '/root/b.bin'], undefined, undefined, undefined);
    });
  });

  describe('process boundaries', () => {
    it('preserves command output whitespace and a non-zero exit when requested', async () => {
      const result = await execute(process.execPath, ['-e', 'process.stdout.write(" out\\n"); process.stderr.write(" err\\n"); process.exitCode = 7'], undefined, undefined, { preserveOutput: true });
      expect(result).toEqual({ ok: false, code: 7, stdout: ' out\n', stderr: ' err\n' });
    });

    it('treats a zero exit as ok', async () => {
      const result = await execute('sh', ['-c', 'exit 0']);
      expect(result).toMatchObject({ ok: true, code: 0 });
    });

    it('reports a non-zero exit as not ok and keeps the exit code', async () => {
      const result = await execute('sh', ['-c', 'exit 3']);
      expect(result.ok).toBe(false);
      expect(result.code).toBe(3);
    });

    it('marks a timed-out command as not ok with a timeout diagnostic', async () => {
      const result = await execute('sleep', ['2'], undefined, undefined, { timeoutMs: 50 });
      expect(result.ok).toBe(false);
      expect(result.code).toBeNull();
      expect(result.stderr).toMatch(/timed out after 50ms/);
    }, 5000);

    it('marks a missing binary as not ok with a spawn diagnostic and no exit code', async () => {
      const result = await execute('definitely-not-a-real-binary-xyz', []);
      expect(result.ok).toBe(false);
      expect(result.code).toBeNull();
      expect(result.stderr.toLowerCase()).toMatch(/enoent|spawn/);
    });
  });
});
