import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, type BigIntStats } from 'node:fs';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';

export const PUBLICATION_LOCK_FILE = '.learning-publication.lock';

export type PublicationLock = {
  readonly vault: string;
  readonly fd: number;
  close(): void;
};

export class PublicationLockError extends Error {
  readonly code: 'publication_lock_unsupported' | 'publication_lock_invalid' | 'publication_lock_timeout' | 'publication_lock_failed';

  constructor(code: PublicationLockError['code'], message: string) {
    super(message);
    this.name = 'PublicationLockError';
    this.code = code;
  }
}

const acquireSource = String.raw`
import fcntl, os, stat, sys, time
try:
    metadata = os.fstat(3)
    if (not stat.S_ISREG(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_uid != os.getuid() or metadata.st_nlink != 1 or metadata.st_size != 0
        or metadata.st_dev != int(sys.argv[2]) or metadata.st_ino != int(sys.argv[3])):
        sys.exit(4)
    deadline = time.monotonic() + float(sys.argv[1])
    while True:
        if time.monotonic() >= deadline:
            sys.exit(3)
        try:
            fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            time.sleep(min(0.01, max(0, deadline - time.monotonic())))
        except InterruptedError:
            continue
    print('locked', flush=True)
except Exception:
    sys.exit(2)
`;

function invalid(message = 'Invalid publication lock path, ownership or permissions'): PublicationLockError {
  return new PublicationLockError('publication_lock_invalid', message);
}

function timeout(): PublicationLockError {
  return new PublicationLockError('publication_lock_timeout', 'Publication lock acquisition deadline exceeded');
}

function directories(vault: string, uid: bigint): BigIntStats[] {
  if (!isAbsolute(vault) || resolve(vault) !== vault || /[\0\r\n]/.test(vault)) throw invalid();
  let current = parse(vault).root;
  const paths = [current];
  for (const segment of vault.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    paths.push(current);
  }
  return paths.map((path, index) => {
    const metadata = lstatSync(path, { bigint: true });
    const stickySystemDirectory = metadata.uid === 0n && (metadata.mode & 0o1000n) !== 0n;
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.uid !== 0n && metadata.uid !== uid)
      || ((metadata.mode & 0o022n) !== 0n && !stickySystemDirectory)) throw invalid();
    if (index === paths.length - 1 && (metadata.uid !== uid || (metadata.mode & 0o700n) !== 0o700n
      || (metadata.mode & 0o022n) !== 0n)) throw invalid();
    return metadata;
  });
}

function lockMetadata(metadata: BigIntStats, uid: bigint): void {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== uid || metadata.nlink !== 1n
    || (metadata.mode & 0o7777n) !== 0o600n || metadata.size !== 0n) throw invalid();
}

function verify(vault: string, path: string, descriptor: number, uid: bigint, original: BigIntStats[]): BigIntStats {
  try {
    const current = directories(vault, uid);
    if (current.length !== original.length || current.some((metadata, index) => metadata.dev !== original[index]!.dev
      || metadata.ino !== original[index]!.ino)) throw invalid('Publication vault directory changed');
    const opened = fstatSync(descriptor, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    lockMetadata(opened, uid);
    lockMetadata(named, uid);
    if (opened.dev !== named.dev || opened.ino !== named.ino) throw invalid('Publication lock inode changed');
    return opened;
  } catch (error) {
    if (error instanceof PublicationLockError) throw error;
    throw invalid();
  }
}

async function acquireKernelLock(descriptor: number, metadata: BigIntStats, deadline: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw timeout();
  await new Promise<void>((resolveAcquired, reject) => {
    const child = spawn('python3', ['-I', '-B', '-u', '-c', acquireSource, String(remaining / 1000),
      String(metadata.dev), String(metadata.ino)], { stdio: ['ignore', 'pipe', 'pipe', descriptor] });
    let failed = false;
    let failure: unknown;
    let output = '';
    const stop = (error: unknown) => {
      if (failed) return;
      failed = true;
      failure = error;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop(timeout()), Math.max(0, deadline - performance.now()));
    const abort = () => stop(signal!.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout!.on('data', (chunk: Buffer) => {
      if (output.length + chunk.length > 64) stop(new PublicationLockError('publication_lock_failed', 'Invalid publication lock helper response'));
      else output += chunk.toString('utf8');
    });
    child.stderr!.resume();
    child.once('error', () => stop(new PublicationLockError('publication_lock_failed', 'Publication lock helper could not start')));
    child.once('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failed) reject(failure);
      else if (signal?.aborted) reject(signal.reason);
      else if (code === 3 || performance.now() >= deadline) reject(timeout());
      else if (code === 4) reject(invalid());
      else if (code !== 0 || output !== 'locked\n') reject(new PublicationLockError('publication_lock_failed', 'Publication lock helper failed'));
      else resolveAcquired();
    });
  });
}

export async function acquirePublicationLock(input: { vault: string; timeoutMs?: number; signal?: AbortSignal }): Promise<PublicationLock> {
  if ((process.platform !== 'darwin' && process.platform !== 'linux') || !process.getuid) {
    throw new PublicationLockError('publication_lock_unsupported', 'Publication kernel locks require local Darwin or Linux flock support');
  }
  const { vault, signal } = input;
  signal?.throwIfAborted();
  const timeoutMs = input.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw invalid('Invalid publication lock deadline');
  const deadline = performance.now() + timeoutMs;
  const uid = BigInt(process.getuid());
  let original: BigIntStats[];
  const path = join(vault, PUBLICATION_LOCK_FILE);
  let descriptor: number;
  let metadata: BigIntStats;
  try {
    original = directories(vault, uid);
    try { lockMetadata(lstatSync(path, { bigint: true }), uid); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    descriptor = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  } catch (error) {
    if (error instanceof PublicationLockError) throw error;
    throw invalid();
  }
  try {
    metadata = verify(vault, path, descriptor, uid, original);
    await acquireKernelLock(descriptor, metadata, deadline, signal);
    signal?.throwIfAborted();
    verify(vault, path, descriptor, uid, original);
    if (performance.now() >= deadline) throw timeout();
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
  let closed = false;
  return {
    vault,
    get fd() {
      if (closed) throw invalid('Publication lock is closed');
      verify(vault, path, descriptor, uid, original);
      return descriptor;
    },
    close() {
      if (closed) return;
      closed = true;
      closeSync(descriptor);
    },
  };
}

export async function withKnowledgePublicationLock<Result>(vault: string, operation: (fd: number) => Result | Promise<Result>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Result> {
  const lease = await acquirePublicationLock({ ...options, vault });
  try {
    options.signal?.throwIfAborted();
    return await operation(lease.fd);
  } finally {
    lease.close();
  }
}
