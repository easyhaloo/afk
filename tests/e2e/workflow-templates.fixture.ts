import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { executionWorkspacePath } from '@afk/runtime/infrastructure/workspace';

const execute = promisify(execFile);

export async function runRepositoryTemplate(entry: string, repair: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'afk-template-repo-'));
  const labels = [repair ? 'stage::qa' : 'stage::ready-for-issues', 'mode::afk'];
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url!, 'http://localhost').pathname);
    requests.push(`${req.method} ${path}`);
    const url = `http://${req.headers.host}/acme/api`;
    const project = { id: 7, path_with_namespace: 'acme/api', name: 'api', default_branch: 'main', web_url: url };
    const issue = { iid: 1, project_id: 7, state: 'opened', labels, title: 'Local template test', description: 'Check shared.txt', web_url: `${url}/-/issues/1` };
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const params = body.startsWith('{') ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body));
    if (req.method === 'PUT' && path.endsWith('/issues/1')) {
      const remove = String(params.remove_labels ?? '').split(',');
      const add = String(params.add_labels ?? '').split(',').filter(Boolean);
      labels.splice(0, labels.length, ...labels.filter(label => !remove.includes(label)), ...add);
    }
    const data = path === '/api/v4/user' ? { id: 1, username: 'fixture' }
      : path === '/api/v4/projects' ? [project] : path.endsWith('/issues') ? [issue]
      : path.endsWith('/issues/1') ? issue : path.endsWith('/notes') && req.method === 'POST' ? { id: 1, body: params.body }
      : /\/(notes|merge_requests|labels|links|members\/all)$/.test(path) ? []
      : /^\/api\/v4\/projects\/(7|acme\/api)$/.test(path) ? project : undefined;
    res.writeHead(data === undefined ? 404 : 200, { 'Content-Type': 'application/json', 'x-next-page': '' });
    res.end(JSON.stringify(data ?? { message: 'Fixture endpoint not found' }));
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const host = `127.0.0.1:${(server.address() as { port: number }).port}`;
    const workItemId = `gitlab:${host}/acme/api#1`;
    const url = `http://${host}/acme/api.git`;
    const checkout = join(executionWorkspacePath(workItemId, join(root, '.loop-workspace')), 'repositories/api');
    const remote = join(root, 'remote.git');
    const bin = join(root, 'bin');
    await mkdir(bin);
    const completion = JSON.stringify({ type: 'result', is_error: false,
      result: '<goal_complete>{"type":"goal_complete","kind":"task","summary":"Fixture change applied"}</goal_complete>' });
    await writeFile(join(bin, 'claude'), `#!/bin/sh
set -eu
if test -f "$HOME/first-prompt"; then
  cat > "$HOME/verify-prompt"
  git show HEAD:shared.txt > "$HOME/verified-content"
  git show -s --format=%P HEAD > "$HOME/verified-parents"
  exit 1
fi
cat > "$HOME/first-prompt"
git diff --name-only --diff-filter=U > "$HOME/conflicts"
echo applied > shared.txt
git add shared.txt
if ! git rev-parse --verify -q MERGE_HEAD > /dev/null; then git commit -qm 'fixture implementation'; fi
echo '${completion}'
`, { mode: 0o700 });
    const env = { HOME: root, USERPROFILE: root, PATH: `${bin}:/usr/bin:/bin`, GIT_CONFIG_NOSYSTEM: '1',
      GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0', GITLAB_URL: `http://${host}`, GITLAB_TOKEN: 'loopback-fixture', NO_COLOR: '1' };
    const git = (...args: string[]) => execute('git', args, { cwd: root, env });
    await git('config', '--global', 'user.name', 'Template Fixture');
    await git('config', '--global', 'user.email', 'fixture@example.invalid');
    await git('config', '--global', `url.file://${remote}.insteadOf`, url);
    await git('init', '--bare', '-b', 'main', remote);
    await mkdir(checkout, { recursive: true });
    await git('init', '-b', 'main', checkout);
    const local = (...args: string[]) => git('-C', checkout, ...args);
    await local('remote', 'add', 'origin', url);
    const commit = async (text: string) => {
      await writeFile(join(checkout, 'shared.txt'), text);
      await local('add', 'shared.txt');
      await local('commit', '-m', text);
    };
    await commit('base');
    if (repair) {
      await local('switch', '-c', 'afk/backlog-1');
      await commit('feature');
      await local('push', 'origin', 'afk/backlog-1');
      await local('switch', 'main');
      await commit('baseline');
    }
    await local('push', 'origin', 'main');
    const args = repair ? ['qa', '--mode', 'batch'] : ['run', '--template', 'issue-implementation', '--execution-mode', 'batch', '--hard-timeout', '10000'];
    if (repair) {
      const manifest = join(root, 'execution-manifest.json');
      const tracker = { platform: 'gitlab', projectKey: `${host}/acme/api`, providerProjectId: '7', providerHost: host };
      const workingBranch = 'afk/backlog-1';
      await writeFile(manifest, JSON.stringify({ schemaVersion: 1, workItemId, providerBacklogId: '1', tracker, workingBranch,
        repositories: [{ ...tracker, name: 'api', checkoutPath: 'repositories/api', baseBranch: 'main', workingBranch, primary: true }] }));
      args.push('--execution-manifest', manifest);
    }
    const result = await execute(process.execPath, [entry, ...args, '--agent', 'claude-code', '--backlog-id', workItemId],
      { cwd: root, env, timeout: 20_000 }).then(output => ({ ...output, code: 0 }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
    const read = (name: string) => readFile(join(root, name), 'utf8');
    return { result, requests, first: await read('first-prompt'), verify: await read('verify-prompt'),
      conflicts: await read('conflicts'), verifiedContent: await read('verified-content'), parents: (await read('verified-parents')).trim().split(' ') };
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}
