import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

const execute = promisify(execFile);
const binary = resolve('apps/cli/dist/index.js');
const fixtureRoot = resolve('tests/fixtures/plugin-matrix/execution');
const hosts = ['ssh', 'aws-ssm', 'kubernetes-exec', 'jumpserver'] as const;
const triggers = ['webhook', 'schedule', 'git-push', 'issue-event'] as const;
const agents = ['claude-code', 'codex', 'cursor', 'pi', 'opencode', 'copilot'] as const;
const sandboxes = ['local', 'docker', 'podman', 'remote-container'] as const;
type Host = typeof hosts[number];
type Trigger = typeof triggers[number];
const token = 'matrix-local-fixture-token-0123456789';
const roots: string[] = [];
const processes = new Set<ChildProcess>();
const coveredHostTrigger = new Set<string>();
const coveredAgentSandbox = new Set<string>();

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI did not stop on SIGTERM')); }, 5000);
    child.once('exit', () => { clearTimeout(timeout); done(); });
    child.kill('SIGTERM');
  });
}

afterEach(async () => {
  try { await Promise.all([...processes].map(stop)); }
  finally {
    processes.clear();
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  }
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'plugin-execution-matrix-')));
  roots.push(root);
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const bin = join(root, 'bin');
  await Promise.all([home, workspace, bin].map(path => mkdir(path)));
  const transport = await readFile(join(fixtureRoot, 'transport.mjs'), 'utf8');
  for (const name of ['ssh', 'aws', 'kubectl', 'jms', 'docker', 'podman', 'claude', 'codex', 'cursor-agent', 'pi', 'opencode', 'copilot']) {
    const path = join(bin, name);
    await writeFile(path, `#!${process.execPath}\n${transport}`, { mode: 0o755 });
  }
  const env = {
    HOME: home, USERPROFILE: home, PATH: [bin, '/usr/bin', '/bin'].join(delimiter),
    AFK_LOG_DIR: join(root, 'logs'), AFK_EVENT_STORE_DIR: join(root, 'events'),
    MATRIX_TOKEN: token, NO_COLOR: '1',
  };
  let sequence = 0;
  const inputFile = async (input: unknown) => {
    const path = join(root, `input-${sequence++}.json`);
    await writeFile(path, JSON.stringify(input));
    return path;
  };
  const cli = (...args: string[]) => execute(process.execPath, [binary, 'plugin', ...args], { cwd: workspace, env, timeout: 15_000 });
  const configure = async (id: string, config: unknown, action?: string) => cli('configure', id, '--builtin', '--file', await inputFile(config), ...(action ? ['--action', action] : []));
  const invoke = async (host: Host, input: unknown) => cli('invoke', 'host.connection', host, 'exec', '--input', await inputFile(input), '--json');
  const configureHost = async (host: Host) => {
    const config = {
      ssh: { binary: join(bin, 'ssh'), hosts: [{ alias: 'worker', address: '127.0.0.1', username: 'fixture', port: 2222 }] },
      'aws-ssm': { binary: join(bin, 'aws'), hosts: [{ alias: 'worker', instanceId: 'i-123abc', region: 'us-east-1' }] },
      'kubernetes-exec': { binary: join(bin, 'kubectl'), hosts: [{ alias: 'worker', pod: 'worker-0', namespace: 'matrix', container: 'agent' }] },
      jumpserver: { serverAlias: 'matrix' },
    }[host];
    await configure(`host.${host}`, config);
  };
  const payload = join(root, 'payload.mjs');
  await writeFile(payload, `import { appendFileSync } from 'node:fs';
    const [artifact, status, ...argv] = process.argv.slice(2);
    const result = { argv, cwd: process.cwd(), simulated: true };
    appendFileSync(artifact, JSON.stringify(result) + '\\n');
    console.log(JSON.stringify(result));
    if (Number(status)) console.error('simulated process failure');
    process.exit(Number(status));\n`);
  const command = (artifact: string, status = 0) => [process.execPath, payload, artifact, String(status), 'space value', "quote' ; $(touch should-not-exist)", '$HOME', ''];
  const transportCalls = async (): Promise<Array<{ binary: string; argv: string[] }>> => {
    try { return (await readFile(join(root, 'transport.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  };
  const service = async (args: string[], ready: string) => {
    const child = spawn(process.execPath, [binary, 'plugin', ...args, '--port', '0', '--token-env', 'MATRIX_TOKEN'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
    processes.add(child);
    let stdout = '';
    let stderr = '';
    child.stderr!.on('data', chunk => { stderr += chunk; });
    const url = await new Promise<string>((done, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Listener startup timed out: ${stdout} ${stderr}`)), 10_000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Listener exited ${code}: ${stderr}`)); });
      child.stdout!.on('data', chunk => {
        stdout += chunk;
        const match = new RegExp(`${ready} ready at (127\\.0\\.0\\.1:\\d+)`).exec(stdout);
        if (match) { clearTimeout(timeout); done(`http://${match[1]}`); }
      });
    });
    return { child, url, stderr: () => stderr };
  };
  const listen = () => service(['listen'], 'Plugin listener');
  const managed = async (agent: string, sandbox: string, mode = 'success') => {
    await execute('git', ['init', '--initial-branch=main', workspace], { env });
    await writeFile(join(workspace, '.gitignore'), '.afk/\nmatrix-agent.json\nmanaged-result.json\n');
    await execute('git', ['add', '.gitignore'], { cwd: workspace, env });
    await execute('git', ['-c', 'user.name=Matrix Fixture', '-c', 'user.email=matrix@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture'], { cwd: workspace, env });
    await mkdir(join(workspace, '.afk', 'workflows'), { recursive: true });
    await writeFile(join(workspace, '.afk', 'workflows', 'matrix.yml'), 'name: matrix\nversion: 1\nsteps:\n  - id: implement\n    kind: agent\n    role: implementer\n    prompt: /goal Run the simulated matrix agent\n  - id: queue\n    kind: system\n    action: queue-qa\n    dependsOn: [implement]\n');
    await writeFile(join(root, 'agent-mode'), mode);
    let remote: Awaited<ReturnType<typeof service>> | undefined;
    try {
      if (sandbox === 'remote-container') {
        remote = await service(['serve-container', '--repository', workspace, '--workspace-root', workspace, '--sandbox', 'local', '--agent', ...agents], 'Remote container service');
        await configure('sandbox.remote-container', { transport: 'http', endpoint: remote.url, token: { env: 'MATRIX_TOKEN' } });
      }
      await execute(process.execPath, [join(fixtureRoot, 'managed-run.mjs'), agent, sandbox, mode], {
        cwd: workspace, env: { ...env, MATRIX_RUNTIME: resolve('packages/runtime/dist') }, timeout: 20_000,
      });
      return JSON.parse(await readFile(join(workspace, 'managed-result.json'), 'utf8'));
    } finally { if (remote) await stop(remote.child); }
  };
  return { root, home, workspace, env, cli, configure, invoke, configureHost, command, transportCalls, listen, managed };
}

function triggerConfig(trigger: Trigger, input: unknown) {
  const filters = { webhook: { event: 'matrix' }, 'git-push': { branch: 'main' }, 'issue-event': { action: 'opened', label: 'matrix' }, schedule: {} }[trigger];
  return {
    ...(trigger === 'webhook' ? { secret: { env: 'MATRIX_TOKEN' } } : {}),
    triggers: [{ id: 'matrix', kind: trigger === 'schedule' ? 'schedule' : 'webhook', ...(trigger === 'schedule' ? { schedule: '150' } : { payload: filters }), input }],
  };
}

async function deliver(url: string, trigger: Exclude<Trigger, 'schedule'>, matches = true, authenticated = true) {
  const payload = {
    webhook: { event: matches ? 'matrix' : 'other', payload: { simulated: true } },
    'git-push': { ref: `refs/heads/${matches ? 'main' : 'other'}`, deleted: false },
    'issue-event': { action: matches ? 'opened' : 'closed', issue: { labels: ['matrix'] } },
  }[trigger];
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = trigger === 'webhook'
    ? { 'x-hub-signature-256': `sha256=${createHmac('sha256', authenticated ? token : 'wrong').update(body).digest('hex')}` }
    : trigger === 'git-push' ? { 'x-gitlab-token': authenticated ? token : 'wrong' }
      : { authorization: `Bearer ${authenticated ? token : 'wrong'}` };
  const response = await fetch(`${url}/triggers/trigger.${trigger}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: await response.json() };
}

async function waitDelivery(url: string, deliveryId: string) {
  await vi.waitFor(async () => {
    const response = await fetch(`${url}/deliveries`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) });
    const status = await response.json() as { deliveries: Array<{ deliveryId: string; status: string }> };
    expect(status.deliveries.find(delivery => delivery.deliveryId === deliveryId)?.status).toBe('delivered');
  }, { timeout: 5000, interval: 25 });
}

describe('built CLI host command transports (simulated remote commands)', () => {
  it.each(hosts)('%s preserves arguments, effects, process failures, invalid and disabled input', async host => {
    const current = await fixture();
    await current.configureHost(host);
    const artifact = join(current.root, 'effects.jsonl');
    const input = { host: host === 'jumpserver' ? 'worker@matrix' : 'worker', argv: current.command(artifact) };
    const success = JSON.parse((await current.invoke(host, input)).stdout);
    expect(success.code).toBe(0);
    expect(JSON.parse(success.stdout)).toEqual({ argv: input.argv.slice(4), cwd: current.workspace, simulated: true });
    expect(JSON.parse((await readFile(artifact, 'utf8')).trim())).toEqual(JSON.parse(success.stdout));
    await expect(readFile(join(current.workspace, 'should-not-exist'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(current.invoke(host, { ...input, argv: current.command(artifact, 23) })).rejects.toMatchObject({
      code: 1, stdout: expect.stringContaining('"code": 23'),
    });
    expect((await readFile(artifact, 'utf8')).trim().split('\n')).toHaveLength(2);
    const calls = await current.transportCalls();
    expect(calls.length).toBeGreaterThan(0);
    const commandCall = calls.find(call => host === 'aws-ssm' ? call.argv[1] === 'send-command' : call.argv[0] === 'exec' || call.binary === 'ssh')!;
    if (host === 'ssh') expect(commandCall.argv.slice(0, 8)).toEqual(['-o', 'BatchMode=yes', '-p', '2222', '-T', '-l', 'fixture', '--']);
    if (host === 'kubernetes-exec') expect(commandCall.argv).toEqual(['exec', '--namespace=matrix', 'worker-0', '--container=agent', '--', ...input.argv]);
    if (host === 'jumpserver') expect(commandCall.argv).toEqual(['exec', 'worker@matrix', ...input.argv]);
    if (host === 'aws-ssm') {
      expect(commandCall.argv).toContain('i-123abc');
      expect(calls.some(call => call.argv[1] === 'get-command-invocation' && call.argv.includes('matrix-command'))).toBe(true);
    }
    await expect(current.invoke(host, { ...input, argv: [] })).rejects.toMatchObject({ code: 1 });
    expect(await current.transportCalls()).toEqual(calls);
    await current.cli('disable', `host.${host}`);
    await expect(current.invoke(host, input)).rejects.toMatchObject({ code: 1 });
    expect(await current.transportCalls()).toEqual(calls);
  });
});

describe('built CLI trigger listen lifecycle → host action pairs', () => {
  const rows = triggers.flatMap(trigger => hosts.map(host => ({ trigger, host })));
  it.each(rows)('$trigger → $host dispatches a real local effect through simulated transport', async ({ trigger, host }) => {
    const current = await fixture();
    await current.configureHost(host);
    const artifact = join(current.root, 'dispatch.jsonl');
    await current.configure(`trigger.${trigger}`, triggerConfig(trigger, {
      capability: 'host.connection', provider: host, operation: 'exec',
      input: { host: host === 'jumpserver' ? 'worker@matrix' : 'worker', argv: current.command(artifact) },
    }), 'capability.invoke');
    const listener = await current.listen();
    if (trigger === 'schedule') {
      await vi.waitFor(async () => expect(await readFile(artifact, 'utf8')).toContain('"simulated":true'), { timeout: 5000, interval: 25 });
    } else {
      expect(await deliver(listener.url, trigger, true, false)).toMatchObject({ status: 401 });
      const ignored = await deliver(listener.url, trigger, false);
      expect(ignored.status).toBe(202);
      await waitDelivery(listener.url, ignored.body.deliveryId);
      expect(await current.transportCalls()).toEqual([]);
      const accepted = await deliver(listener.url, trigger);
      expect(accepted.status).toBe(202);
      await waitDelivery(listener.url, accepted.body.deliveryId);
      expect(await deliver(listener.url, trigger)).toMatchObject({ status: 202, body: { deliveryId: accepted.body.deliveryId, duplicate: true } });
      expect((await readFile(artifact, 'utf8')).trim().split('\n')).toHaveLength(1);
    }
    await stop(listener.child);
    expect(listener.child.exitCode).toBe(0);
    expect(listener.stderr()).not.toContain('Trigger action failed');
    const effects = (await readFile(artifact, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(effects.every(effect => JSON.stringify(effect.argv) === JSON.stringify(current.command(artifact).slice(4)))).toBe(true);
    const afterStop = await readFile(artifact, 'utf8');
    await expect(fetch(`${listener.url}/triggers/trigger.${trigger}`, { method: 'POST', signal: AbortSignal.timeout(500) })).rejects.toThrow();
    expect(await readFile(artifact, 'utf8')).toBe(afterStop);
    coveredHostTrigger.add(`${host}/${trigger}`);
  });

  it('covers every required Host × Trigger pair with completed effect assertions', () => {
    expect([...coveredHostTrigger].sort()).toEqual(hosts.flatMap(host => triggers.map(trigger => `${host}/${trigger}`)).sort());
  });

  it.each(triggers)('%s rejects invalid configuration, disabled dispatch and process failure', async trigger => {
    const current = await fixture();
    await current.configureHost('ssh');
    const artifact = join(current.root, 'failed-dispatch.jsonl');
    const input = { capability: 'host.connection', provider: 'ssh', operation: 'exec', input: { host: 'worker', argv: current.command(artifact, 23) } };
    await current.configure(`trigger.${trigger}`, triggerConfig(trigger, input), 'capability.invoke');
    await current.cli('disable', `trigger.${trigger}`);
    const disabled = await current.listen();
    expect((await fetch(`${disabled.url}/triggers/trigger.${trigger}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })).status).toBe(404);
    await stop(disabled.child);
    expect(await current.transportCalls()).toEqual([]);
    await current.cli('enable', `trigger.${trigger}`);
    const active = await current.listen();
    if (trigger === 'schedule') {
      await vi.waitFor(() => expect(active.stderr()).toContain('Trigger action failed'), { timeout: 5000, interval: 25 });
    } else {
      const malformedBody = '{';
      const malformed = await fetch(`${active.url}/triggers/trigger.${trigger}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          // Durable webhook delivery requires a valid HMAC signature before the
          // payload is parsed; without it the listener correctly answers 401.
          'x-hub-signature-256': `sha256=${createHmac('sha256', token).update(malformedBody).digest('hex')}`,
        },
        body: malformedBody,
      });
      expect(malformed.status).toBe(400);
      expect(await current.transportCalls()).toEqual([]);
      expect(await deliver(active.url, trigger)).toMatchObject({ status: 202 });
      await vi.waitFor(() => expect(active.stderr()).toContain('Trigger action failed'), { timeout: 5000, interval: 25 });
    }
    await stop(active.child);
    expect((await readFile(artifact, 'utf8')).trim()).toContain('"simulated":true');
    const invalid = triggerConfig(trigger, input);
    invalid.triggers[0].kind = trigger === 'schedule' ? 'webhook' : 'schedule';
    await expect(current.configure(`trigger.${trigger}`, invalid, 'capability.invoke')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Invalid plugin settings') });
  });
});

describe('built WorkflowRunner Agent × Sandbox (simulated agent outputs)', () => {
  const rows = agents.flatMap(agent => sandboxes.map(sandbox => ({ agent, sandbox })));
  it.each(rows)('$agent / $sandbox builds the registered command and completes a managed subprocess', async ({ agent, sandbox }) => {
    const current = await fixture();
    const report = await current.managed(agent, sandbox);
    expect(report.error, JSON.stringify(report)).toBeUndefined();
    expect(report.result, JSON.stringify(report)).toEqual({ success: true });
    expect(report.effect).toMatchObject({ simulated: true, cwd: current.workspace, prompt: expect.stringContaining('Run the simulated matrix agent') });
    const commands = {
      'claude-code': ['--dangerously-skip-permissions', '--print', '--output-format', 'stream-json', '--verbose'],
      codex: ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '-C', current.workspace],
      cursor: ['--print', '--output-format', 'stream-json'],
      pi: ['--non-interactive'], opencode: ['run', '--format', 'json'], copilot: ['--allow-all'],
    };
    expect(report.effect.binary).toBe({ 'claude-code': 'claude', codex: 'codex', cursor: 'cursor-agent', pi: 'pi', opencode: 'opencode', copilot: 'copilot' }[agent]);
    expect(report.effect.argv).toEqual(commands[agent]);
    expect(report.events).toContainEqual(expect.objectContaining({ kind: 'step.completed', stepId: 'implement', outcome: 'succeeded' }));
    expect(report.events).toContainEqual(expect.objectContaining({ kind: 'implementation.completed' }));
    expect(report.transitions).toContain('verification');
    expect(report).toMatchObject({ released: 1, cleaned: 1, armed: false });
    if (sandbox === 'docker' || sandbox === 'podman') {
      const calls = (await current.transportCalls()).filter(call => call.binary === sandbox);
      const run = calls.find(call => call.argv[0] === 'run')!;
      expect(run.argv).toContain('--cap-drop');
      expect(run.argv).toContain('1000:1000');
      expect(run.argv).toContain(`${current.workspace}:/workspace`);
      expect(calls.some(call => call.argv[0] === 'exec')).toBe(true);
      expect(calls.some(call => call.argv[0] === 'rm')).toBe(true);
    }
    coveredAgentSandbox.add(`${agent}/${sandbox}`);
  });

  it('covers every required Agent × Sandbox pair after asserting managed effects', () => {
    expect([...coveredAgentSandbox].sort()).toEqual(agents.flatMap(agent => sandboxes.map(sandbox => `${agent}/${sandbox}`)).sort());
  });

  it.each([
    { agent: 'claude-code', sandbox: 'local' }, { agent: 'codex', sandbox: 'docker' },
    { agent: 'pi', sandbox: 'podman' }, { agent: 'cursor', sandbox: 'remote-container' },
  ])('$agent / $sandbox propagates a real subprocess failure and releases resources', async ({ agent, sandbox }) => {
    const current = await fixture();
    const report = await current.managed(agent, sandbox, 'failure');
    expect(report.error, JSON.stringify(report)).toContain('execution failed: the agent process failed with exit code 23');
    expect(report.effect).toMatchObject({ simulated: true });
    expect(report.events).toContainEqual(expect.objectContaining({ kind: 'run.finished', outcome: 'failed', reasonCode: 'agent_process_failed', reason: expect.stringContaining('simulated agent process failure') }));
    expect(report.transitions).toContain('blocked');
    expect(report.transitions).not.toContain('verification');
    expect(report).toMatchObject({ released: 1, armed: false });
  });

  it('cancels a hanging local agent at the managed deadline and kills its subprocess', async () => {
    const current = await fixture();
    const report = await current.managed('pi', 'local', 'hang');
    expect(report.error, JSON.stringify(report)).toBeUndefined();
    expect(report.result).toEqual({ success: false });
    expect(report.effect).toMatchObject({ simulated: true, pid: expect.any(Number) });
    expect(report.events).toContainEqual(expect.objectContaining({ kind: 'run.finished', outcome: 'failed', reasonCode: 'agent_completion_timeout' }));
    expect(report.transitions).toContain('blocked');
    expect(report).toMatchObject({ released: 1, armed: false });
    await vi.waitFor(() => expect(() => process.kill(report.effect.pid, 0)).toThrow(), { timeout: 3000, interval: 25 });
  });

  it.each([...agents, 'missing-agent'])('rejects disabled/invalid agent %s without launching a process', async agent => {
    const current = await fixture();
    if (agent !== 'missing-agent') await current.cli('disable', `agent.${agent}`);
    const report = await current.managed(agent, 'local');
    expect(report.error).toContain(`agent provider not registered: ${agent}`);
    expect(report).toMatchObject({ released: 1, armed: false });
    await expect(readFile(join(current.workspace, 'matrix-agent.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await current.transportCalls()).toEqual([]);
  });

  it.each([...sandboxes, 'missing-sandbox'])('rejects disabled/invalid sandbox %s before creating resources', async sandbox => {
    const current = await fixture();
    if (sandbox === 'remote-container') await current.configure('sandbox.remote-container', { transport: 'http', endpoint: 'http://127.0.0.1:1', token: { env: 'MATRIX_TOKEN' } });
    if (sandbox !== 'missing-sandbox') await current.cli('disable', `sandbox.${sandbox}`);
    const report = await current.managed('pi', sandbox);
    expect(report.error).toContain(`unknown sandbox provider '${sandbox}'`);
    expect(report).toMatchObject({ released: 1, armed: false });
    expect(await current.transportCalls()).toEqual([]);
  });
});
