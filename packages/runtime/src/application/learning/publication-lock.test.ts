import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { acquirePublicationLock, withKnowledgePublicationLock, PUBLICATION_LOCK_FILE, type PublicationLock } from './publication-lock.js';

const supported = process.platform === 'darwin' || process.platform === 'linux';
const roots: string[] = [];
const leases: PublicationLock[] = [];
const processes: Array<{ child: ChildProcess; closed: Promise<unknown> }> = [];
const orphans = new Set<number>();
let harness: string;

function fixture(): { root: string; vault: string; path: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'afk-publication-lock-')));
  roots.push(root);
  const vault = join(root, 'vault');
  mkdirSync(vault, { mode: 0o700 });
  return { root, vault, path: join(vault, PUBLICATION_LOCK_FILE) };
}

async function acquire(vault: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<PublicationLock> {
  const lease = await acquirePublicationLock({ vault, ...options });
  leases.push(lease);
  return lease;
}

function node(vault: string, mode = 'hold', timeoutMs = 2000) {
  const child = spawn(process.execPath, [harness, vault, mode, String(timeoutMs)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const events: Array<{ event: string; code?: string; writer?: number }> = [];
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += chunk; });
  child.on('message', event => { events.push(event as typeof events[number]); });
  const closed = new Promise<void>(resolveClosed => { child.once('close', () => resolveClosed()); });
  processes.push({ child, closed });
  return {
    child, closed,
    async event(name: string) {
      const existing = events.find(event => event.event === name);
      if (existing) return existing;
      return new Promise<typeof events[number]>((resolveEvent, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error(`Missing ${name}: ${stderr}`)); }, 5000);
        const message = (event: unknown) => {
          if ((event as typeof events[number]).event === name) { cleanup(); resolveEvent(event as typeof events[number]); }
        };
        const cleanup = () => { clearTimeout(timer); child.off('message', message); };
        child.on('message', message);
      });
    },
  };
}

async function attempt(vault: string, timeoutMs = 150): Promise<string> {
  const contender = node(vault, 'try', timeoutMs);
  const result = await contender.event('result');
  await contender.closed;
  return result.code!;
}

function descriptors(path: string): number {
  const expected = lstatSync(path);
  let count = 0;
  for (let descriptor = 0; descriptor < 512; descriptor++) {
    try {
      const actual = fstatSync(descriptor);
      if (actual.dev === expected.dev && actual.ino === expected.ino) count++;
    } catch {}
  }
  return count;
}

beforeAll(async () => {
  if (!supported) return;
  const { root } = fixture();
  harness = join(root, 'owner.mjs');
  await build({ stdin: { contents: `
    import { spawn } from 'node:child_process';
    import { acquirePublicationLock } from ${JSON.stringify(fileURLToPath(new URL('./publication-lock.ts', import.meta.url)))};
    const [vault, mode, timeout] = process.argv.slice(2);
    const send = value => process.send?.(value);
    try {
      const lease = await acquirePublicationLock({ vault, timeoutMs: Number(timeout) });
      if (mode === 'try') { lease.close(); send({ event: 'result', code: 'acquired' }); process.disconnect(); }
      else {
        let writer;
        if (mode === 'writer') {
          writer = spawn('python3', ['-I', '-B', '-u', '-c',
            'import fcntl,os,sys,time; fcntl.flock(3,fcntl.LOCK_EX|fcntl.LOCK_NB); print("ready",flush=True); deadline=time.monotonic()+20\\nwhile not os.path.exists(sys.argv[1]) and time.monotonic()<deadline: time.sleep(.01)',
            vault + '/permit'], { stdio: ['ignore', 'pipe', 'pipe', lease.fd] });
          writer.stderr.resume();
          await new Promise((resolve, reject) => { writer.stdout.once('data', resolve); writer.once('error', reject); writer.once('exit', () => reject(new Error('writer exited before ready'))); });
          writer.on('close', () => send({ event: 'writer-exited' }));
        }
        process.on('message', message => {
          if (message === 'kill-writer') writer.kill('SIGKILL');
          if (message === 'close') { lease.close(); send({ event: 'closed' }); }
          if (message === 'exit') { lease.close(); process.disconnect(); }
        });
        send({ event: 'ready', writer: writer?.pid });
      }
    } catch (error) { send({ event: 'result', code: error.code ?? error.message }); process.disconnect(); }
  `, resolveDir: process.cwd() }, outfile: harness, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const lease of leases.splice(0)) lease.close();
  for (const pid of orphans) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  orphans.clear();
  await Promise.all(processes.splice(0).map(async ({ child, closed }) => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }));
});

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!supported)('vault publication kernel lock', () => {
  it('runs the callback with a held FD and returns its result after closing', async () => {
    const { vault, path } = fixture();
    const result = await withKnowledgePublicationLock(vault, async descriptor => {
      expect(fstatSync(descriptor).ino).toBe(lstatSync(path).ino);
      expect(await attempt(vault)).toBe('publication_lock_timeout');
      return { completed: true };
    });
    expect(result).toEqual({ completed: true });
    expect(descriptors(path)).toBe(0);
    await acquire(vault);
  });

  it.each(['sync', 'async'])('closes the callback FD after a %s failure', async kind => {
    const { vault, path } = fixture();
    const failure = new Error('operation failed');
    await expect(withKnowledgePublicationLock(vault, () => {
      if (kind === 'sync') throw failure;
      return Promise.reject(failure);
    })).rejects.toBe(failure);
    expect(descriptors(path)).toBe(0);
    await acquire(vault);
  });

  it('accepts a synchronous callback result', async () => {
    const { vault, path } = fixture();
    await expect(withKnowledgePublicationLock(vault, descriptor => fstatSync(descriptor).ino)).resolves.toBe(lstatSync(path).ino);
    expect(descriptors(path)).toBe(0);
  });

  it('does not invoke the callback when a waiting operation is cancelled or times out', async () => {
    const { vault } = fixture();
    await acquire(vault);
    const operation = vi.fn(async () => 'unexpected');
    await expect(withKnowledgePublicationLock(vault, operation, { timeoutMs: 50 })).rejects.toMatchObject({ code: 'publication_lock_timeout' });
    const controller = new AbortController();
    const pending = withKnowledgePublicationLock(vault, operation, { signal: controller.signal });
    controller.abort(new Error('stop callback acquisition'));
    await expect(pending).rejects.toBe(controller.signal.reason);
    expect(operation).not.toHaveBeenCalled();
  });

  it('retains callback ownership until the running operation finishes cancellation', async () => {
    const { vault, path } = fixture();
    const controller = new AbortController();
    let entered!: () => void;
    let finish!: () => void;
    const started = new Promise<void>(resolveStarted => { entered = resolveStarted; });
    const stopped = new Promise<void>(resolveStopped => { finish = resolveStopped; });
    const pending = withKnowledgePublicationLock(vault, async () => {
      entered();
      await stopped;
      controller.signal.throwIfAborted();
    }, { signal: controller.signal });
    await started;
    controller.abort(new Error('cancel running callback'));
    try { expect(await attempt(vault)).toBe('publication_lock_timeout'); }
    finally { finish(); }
    await expect(pending).rejects.toBe(controller.signal.reason);
    expect(descriptors(path)).toBe(0);
    await acquire(vault);
  });

  it('holds a private fixed inode after the Python acquiring helper exits and closes idempotently', async () => {
    const { vault, path } = fixture();
    const first = await acquire(vault);
    expect(PUBLICATION_LOCK_FILE).toBe('.learning-publication.lock');
    expect(() => lstatSync(join(vault, '.afk-publication.lock'))).toThrow();
    const original = lstatSync(path);
    expect(original.isFile()).toBe(true);
    expect(original.mode & 0o7777).toBe(0o600);
    expect(original.nlink).toBe(1);
    expect(original.uid).toBe(process.getuid!());
    expect(fstatSync(first.fd).ino).toBe(original.ino);
    expect(await attempt(vault)).toBe('publication_lock_timeout');
    first.close();
    first.close();
    expect(() => first.fd).toThrow(/closed/i);
    const second = await acquire(vault);
    expect(lstatSync(path).ino).toBe(original.ino);
    expect(lstatSync(path).dev).toBe(original.dev);
    second.close();
    expect(readFileSync(path)).toHaveLength(0);
  });

  it('serializes two real Node processes and permits a different vault', async () => {
    const { vault } = fixture();
    const independent = fixture();
    const owner = node(vault);
    await owner.event('ready');
    expect(await attempt(vault)).toBe('publication_lock_timeout');
    expect(await attempt(independent.vault, 2000)).toBe('acquired');
    owner.child.send('exit');
    await owner.closed;
    expect(await attempt(vault, 2000)).toBe('acquired');
  });

  it('excludes an independent Python open and retains the same inode across Node owners', async () => {
    const { vault, path } = fixture();
    const owner = await acquire(vault);
    const inode = lstatSync(path).ino;
    const inspect = () => spawnSync('python3', ['-I', '-B', '-c', `
import fcntl, sys
with open(sys.argv[1], 'r+') as stream:
    try:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print('acquired')
    except BlockingIOError:
        print('blocked')
`, path], { encoding: 'utf8', timeout: 2000 });
    const blocked = inspect();
    expect(blocked.status).toBe(0);
    expect(blocked.stdout.trim()).toBe('blocked');
    owner.close();
    const released = inspect();
    expect(released.status).toBe(0);
    expect(released.stdout.trim()).toBe('acquired');
    for (let iteration = 0; iteration < 3; iteration++) {
      expect(await attempt(vault, 2000)).toBe('acquired');
      expect(lstatSync(path).ino).toBe(inode);
    }
  });

  it('keeps the lock with an orphan Python after the owning Node is SIGKILLed', async () => {
    const { vault } = fixture();
    const owner = node(vault, 'writer');
    const ready = await owner.event('ready');
    orphans.add(ready.writer!);
    owner.child.kill('SIGKILL');
    await owner.closed;
    expect(owner.child.signalCode).toBe('SIGKILL');
    expect(() => process.kill(ready.writer!, 0)).not.toThrow();
    expect(await attempt(vault)).toBe('publication_lock_timeout');
    writeFileSync(join(vault, 'permit'), 'finish');
    expect(await attempt(vault, 3000)).toBe('acquired');
    orphans.delete(ready.writer!);
  });

  it('keeps the lock with Node after its Python writer is SIGKILLed', async () => {
    const { vault } = fixture();
    const owner = node(vault, 'writer');
    const ready = await owner.event('ready');
    orphans.add(ready.writer!);
    owner.child.send('kill-writer');
    await owner.event('writer-exited');
    orphans.delete(ready.writer!);
    expect(await attempt(vault)).toBe('publication_lock_timeout');
    owner.child.send('close');
    await owner.event('closed');
    expect(await attempt(vault, 2000)).toBe('acquired');
    owner.child.send('exit');
    await owner.closed;
  });

  it('closes only the Node reference and leaves an inherited Python reference locked', async () => {
    const { vault } = fixture();
    const owner = node(vault, 'writer');
    const ready = await owner.event('ready');
    orphans.add(ready.writer!);
    owner.child.send('close');
    await owner.event('closed');
    expect(await attempt(vault)).toBe('publication_lock_timeout');
    writeFileSync(join(vault, 'permit'), 'finish');
    await owner.event('writer-exited');
    orphans.delete(ready.writer!);
    expect(await attempt(vault, 2000)).toBe('acquired');
    owner.child.send('exit');
    await owner.closed;
  });

  it('recovers automatically after both owner and orphan writer are SIGKILLed', async () => {
    const { vault, path } = fixture();
    const owner = node(vault, 'writer');
    const ready = await owner.event('ready');
    const inode = lstatSync(path).ino;
    orphans.add(ready.writer!);
    owner.child.kill('SIGKILL');
    await owner.closed;
    process.kill(ready.writer!, 'SIGKILL');
    expect(await attempt(vault, 3000)).toBe('acquired');
    expect(lstatSync(path).ino).toBe(inode);
    orphans.delete(ready.writer!);
  });

  it('bounds acquisition by the total deadline without stealing the held lock', async () => {
    const { vault } = fixture();
    const owner = await acquire(vault);
    const start = performance.now();
    await expect(acquire(vault, { timeoutMs: 120 })).rejects.toMatchObject({ code: 'publication_lock_timeout' });
    expect(performance.now() - start).toBeGreaterThanOrEqual(100);
    expect(performance.now() - start).toBeLessThan(1500);
    expect(fstatSync(owner.fd).isFile()).toBe(true);
  });

  it('cancels a real waiting helper and retains the previous owner', async () => {
    const { vault } = fixture();
    const owner = await acquire(vault);
    const controller = new AbortController();
    const reason = new Error('stop waiting');
    const pending = acquire(vault, { timeoutMs: 4000, signal: controller.signal });
    const timer = setTimeout(() => controller.abort(reason), 50);
    try { await expect(pending).rejects.toBe(reason); }
    finally { clearTimeout(timer); }
    expect(await attempt(vault)).toBe('publication_lock_timeout');
    owner.close();
    await acquire(vault);
  });

  it('keeps a later same-process waiter blocked when an earlier waiter is cancelled', async () => {
    const { vault } = fixture();
    const first = await acquire(vault);
    const controller = new AbortController();
    const cancelled = acquire(vault, { signal: controller.signal });
    let laterAcquired = false;
    const later = acquire(vault).then(lease => { laterAcquired = true; return lease; });
    controller.abort(new Error('cancel middle waiter'));
    await expect(cancelled).rejects.toBe(controller.signal.reason);
    expect(laterAcquired).toBe(false);
    expect(fstatSync(first.fd).isFile()).toBe(true);
    first.close();
    const final = await later;
    expect(laterAcquired).toBe(true);
    final.close();
  });

  it('does not create the lock for an already cancelled request', async () => {
    const { vault, path } = fixture();
    const controller = new AbortController();
    controller.abort(new Error('already stopped'));
    await expect(acquire(vault, { signal: controller.signal })).rejects.toBe(controller.signal.reason);
    expect(() => lstatSync(path)).toThrow();
  });

  it('does not return a lease when cancellation races an uncontended acquisition', async () => {
    const { vault, path } = fixture();
    const controller = new AbortController();
    const pending = acquire(vault, { signal: controller.signal });
    controller.abort(new Error('cancel acquisition'));
    await expect(pending).rejects.toBe(controller.signal.reason);
    expect(descriptors(path)).toBe(0);
    await acquire(vault);
  });

  it('does not leak descriptors across cancellation, timeout and repeated release', async () => {
    const { vault, path } = fixture();
    const owner = await acquire(vault);
    expect(owner.fd).toBeLessThan(512);
    expect(descriptors(path)).toBe(1);
    for (let iteration = 0; iteration < 4; iteration++) {
      await expect(acquire(vault, { timeoutMs: 40 })).rejects.toMatchObject({ code: 'publication_lock_timeout' });
      const controller = new AbortController();
      const pending = acquire(vault, { signal: controller.signal });
      controller.abort();
      await expect(pending).rejects.toBe(controller.signal.reason);
      expect(descriptors(path)).toBe(1);
    }
    owner.close();
    expect(descriptors(path)).toBe(0);
    for (let iteration = 0; iteration < 4; iteration++) (await acquire(vault)).close();
    expect(descriptors(path)).toBe(0);
  });

  it('closes the descriptor if Python cannot start', async () => {
    const { root, vault, path } = fixture();
    vi.stubEnv('PATH', root);
    await expect(acquire(vault)).rejects.toMatchObject({ code: 'publication_lock_failed' });
    expect(descriptors(path)).toBe(0);
    vi.unstubAllEnvs();
    await acquire(vault);
  });

  it('enforces the Node deadline even if the Python helper never answers', async () => {
    const { root, vault, path } = fixture();
    const python = join(root, 'python3');
    writeFileSync(python, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
    vi.stubEnv('PATH', root);
    await expect(acquire(vault, { timeoutMs: 150 })).rejects.toMatchObject({ code: 'publication_lock_timeout' });
    expect(descriptors(path)).toBe(0);
    vi.unstubAllEnvs();
    await acquire(vault);
  });

  it.each(['wrong response', 'x'.repeat(65)])('rejects invalid helper output without leaking an FD: %s', async response => {
    const { root, vault, path } = fixture();
    writeFileSync(join(root, 'python3'), `#!${process.execPath}\nconsole.log(${JSON.stringify(response)});\n`, { mode: 0o700 });
    vi.stubEnv('PATH', root);
    await expect(acquire(vault)).rejects.toMatchObject({ code: 'publication_lock_failed' });
    expect(descriptors(path)).toBe(0);
    vi.unstubAllEnvs();
    await acquire(vault);
  });

  it.each([0, -1, NaN, Infinity, 120001, 1.5])('rejects an invalid deadline %s before creating a file', async timeoutMs => {
    const { vault, path } = fixture();
    await expect(acquire(vault, { timeoutMs })).rejects.toMatchObject({ code: 'publication_lock_invalid' });
    expect(() => lstatSync(path)).toThrow();
  });

  it.each(['relative', 'missing', 'file', 'alias', 'public', 'other-owner'])('rejects an unsafe vault: %s', async kind => {
    const { root, vault, path } = fixture();
    let target = vault;
    if (kind === 'relative') target = 'vault';
    if (kind === 'missing') target = join(root, 'missing');
    if (kind === 'file') { target = join(root, 'file'); writeFileSync(target, 'file'); }
    if (kind === 'alias') { target = join(root, 'alias'); symlinkSync(vault, target); }
    if (kind === 'public') chmodSync(vault, 0o777);
    if (kind === 'other-owner') vi.spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1);
    await expect(acquire(target)).rejects.toMatchObject({ code: 'publication_lock_invalid' });
    expect(() => lstatSync(path)).toThrow();
  });

  it('rejects a symbolic ancestor and a writable non-sticky ancestor', async () => {
    const { root, vault } = fixture();
    const alias = join(root, 'alias');
    symlinkSync(root, alias);
    await expect(acquire(join(alias, 'vault'))).rejects.toMatchObject({ code: 'publication_lock_invalid' });
    chmodSync(root, 0o777);
    await expect(acquire(vault)).rejects.toMatchObject({ code: 'publication_lock_invalid' });
  });

  it.each(['/', '/.', '/nested/..', '\n', '\0'])('rejects a noncanonical or invalid vault suffix %j', async suffix => {
    const { vault, path } = fixture();
    await expect(acquire(vault + suffix)).rejects.toMatchObject({ code: 'publication_lock_invalid' });
    expect(() => lstatSync(path)).toThrow();
  });

  it.each(['symlink', 'hardlink', 'directory', 'public', 'readonly', 'executable', 'content'])('rejects an unsafe existing lock: %s', async kind => {
    const { root, vault, path } = fixture();
    const outside = join(root, 'outside');
    writeFileSync(outside, '', { mode: 0o600 });
    if (kind === 'symlink') symlinkSync(outside, path);
    else if (kind === 'hardlink') linkSync(outside, path);
    else if (kind === 'directory') mkdirSync(path, { mode: 0o700 });
    else writeFileSync(path, kind === 'content' ? 'preserve me' : '', { mode: 0o600 });
    if (kind === 'public') chmodSync(path, 0o644);
    if (kind === 'readonly') chmodSync(path, 0o400);
    if (kind === 'executable') chmodSync(path, 0o700);
    await expect(acquire(vault)).rejects.toMatchObject({ code: 'publication_lock_invalid' });
    if (kind === 'content') expect(readFileSync(path, 'utf8')).toBe('preserve me');
    expect(lstatSync(outside).isFile()).toBe(true);
  });

  it('rejects an inode replaced while waiting without removing its replacement', async () => {
    const { root, vault, path } = fixture();
    const owner = await acquire(vault);
    const waiting = acquire(vault);
    const replacement = join(root, 'replacement');
    writeFileSync(replacement, '', { mode: 0o600 });
    renameSync(replacement, path);
    const inode = lstatSync(path).ino;
    expect(() => owner.fd).toThrow(/changed|invalid/i);
    owner.close();
    await expect(waiting).rejects.toMatchObject({ code: 'publication_lock_invalid' });
    expect(lstatSync(path).ino).toBe(inode);
    await acquire(vault);
  });

  it('rejects a FIFO without blocking or replacing it', async () => {
    const { vault, path } = fixture();
    const created = spawnSync('python3', ['-I', '-B', '-c', 'import os,sys; os.mkfifo(sys.argv[1],0o600)', path], { timeout: 2000 });
    expect(created.status).toBe(0);
    await expect(acquire(vault, { timeoutMs: 100 })).rejects.toMatchObject({ code: 'publication_lock_invalid' });
    expect(lstatSync(path).isFIFO()).toBe(true);
  });

  it('rejects changed permissions and hardlinks before handing out a held FD', async () => {
    const { root, vault, path } = fixture();
    const owner = await acquire(vault);
    chmodSync(path, 0o644);
    expect(() => owner.fd).toThrow(/invalid/i);
    chmodSync(path, 0o600);
    linkSync(path, join(root, 'link'));
    expect(() => owner.fd).toThrow(/invalid/i);
    unlinkSync(join(root, 'link'));
    expect(fstatSync(owner.fd).isFile()).toBe(true);
  });
});

it('explicitly rejects Windows without opening a lock', async () => {
  const { vault, path } = fixture();
  vi.stubGlobal('process', { ...process, platform: 'win32' });
  await expect(acquirePublicationLock({ vault })).rejects.toMatchObject({ code: 'publication_lock_unsupported' });
  expect(() => lstatSync(path)).toThrow();
});
