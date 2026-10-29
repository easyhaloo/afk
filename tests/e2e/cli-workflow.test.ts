import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunEventDraft } from '@afk/core';
import { JsonlEventStore } from '@afk/runtime/infrastructure/observability/jsonl-event-store';
import { COMMANDS } from '../../apps/cli/src/command-registry.js';
import { parseWorkItemInventoryResult } from '../../apps/desktop/shared/backlog-contract.js';

const exec = promisify(execFile);
const binary = resolve('apps/cli/dist/index.js');
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });

type Issue = { iid: number; title: string; description: string; labels: string[]; state: string; web_url: string; project_id: number };
type Change = { iid: number; title: string; state: string; source_branch: string; target_branch: string; detailed_merge_status: string; web_url: string };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'afk-cli-workflow-'));
  const issues: Issue[] = [];
  const changes: Change[] = [];
  const notes: Array<{ id: number; body: string }> = [];
  const unexpected: string[] = [];
  const project = { id: 7, name: 'api', path_with_namespace: 'acme/api', default_branch: 'main', web_url: 'https://gitlab.example/acme/api' };
  const labels = (value: unknown) => String(value ?? '').split(',').filter(Boolean);
  // Only the remote HTTP boundary is simulated; CLI, SDK, providers and domain
  // transitions run from the production build in separate Node processes.
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    response.setHeader('x-next-page', '');
    const send = (value: unknown, status = 200) => { response.writeHead(status); response.end(JSON.stringify(value)); };
    try {
      const url = new URL(request.url!, 'http://localhost');
      const parts = url.pathname.split('/').map(decodeURIComponent);
      const resource = parts[5];
      const iid = Number(parts[6]);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      const body = raw ? (raw.startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))) : {};
      if (url.pathname === '/api/v4/user') return send({ id: 42 });
      if (url.pathname === '/api/v4/projects') return send([project]);
      if (parts.length === 5 && parts[3] === 'projects') return send(project);
      if (resource === 'issues') {
        const issue = issues.find(item => item.iid === iid);
        if (parts.length === 6) {
          if (request.method === 'POST') {
            const created = { iid: issues.length + 1, title: body.title, description: body.description ?? '', labels: labels(body.labels), state: 'opened', web_url: `${project.web_url}/-/issues/${issues.length + 1}`, project_id: project.id };
            issues.push(created);
            return send(created, 201);
          }
          return send(issues.filter(item => !url.searchParams.get('state') || url.searchParams.get('state') === 'all' || item.state === url.searchParams.get('state')));
        }
        if (!issue) return send({ message: '404 Issue Not Found' }, 404);
        if (parts[7] === 'notes') {
          if (request.method === 'POST') { const note = { id: notes.length + 1, body: body.body }; notes.push(note); return send(note, 201); }
          return send(notes);
        }
        if (request.method === 'PUT') {
          if (body.title !== undefined) issue.title = body.title;
          if (body.description !== undefined) issue.description = body.description;
          if (body.labels !== undefined) issue.labels = labels(body.labels);
          issue.labels = [...new Set([...issue.labels.filter(label => !labels(body.remove_labels).includes(label)), ...labels(body.add_labels)])];
          if (body.state_event) issue.state = body.state_event === 'close' ? 'closed' : 'opened';
        }
        return send(issue);
      }
      if (resource === 'merge_requests') {
        if (parts.length === 6) return send(changes.filter(change => change.state === url.searchParams.get('state')));
        const change = changes.find(item => item.iid === iid);
        if (!change) return send({ message: '404 Merge Request Not Found' }, 404);
        if (parts[7] === 'merge' && request.method === 'PUT') change.state = 'merged';
        return send(change);
      }
      unexpected.push(`${request.method} ${url.pathname}`);
      send({ message: 'unsupported fixture endpoint' }, 500);
    } catch (error) {
      unexpected.push(error instanceof Error ? error.message : String(error));
      send({ message: 'fixture request failed' }, 500);
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
    expect(unexpected).toEqual([]);
  });
  const address = server.address() as { port: number };
  const env = { ...process.env, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: join(root, 'config'), GIT_CONFIG_GLOBAL: join(root, '.gitconfig'),
    GITLAB_URL: `http://127.0.0.1:${address.port}`, GITLAB_TOKEN: 'e2e-local-token', GITHUB_TOKEN: '', GH_TOKEN: '', AFK_STATE_DIR: join(root, 'state'), AFK_EVENT_STORE_DIR: join(root, 'events'), NO_COLOR: '1' };
  await exec('git', ['init', '-b', 'main', root], { env });
  await exec('git', ['-C', root, 'remote', 'add', 'origin', `${env.GITLAB_URL}/acme/api.git`], { env });
  async function cli(args: string[], status = 0) {
    const result = await exec(process.execPath, [binary, ...args], { cwd: root, env, timeout: 15_000 })
      .then(result => ({ ...result, code: 0 }), error => ({ stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? ''), code: error.code }));
    expect(result.code, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`).toBe(status);
    return result;
  }
  async function backlog(args: string[], status = 0) {
    const result = await cli(['backlog', ...args, '--json'], status);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(status === 0);
    return envelope;
  }
  return { root, cli, backlog, issues, changes, notes };
}

describe('built CLI workflows', () => {
  it('loads every registered command, prints completion scripts and rejects removed entry points', async () => {
    const { cli } = await fixture();
    expect((await cli(['--version'])).stdout.trim()).toBe('0.1.0');
    for (const name of COMMANDS.flatMap(entry => entry.names).filter(name => name !== '__complete')) {
      expect((await cli([name, '--help'])).stdout).toContain('Usage:');
    }
    for (const shell of ['bash', 'zsh', 'fish']) expect((await cli(['completion', shell])).stdout).toContain('afk');
    expect((await cli(['__complete', 'backlog', 'show'])).stdout).toBe('');
    expect((await cli(['board'], 1)).stderr).toContain('no arguments');
    expect((await cli(['tracker'], 1)).stderr.toLowerCase()).toContain('unknown command');
  });

  it('creates, lists, tags, interrupts, retries and confirms a root merge through the provider SDK', async () => {
    const { root, backlog, issues, changes, notes } = await fixture();
    await backlog(['init']);
    const description = join(root, 'description.md');
    await writeFile(description, 'Implement login\n\n- [ ] Login test passes\n');
    const created = await backlog(['create', 'Login workflow', '--description-file', description, '--tag', 'billing']);
    // The backlog carries its canonical global identity, not a bare issue number.
    expect(created.data).toMatchObject({ issueNumber: 1, title: 'Login workflow', state: 'ready', executionMode: 'afk', tags: ['billing'] });
    expect(created.data.id).toMatch(/^gitlab:127\.0\.0\.1:\d+\/acme\/api#1$/);
    expect((await backlog(['list', '--state', 'ready', '--tag', 'billing'])).data).toHaveLength(1);
    expect((await backlog(['show', '--id', '1'])).data.description).toContain('Login test passes');
    expect((await backlog(['tag', 'add', '--id', '1', '--tag', 'urgent'])).data.tags).toContain('urgent');
    expect((await backlog(['tag', 'remove', '--id', '1', '--tag', 'urgent'])).data.tags).not.toContain('urgent');
    issues[0].labels = ['stage::afk-in-progress', 'mode::afk', 'billing'];
    expect((await backlog(['interrupt', '--id', '1', '--reason', 'operator stop'])).data).toMatchObject({ state: 'blocked', executionMode: 'hitl' });
    expect((await backlog(['retry', '--id', '1', '--reason', 'fix requested'])).data).toMatchObject({ state: 'rework', executionMode: 'afk' });
    expect(notes.some(note => note.body.includes('fix requested'))).toBe(true);
    issues[0].labels = ['stage::merge-ready', 'mode::hitl', 'billing'];
    changes.push({ iid: 8, title: 'Login workflow', state: 'opened', source_branch: `${created.data.branchName}-qa`, target_branch: 'main', detailed_merge_status: 'mergeable', web_url: 'https://gitlab.example/acme/api/-/merge_requests/8' });
    expect((await backlog(['confirm-merge', '--id', '1'])).data.state).toBe('done');
    expect(changes[0].state).toBe('merged');
    expect(issues[0].state).toBe('closed');
    expect((await backlog(['list', '--state', 'ready'])).data).toEqual([]);
    expect((await backlog(['list', '--state', 'done'])).data).toHaveLength(1);
  });

  it('adopts an unmanaged issue and preserves machine-readable validation and provider errors', async () => {
    const { backlog, issues } = await fixture();
    issues.push({ iid: 1, title: 'Manual task', description: 'Acceptance criteria', labels: ['billing'], state: 'opened', web_url: 'https://gitlab.example/acme/api/-/issues/1', project_id: 7 });
    expect((await backlog(['adopt', '--id', '1', '--project', 'acme/api', '--platform', 'gitlab'])).data).toMatchObject({ state: 'ready', executionMode: 'afk', tags: ['billing'] });
    const inventory = (await backlog(['inventory', '--platform', 'gitlab'])).data;
    expect(inventory.complete, JSON.stringify(inventory.diagnostics)).toBe(true);
    expect(inventory.items[0]).toMatchObject({ managed: true, executionEligible: true, issueNumber: 1 });
    expect(parseWorkItemInventoryResult(inventory).items[0].id).toBe(inventory.items[0].id);
    expect((await backlog(['show'], 1)).error.code).toBe('validation');
    expect((await backlog(['show', '--id', '999'], 1)).error.code).toBe('not_found');
    expect((await backlog(['interrupt', '--id', '1', '--reason', 'invalid state'], 1)).error.message).toContain('cannot interrupt');
    expect((await backlog(['show', '--id', '1'])).data.state).toBe('ready');
  });

  it('generates workflow graph artifacts and enforces the output boundary', async () => {
    const { root, cli } = await fixture();
    const workflows = join(root, '.afk', 'workflows');
    await mkdir(workflows, { recursive: true });
    await writeFile(join(workflows, 'review.yml'), 'name: review\nversion: 1\nsteps:\n  - id: implement\n    role: implementer\n    prompt: implement\n  - id: review\n    role: reviewer\n    prompt: review\n    dependsOn: [implement]\n');
    const graph = JSON.parse((await cli(['graph', 'workflow', 'review', '--validate'])).stdout);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
    expect(JSON.parse(await readFile(graph.cache.graphPath, 'utf8')).nodes).toEqual(graph.nodes);
    const again = JSON.parse((await cli(['graph', 'workflow', 'review', '--validate'])).stdout);
    expect(again.cache.directory).toBe(graph.cache.directory);
    expect((await cli(['graph', 'workflow', 'review', '--output', '../outside'], 1)).stderr).toContain('inside the workspace');
  });

  it('reads verified execution history, replays events and detects audit tampering', async () => {
    const { root, cli } = await fixture();
    const eventsRoot = join(root, 'events');
    const store = new JsonlEventStore({ root: eventsRoot });
    const context = { traceId: 'cli-run', runId: 'cli-run', workItemId: 'gitlab:gitlab.example/acme/api#1', profileId: 'e2e', attempt: 1, actor: { kind: 'cli' as const, id: 'e2e' } };
    const data: RunEventDraft['data'][] = [
      { kind: 'run.requested', run: { id: context.runId, workItemId: context.workItemId, profileId: context.profileId, attempt: 1, status: 'pending' } },
      { kind: 'run.started' }, { kind: 'run.finished', outcome: 'succeeded' },
    ];
    await store.append(data.map((data, index) => ({ id: `event-${index}`, schemaVersion: 1, type: data.kind, context, correlationId: context.runId, occurredAt: new Date().toISOString(), data })));
    const observe = async (...args: string[]) => JSON.parse((await cli(['observe', ...args, '--root', eventsRoot, '--json'])).stdout);
    expect(await observe('runs')).toEqual(['cli-run']);
    expect(await observe('verify', 'cli-run')).toMatchObject({ valid: true, lastSequence: 3 });
    expect((await observe('executions', '--work-item-id', context.workItemId)).executions[0]).toMatchObject({ runId: 'cli-run', workItemId: context.workItemId, terminal: true });
    expect((await observe('replay', 'cli-run')).state.run.status).toBe('succeeded');
    const eventFiles = (await readdir(eventsRoot)).filter(name => name.endsWith('.jsonl'));
    expect(eventFiles).toHaveLength(1);
    const eventFile = join(eventsRoot, eventFiles[0]);
    await writeFile(eventFile, (await readFile(eventFile, 'utf8')).replace('"outcome":"succeeded"', '"outcome":"failed"'));
    expect(await observe('verify', 'cli-run')).toMatchObject({ valid: false });
    expect((await observe('executions')).executions).toEqual([]);
  });

  it.each(['execute', 'reconcile'])('%s rejects an absent manifest without changing provider state', async command => {
    const { root, cli, issues } = await fixture();
    const result = await cli([command, '--work-item-id', 'gitlab:gitlab.example/acme/api#1', '--execution-id', 'cli-run', '--execution-manifest', join(root, 'missing.json')], 1);
    expect(result.stderr).toContain('file does not exist');
    expect(issues).toEqual([]);
  });
});
