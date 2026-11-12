import { describe, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerContainerProvider } from './docker.js';
import { PodmanContainerProvider } from './podman.js';

const operationId = '12345678-1234-4321-8123-123456789abc';
const baseImageId = `sha256:${'a'.repeat(64)}`;
const imageId = `sha256:${'b'.repeat(64)}`;
const containerId = 'c'.repeat(64);
const bounds = { timeoutMs: 1000, maxOutputBytes: 64 * 1024 };

class ScriptedDocker extends DockerContainerProvider {
  readonly calls: { argv: string[]; stdin?: string | Buffer; legacyBuild?: boolean }[] = [];
  response: (argv: string[]) => { stdout: string; stderr: string; code: number } | Promise<{ stdout: string; stderr: string; code: number }> = () => ({ stdout: '', stderr: '', code: 0 });
  protected override async run(argv: string[], options: { stdin?: string | Buffer; legacyBuild?: boolean } = {}) {
    this.calls.push({ argv, ...options });
    return this.response(argv);
  }
}

class HostProbe extends DockerContainerProvider {
  execute(argv: string[], options: { signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number }) {
    return this.run(argv, options);
  }
}

describe('frozen Docker CLI adapter', () => {
  it.each(['timeout', 'output', 'abort-null', 'abort-undefined', 'exited-parent'] as const)('finishes owned stdio and child teardown after %s while a helper retains inherited pipes', async mode => {
    const provider = new HostProbe();
    const root = mkdtempSync(join(tmpdir(), 'container-cli-helper-'));
    const helperMarker = join(root, 'helper.pid');
    const parentMarker = join(root, 'parent.pid');
    const helperCode = `require('node:fs').writeFileSync(${JSON.stringify(helperMarker)},String(process.pid));setTimeout(()=>process.exit(0),4000)`;
    const parentEnd = mode === 'exited-parent' ? 'setTimeout(()=>process.exit(0),250)' : 'setInterval(()=>{},1000)';
    const output = mode === 'output' ? 'setTimeout(()=>process.stderr.write("x".repeat(4096)),250);' : '';
    const code = `require('node:fs').writeFileSync(${JSON.stringify(parentMarker)},String(process.pid));require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(helperCode)}],{stdio:['ignore',1,2]});${output}${parentEnd}`;
    const controller = new AbortController();
    const reason = mode === 'abort-null' ? null : undefined;
    if (mode.startsWith('abort')) Object.defineProperty(controller.signal, 'reason', { value: reason });
    let settled = false;
    let failure: unknown;
    const running = provider.execute([process.execPath, '-e', code], {
      signal: controller.signal, timeoutMs: mode === 'timeout' || mode === 'exited-parent' ? 500 : 3000, maxOutputBytes: 1024,
    }).then(() => { settled = true; }, error => { failure = error; settled = true; });
    try {
      await vi.waitFor(() => expect(Number(readFileSync(helperMarker, 'utf8'))).toBeGreaterThan(0), { timeout: 1000, interval: 10 });
      if (mode.startsWith('abort')) controller.abort(reason);
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1000, interval: 10 });
      if (mode.startsWith('abort')) expect(failure).toBe(reason);
      else expect((failure as Error).message).toMatch(mode === 'output' ? /output/i : /deadline/i);
      const parentId = Number(readFileSync(parentMarker, 'utf8'));
      expect(() => process.kill(parentId, 0)).toThrow();
      expect(() => process.kill(Number(readFileSync(helperMarker, 'utf8')), 0)).not.toThrow();
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally {
      for (const marker of [parentMarker, helperMarker]) {
        try { process.kill(Number(readFileSync(marker, 'utf8')), 'SIGKILL'); } catch {}
      }
      await running;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['preflight', 'running'] as const)('preserves null cancellation in the host CLI at %s', async phase => {
    const provider = new HostProbe();
    const controller = new AbortController();
    if (phase === 'preflight') controller.abort(null);
    const running = provider.execute([process.execPath, '-e', 'setInterval(()=>{},1000)'], { signal: controller.signal, timeoutMs: 5000 });
    if (phase === 'running') controller.abort(null);
    await expect(running).rejects.toBe(null);
  });

  it.each(['build', 'create'] as const)('does not confirm empty inventory after an uncertain %s allocation', async phase => {
    const provider = new ScriptedDocker();
    const failure = new Error('allocation CLI deadline exceeded');
    provider.response = argv => {
      if (argv.includes(phase)) throw failure;
      return { code: 0, stderr: '', stdout: argv.includes('inspect') ? JSON.stringify([{ Id: baseImageId, Config: {} }]) : '' };
    };
    const allocation = phase === 'build' ? provider.buildFrozenImage(operationId, baseImageId, Buffer.alloc(0), bounds)
      : provider.createFrozenContainer(operationId, imageId, ['node', 'asset.js'], bounds);
    await expect(allocation).rejects.toBe(failure);
    await expect(provider.cleanupFrozenOperation(operationId, bounds)).rejects.toThrow(/allocation.*unconfirmed/i);
    expect(provider.calls.filter(call => call.argv.includes('ls'))).toHaveLength(4);
    await expect(provider.cleanupFrozenOperation(operationId, bounds)).rejects.toThrow(/allocation.*unconfirmed/i);
    expect(provider.calls.filter(call => call.argv.includes('ls'))).toHaveLength(8);
    await expect(provider.createFrozenContainer(operationId, imageId, ['node', 'asset.js'], bounds)).rejects.toThrow(/allocation.*unconfirmed/i);
  });
  it('requires a local exact base with no build hooks or volumes and supplies only captured stdin', async () => {
    const provider = new ScriptedDocker();
    provider.response = argv => ({ code: 0, stderr: '', stdout: argv.includes('build') ? `${imageId}\n`
      : JSON.stringify([{ Id: baseImageId, Config: { OnBuild: null, Volumes: null } }]) });
    const context = Buffer.from('captured-context');
    expect(await provider.buildFrozenImage(operationId, baseImageId, context, bounds)).toBe(imageId);
    expect(provider.calls[1].argv).toEqual(['docker', 'build', '--pull=false', '--network=none', '--force-rm', '--rm', '--quiet',
      '--label', `afk.frozen.operation=${operationId}`, '--label', 'afk.frozen.managed=true', '-']);
    expect(provider.calls[1].stdin).toBe(context);
    expect(provider.calls[1].legacyBuild).toBe(true);
    await expect(provider.buildFrozenImage(operationId, 'node:latest', context, bounds)).rejects.toThrow(/exact/i);
  });

  it.each([{ OnBuild: ['RUN unsafe'] }, { Volumes: { '/workspace': {} } }])('rejects a base image with unsupported config %j before building', async config => {
    const provider = new ScriptedDocker();
    provider.response = () => ({ code: 0, stderr: '', stdout: JSON.stringify([{ Id: baseImageId, Config: config }]) });
    await expect(provider.buildFrozenImage(operationId, baseImageId, Buffer.alloc(0), bounds)).rejects.toThrow(/hooks|volumes/i);
    expect(provider.calls).toHaveLength(1);
  });

  it('creates an owned isolated container without host mounts, a shell, inherited secrets or implicit pulls', async () => {
    const provider = new ScriptedDocker();
    provider.response = () => ({ code: 0, stderr: '', stdout: `${containerId}\n` });
    await provider.createFrozenContainer(operationId, imageId, ['node', 'asset.js', 'literal;$(never)'], bounds);
    const argv = provider.calls[0].argv;
    expect(argv).toContain('--pull=never');
    expect(argv).toContain('--read-only');
    expect(argv).toContain('no-new-privileges');
    expect(argv).toContain('none');
    expect(argv).not.toContain('-v');
    expect(argv).not.toContain('--mount');
    expect(argv).not.toContain('sh');
    expect(argv.slice(-8)).toEqual([imageId, '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/scratch', 'TMPDIR=/scratch', 'node', 'asset.js', 'literal;$(never)']);
  });

  it('refuses cleanup when inventory ownership cannot be confirmed', async () => {
    const provider = new ScriptedDocker();
    provider.response = argv => ({ code: 0, stderr: '', stdout: argv.includes('ls') ? `${containerId}\n` : '{}' });
    await expect(provider.cleanupFrozenOperation(operationId, bounds)).rejects.toThrow(/unowned/i);
    expect(provider.calls.some(call => call.argv.includes('rm'))).toBe(false);
  });

  it('does not advertise unverified Podman frozen support', () => {
    expect(new PodmanContainerProvider().frozen).toBeUndefined();
  });

  it('bounds host CLI output and time, preserving the exact cancellation reason', async () => {
    const provider = new HostProbe();
    await expect(provider.execute([process.execPath, '-e', 'process.stdout.write("a".repeat(1024))'], { maxOutputBytes: 64 })).rejects.toThrow(/output/i);
    await expect(provider.execute([process.execPath, '-e', 'setInterval(()=>{},1000)'], { timeoutMs: 30 })).rejects.toThrow(/deadline/i);
    const controller = new AbortController();
    const reason = new Error('stop owned CLI');
    const execution = provider.execute([process.execPath, '-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
    controller.abort(reason);
    await expect(execution).rejects.toBe(reason);
  });
});
