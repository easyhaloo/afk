import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const names = ['api', 'web'] as const;
export const branch = 'afk/backlog-1';

export async function startRepositoryServer(root: string, onPushRequest?: (request: string) => void) {
  const labels = ['stage::ready-for-issues', 'mode::afk'];
  const requests: string[] = [];
  let change: Record<string, unknown> | undefined;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, 'http://localhost');
      const path = decodeURIComponent(url.pathname);
      requests.push(`${request.method} ${path}`);
      if (url.searchParams.get('service') === 'git-receive-pack' || path.endsWith('/git-receive-pack')) {
        onPushRequest?.(`${request.method} ${path}${url.search}`);
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      if (/^\/acme\/(api|web)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.test(path)) {
        const backend = execute('git', ['http-backend'], { encoding: 'buffer', timeout: 10_000, env: {
          HOME: root, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_PROJECT_ROOT: join(root, 'remotes'),
          GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: path, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method,
          CONTENT_TYPE: request.headers['content-type'] ?? '', CONTENT_LENGTH: String(body.length),
        } });
        const input = pipeline(Readable.from([body]), backend.child.stdin!).catch((error: NodeJS.ErrnoException) => {
          // Git can return a valid CGI response before consuming a rejected request body.
          if (error.code !== 'EPIPE') throw error;
        });
        const [{ stdout }] = await Promise.all([backend, input]);
        const split = stdout.indexOf('\r\n\r\n');
        if (split < 0) throw new Error('Invalid Git CGI response');
        for (const line of stdout.subarray(0, split).toString().split('\r\n')) {
          const separator = line.indexOf(':');
          const name = line.slice(0, separator);
          const value = line.slice(separator + 1).trim();
          if (name.toLowerCase() === 'status') response.statusCode = parseInt(value, 10);
          else response.setHeader(name, value);
        }
        response.end(stdout.subarray(split + 4));
        return;
      }
      const projectUrl = `http://${request.headers.host}/acme/api`;
      const project = { id: 7, path_with_namespace: 'acme/api', name: 'api', default_branch: 'main', web_url: projectUrl };
      const issue = { iid: 1, project_id: 7, state: 'opened', labels, title: 'Update shared.txt in api and web', description: 'Check shared.txt in both published branches.', web_url: `${projectUrl}/-/issues/1` };
      const text = body.toString();
      const params = text.startsWith('{') ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text));
      if (request.method === 'POST' && path.endsWith('/merge_requests')) {
        change = { ...params, iid: 2, state: 'opened', web_url: `${projectUrl}/-/merge_requests/2`, detailed_merge_status: 'mergeable' };
      }
      if (request.method === 'PUT' && path.endsWith('/issues/1')) {
        const remove = String(params.remove_labels ?? '').split(',');
        labels.splice(0, labels.length, ...labels.filter(label => !remove.includes(label)), ...String(params.add_labels ?? '').split(',').filter(Boolean));
      }
      const data = path === '/api/v4/user' ? { id: 1, username: 'fixture' }
        : path === '/api/v4/projects' ? [project] : path.endsWith('/issues') ? [issue]
        : path.endsWith('/issues/1') ? issue : path.endsWith('/notes') && request.method === 'POST' ? { id: 1, body: params.body }
        : path.endsWith('/merge_requests') ? (request.method === 'POST' ? change : change ? [change] : [])
        : path.endsWith('/merge_requests/2') ? change : path.endsWith('/closes_issues') ? []
        : /\/(notes|labels|links|members\/all)$/.test(path) ? []
        : /^\/api\/v4\/projects\/(7|acme\/api)$/.test(path) ? project : undefined;
      response.writeHead(data === undefined ? 404 : 200, { 'Content-Type': 'application/json', 'x-next-page': '' });
      response.end(JSON.stringify(data ?? { message: 'Fixture endpoint not found' }));
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  return { host: `127.0.0.1:${(server.address() as AddressInfo).port}`, requests,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

export async function prepareRepositoryRun(root: string, host: string, entry: string, dirty = false, verificationCommand?: string[], policy?: string,
  verificationProvider = 'test-runner') {
  const bin = join(root, 'bin');
  const managed = join(root, 'managed');
  await mkdir(bin);
  await mkdir(join(root, '.afk'));
  const env = { HOME: root, USERPROFILE: root, PATH: `${bin}:/usr/bin:/bin`, GIT_CONFIG_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: 'http',
    GIT_TERMINAL_PROMPT: '0', GITLAB_URL: `http://${host}`, GITLAB_TOKEN: 'loopback-fixture', NO_COLOR: '1' };
  const git = async (...args: string[]) => (await execute('git', args, { cwd: root, env })).stdout.trim();
  const cli = async (...args: string[]) => (await execute(process.execPath, [entry, ...args], { cwd: root, env, timeout: 45_000 })).stdout;
  await git('config', '--global', 'user.name', 'Template Fixture');
  await git('config', '--global', 'user.email', 'fixture@example.invalid');
  await writeFile(join(root, 'gitignore'), '/.afk/unowned.txt\n');
  await git('config', '--global', 'core.excludesFile', join(root, 'gitignore'));
  const repositories = [];
  for (const [index, name] of names.entries()) {
    const path = join(root, 'seed', name);
    const bare = join(root, 'remotes', 'acme', `${name}.git`);
    const remoteUrl = `http://${host}/acme/${name}.git`;
    const projectKey = `${host}/acme/${name}`;
    const leaseKey = `gitlab:${projectKey}`;
    await git('init', '-b', 'main', path);
    await writeFile(join(path, 'shared.txt'), `${name}\n`);
    await git('-C', path, 'add', 'shared.txt');
    await git('-C', path, 'commit', '-qm', `Seed ${name}`);
    await git('init', '--bare', '-b', 'main', bare);
    await git('-C', bare, 'config', 'http.receivepack', 'true');
    await git('-C', path, 'push', remoteUrl, 'main');
    const hash = createHash('sha256').update(leaseKey).digest('hex');
    repositories.push({ name, bare, seed: await git('-C', path, 'rev-parse', 'HEAD'),
      lock: join(root, '.afk', 'state', 'claims', 'repositories', hash, 'execution', 'lock'),
      config: { name, path, remoteUrl, baseBranch: 'main', leaseKey },
      tracker: { platform: 'gitlab', projectKey, providerProjectId: String(7 + index), providerHost: host } });
  }
  const tracker = repositories[0]!.tracker;
  const workItemId = `gitlab:${tracker.projectKey}#1`;
  const manifest = join(root, 'execution-manifest.json');
  await writeFile(manifest, JSON.stringify({ schemaVersion: 1, workItemId, providerBacklogId: '1', tracker, workingBranch: branch,
    repositories: repositories.map(({ name, tracker }) => ({ ...tracker, name, checkoutPath: `repositories/${name}`, baseBranch: 'main', workingBranch: branch, primary: name === 'api' })) }));
  await writeFile(join(root, '.afk', 'plugins.yml'), JSON.stringify({ integrations: {
    repository: { provider: 'multi-repository' },
    ...(policy && { policies: [{ provider: policy, input: { action: 'publish' } }] }),
    ...(verificationCommand && { verifications: [{ provider: verificationProvider, command: verificationCommand, timeoutMs: 5000 }] }),
  } }));
  const config = join(root, 'repositories.json');
  await writeFile(config, JSON.stringify({ repositories: repositories.map(repo => repo.config), managed: { workspaceRoot: managed } }));
  await cli('plugin', 'configure', 'repository.multi-repository', '--builtin', '--file', config);
  const result = (kind: string) => JSON.stringify({ type: 'result', is_error: false,
    result: `<goal_complete>${JSON.stringify({ type: 'goal_complete', kind, result: 'PASS', summary: 'Checked shared.txt' })}</goal_complete>` });
  await writeFile(join(bin, 'claude'), `#!/bin/sh
set -eu
context=$(sed -n 's/.*written to \\([^ ]*\\) in this worktree.*/\\1/p')
grep -Fxq 'Check shared.txt in both published branches.' "$context"
if test "$(git branch --show-current)" = '${branch}-qa'; then
  echo qa >> "$HOME/context-readers"
  test "$(cat shared.txt)" = 'applied api'
  echo '${result('qa')}'
  exit 0
fi
if test -f "$HOME/primary"; then
  echo ac >> "$HOME/context-readers"
  ${dirty ? 'echo preserve > .afk/unowned.txt' : ':'}
  test "$(git show HEAD:shared.txt)" = 'applied api'
  echo '${result('ac_verification')}'
  exit 0
fi
pwd -P > "$HOME/primary"
echo implementation >> "$HOME/context-readers"
${repositories.map(({ name, lock }) => `cp "$HOME/${lock.slice(root.length + 1)}/claim.json" "$HOME/${name}.claim"`).join('\n')}
for checkout in "$HOME"/managed/*; do
  test -f "$checkout/.git" || continue
  name=$(cat "$checkout/shared.txt")
  git -C "$checkout" rev-parse --show-toplevel > "$HOME/$name.path"
  git -C "$checkout" rev-parse HEAD > "$HOME/$name.head"
  git -C "$checkout" branch --show-current > "$HOME/$name.branch"
  git -C "$checkout" remote get-url --push origin > "$HOME/$name.origin"
  echo "applied $name" > "$checkout/shared.txt"
  if test -f "$HOME/$name.shared.txt"; then cp "$HOME/$name.shared.txt" "$checkout/shared.txt"; fi
  git -C "$checkout" commit -qam "apply $name"
done
echo '${result('task')}'
`, { mode: 0o700 });
  return { repositories, cli, git, managed, workItemId, manifest };
}
