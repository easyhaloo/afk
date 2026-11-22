import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const dockerId = /^[a-f0-9]{64}$/;
const readyLine = 'W06_READY\n';
const cleanupTimeoutMs = 5_000;
const dockerOptions = { encoding: 'utf8', killSignal: 'SIGKILL', maxBuffer: 16 * 1024 } as const;

const program = String.raw`
BEGIN { @scope = (uint64)0; }
rawtracepoint:cgroup_mkdir /str(arg1, 128) == str($1)/ {
  @scope = (uint64)((struct cgroup *)arg0)->kn->id;
  @started = count();
  @observations = count();
}
tracepoint:syscalls:sys_enter_openat /@scope && cgroup == @scope/ {
  @opening[(uint64)curtask] = 1;
}
fexit:do_filp_open /@scope && cgroup == @scope && has_key(@opening, (uint64)curtask)
  && (args.op->open_flag & 0x243) != 0
  && str(args.pathname->name, 258) == str($2) && (int64)retval == -30/ {
  @opening[(uint64)curtask] = 2;
}
tracepoint:syscalls:sys_exit_openat /@scope && cgroup == @scope && has_key(@opening, (uint64)curtask)/ {
  if (@opening[(uint64)curtask] == 2 && args.ret == -30) { @observations = count(); }
  delete(@opening[(uint64)curtask]);
}
rawtracepoint:cgroup_rmdir /@scope && str(arg1, 128) == str($1)
  && (uint64)((struct cgroup *)arg0)->kn->id == @scope/ {
  @finished = count();
  exit();
}
END { clear(@opening); }
`;

interface WitnessRequest {
  readonly observerImageId: string;
  readonly operationId: string;
  readonly containerId: string;
  readonly target: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

interface WitnessResult {
  readonly cgroupId: string;
  readonly deniedWrites: number;
}

function docker(args: string[], timeout: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { ...dockerOptions, timeout, signal }, (error, stdout, stderr) => {
      if (error) reject(error);
      else if (stderr) reject(new Error('Docker emitted a permission witness diagnostic'));
      else resolve(stdout.trimEnd());
    });
  });
}

function readWitness(stdout: string): WitnessResult {
  if (!stdout.startsWith(readyLine) || !stdout.endsWith('\n')) throw new Error('Incomplete permission witness output');
  const lines = stdout.slice(readyLine.length).split('\n').filter(Boolean);
  const fields = new Map<string, string>();
  for (const line of lines) {
    const match = /^@(scope|started|finished|observations): ([1-9][0-9]{0,19})$/.exec(line);
    if (!match || fields.has(match[1])) throw new Error('Malformed permission witness output');
    fields.set(match[1], match[2]);
  }
  const cgroupId = fields.get('scope');
  const observations = fields.get('observations');
  if (!cgroupId || BigInt(cgroupId) > 0xffffffffffffffffn || !observations
    || fields.get('started') !== '1' || fields.get('finished') !== '1') {
    throw new Error('Permission witness did not cover a complete Docker cgroup lifecycle');
  }
  const deniedWrites = Number(BigInt(observations) - 1n);
  if (!Number.isSafeInteger(deniedWrites)) throw new Error('Permission witness count is out of bounds');
  return { cgroupId, deniedWrites };
}

export async function startFrozenPermissionWitness({ observerImageId, operationId, containerId, target, timeoutMs, signal }: WitnessRequest):
Promise<{ finish(): Promise<WitnessResult>; close(): Promise<void> }> {
  if (!/^sha256:[a-f0-9]{64}$/.test(observerImageId) || !dockerId.test(containerId)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operationId)
    || target.length > 256 || !/^\/workspace(?:\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*)+$/.test(target)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new Error('Invalid frozen permission witness request');
  }
  signal?.throwIfAborted();
  const name = `w06-permission-witness-${randomUUID()}`;
  const controller = new AbortController();
  const stop = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timeoutError = new Error('Frozen permission witness timed out');
  const deadline = performance.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  const remaining = () => {
    stop.throwIfAborted();
    const milliseconds = Math.ceil(deadline - performance.now());
    if (milliseconds < 1) throw timeoutError;
    return milliseconds;
  };
  let allocationAttempted = false;
  let allocationUnconfirmed = false;
  let observerId: string | undefined;
  let cleanupTask: Promise<void> | undefined;
  const cleanup = () => cleanupTask ??= (async () => {
    clearTimeout(timer);
    if (!allocationAttempted) return;
    await docker(['container', 'rm', '--force', '--volumes', observerId ?? name], cleanupTimeoutMs).catch(() => undefined);
    const identityFilter = observerId ? `id=${observerId}` : `name=^/${name}$`;
    const present = await docker(['container', 'ls', '--all', '--quiet', '--filter', identityFilter], cleanupTimeoutMs);
    if (present || allocationUnconfirmed) throw new Error(`Permission witness cleanup could not be confirmed for ${name}`);
  })();
  const fail = async (error: unknown): Promise<never> => {
    try { await cleanup(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Frozen permission witness failed and cleanup was not confirmed'); }
    throw error;
  };

  const verifyCreated = async () => {
    const format = '{{.Id}}|{{.State.Status}}|{{.HostConfig.CgroupParent}}|{{.HostConfig.RestartPolicy.Name}}|{{.HostConfig.ReadonlyRootfs}}|{{index .Config.Labels "afk.frozen.operation"}}';
    const inspected = await docker(['container', 'inspect', '--format', format, containerId], remaining(), stop);
    if (inspected !== `${containerId}|created||no|true|${operationId}`) {
      throw new Error('Permission witness requires the operation’s unstarted read-only Docker container');
    }
  };

  let completion: Promise<WitnessResult> | undefined;
  try {
    const daemon = await docker(['info', '--format', '{{.OSType}} {{.CgroupVersion}} {{.CgroupDriver}} {{.KernelVersion}}'], remaining(), stop);
    const match = /^linux 2 (cgroupfs|systemd) (\S+)$/.exec(daemon);
    if (!match) throw new Error('Permission witness requires Docker on Linux with cgroup v2');
    const cgroupPath = match[1] === 'cgroupfs' ? `/docker/${containerId}` : `/system.slice/docker-${containerId}.scope`;
    const tracefs = match[2].includes('linuxkit') ? '/sys/kernel/debug/tracing' : '/sys/kernel/tracing';
    await verifyCreated();
    const createTimeout = remaining();
    allocationAttempted = true;
    const created = await docker(['container', 'create', '--name', name, '--pull=never', '--network=none', '--read-only',
      '--label', `afk.frozen.operation=${operationId}`, '--label', 'afk.frozen.managed=true',
      '--user=0:0', '--cap-drop=ALL', '--cap-add=BPF', '--cap-add=PERFMON', '--security-opt=no-new-privileges',
      '--log-driver=none', '--no-healthcheck', '--restart=no', '--pids-limit=32',
      '--mount', `type=bind,src=${tracefs},dst=/sys/kernel/tracing,readonly`, '--env', 'BPFTRACE_MAX_STRLEN=258',
      '--tmpfs', '/run/witness:rw,noexec,nosuid,nodev,size=64k,mode=700', '--entrypoint', '/bin/sh', observerImageId,
      '-ec', 'printf "echo W06_READY\\nexec /usr/bin/sleep 2147484\\n" > /run/witness/ready; exec /usr/bin/timeout "$@"',
      'witness', '--signal=KILL', `${Math.ceil(timeoutMs / 1000)}s`,
      '/usr/bin/stdbuf', '-oL', '/usr/bin/bpftrace', '-q', '-k', '-c', '/bin/sh /run/witness/ready',
      '-e', program, cgroupPath, target], createTimeout).catch(error => {
      allocationUnconfirmed = Boolean(error?.killed || error?.signal);
      throw error;
    });
    if (!dockerId.test(created)) throw new Error('Permission witness creation did not return a full Docker ID');
    observerId = created;

    let announceReady!: () => void;
    const ready = new Promise<void>(resolve => { announceReady = resolve; });
    const collect = new Promise<WitnessResult>((resolve, reject) => {
      const child = execFile('docker', ['container', 'start', '--attach', created], { ...dockerOptions, timeout: remaining(), signal: stop },
        (error, stdout, stderr) => {
          try {
            remaining();
            if (error) throw new Error('Permission witness trace failed', { cause: error });
            if (stderr) throw new Error(`Permission witness trace diagnostic: ${stderr.slice(0, 2_048)}`);
            resolve(readWitness(stdout));
          } catch (failure) { reject(failure); }
        });
      let prefix = '';
      child.stdout?.on('data', (chunk: Buffer | string) => {
        if (prefix.length >= readyLine.length) return;
        prefix += String(chunk).slice(0, readyLine.length - prefix.length);
        if (prefix === readyLine) announceReady();
      });
    });
    completion = collect.then(async result => { await cleanup(); return result; }, fail);
    void completion.catch(() => undefined);
    await Promise.race([ready, completion.then(() => { throw new Error('Target exited before permission witness readiness'); })]);
    await verifyCreated();
    remaining();
    const result = completion;
    const finish = () => result;
    return { finish, async close() {
      controller.abort(new Error('Frozen permission witness closed'));
      await finish().catch(() => undefined);
      await cleanup();
    } };
  } catch (error) {
    controller.abort(error);
    await completion?.catch(() => undefined);
    return fail(stop.reason ?? error);
  }
}
