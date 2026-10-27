import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const installer = resolve('install.sh');
const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'afk installer '));
  directories.push(root);
  const home = join(root, 'home');
  const bin = join(root, 'tools');
  await mkdir(home);
  await mkdir(bin);
  await copyFile(installer, join(root, 'install.sh'));
  for (const tool of ['pnpm', 'npm', 'tsc']) {
    const file = join(bin, tool);
    await writeFile(file, '#!/bin/sh\necho "unexpected build tool" >&2\nexit 99\n');
    await chmod(file, 0o755);
  }
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, SHELL: '/bin/zsh' };
  const install = (...args: string[]) => exec('bash', [join(root, 'install.sh'), '--skip-completion', ...args], { cwd: root, env });
  const command = join(home, '.local/bin/afk');
  return { root, home, env, command, install };
}

async function archive(root: string, version = '0.1.0', options: { broken?: boolean; platform?: string; externalLink?: boolean } = {}) {
  const source = join(root, `source-${version}`);
  const directory = join(source, 'afk');
  await mkdir(join(directory, 'dist'), { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module', version, engines: { node: '>=22.16' } }));
  await writeFile(join(directory, 'release.json'), JSON.stringify({ version, platform: options.platform ?? process.platform, arch: process.arch, nodeMinimum: '22.16.0' }));
  await writeFile(join(directory, 'dist/dependency.js'), 'export {};\n');
  await symlink(options.externalLink ? root : 'dependency.js', join(directory, 'dist/link.js'));
  await writeFile(join(directory, 'dist/index.js'), options.broken ? '#!/usr/bin/env node\nprocess.exit(7);\n'
    : `#!/usr/bin/env node\nimport './link.js';\nconsole.log(process.argv.includes('--version') ? '${version}' : JSON.stringify(process.argv.slice(2)));\n`);
  await chmod(join(directory, 'dist/index.js'), 0o755);
  const file = join(root, `afk-${version}.tar.gz`);
  await exec('tar', ['-czf', file, '-C', source, 'afk']);
  const checksum = `${file}.sha256`;
  await writeFile(checksum, `${createHash('sha256').update(await readFile(file)).digest('hex')}  ${file.split('/').at(-1)}\n`);
  return { file, checksum };
}

describe('precompiled CLI installer', () => {
  it('installs outside the repository without build tools and supports repeated installation', async () => {
    const { root, env, home, command, install } = await fixture();
    const { file, checksum } = await archive(root);
    const args = ['--archive', file, '--checksum', checksum];
    await install(...args);
    expect((await exec(command, ['--version'], { env })).stdout.trim()).toBe('0.1.0');
    expect(JSON.parse((await exec(command, ['with spaces', '$literal'], { env })).stdout)).toEqual(['with spaces', '$literal']);
    expect(await readlink(command)).toContain(join(home, '.afk/cli/versions'));
    const first = await readlink(command);
    await install(...args);
    expect(await readlink(command)).toBe(first);
    expect(await readdir(join(home, '.afk/cli'))).toEqual(['versions']);
  });

  it.each(['0.1.1', 'latest'])('downloads release %s and its checksum, then upgrades the executable', async version => {
    const { root, home, env, command, install } = await fixture();
    const first = await archive(root);
    await install('--archive', first.file, '--checksum', first.checksum);
    const second = await archive(root, '0.1.1');
    const requests: string[] = [];
    const asset = `afk-${process.platform}-${process.arch}.tar.gz`;
    const server = createServer(async (request, response) => {
      requests.push(request.url!);
      response.end(await readFile(request.url!.endsWith('.sha256') ? second.checksum : second.file));
    });
    servers.push(server);
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address() as { port: number };
    await exec('bash', [join(root, 'install.sh'), '--skip-completion', '--version', version], {
      cwd: root, env: { ...env, AFK_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}` },
    });
    const path = version === 'latest' ? '/latest/download' : '/download/cli-v0.1.1';
    expect(requests).toEqual([`${path}/${asset}`, `${path}/${asset}.sha256`]);
    expect((await exec(command, ['--version'], { env })).stdout.trim()).toBe('0.1.1');
    expect(await readdir(join(home, '.afk/cli/versions'))).toHaveLength(2);
  });

  it.each(['checksum', 'startup', 'platform', 'version', 'download', 'external link'])('preserves the installed version after a %s failure', async failure => {
    const { root, env, command, install } = await fixture();
    const first = await archive(root);
    await install('--archive', first.file, '--checksum', first.checksum);
    const target = await readlink(command);
    const next = await archive(root, '0.1.1', { broken: failure === 'startup', platform: failure === 'platform' ? 'unsupported' : undefined, externalLink: failure === 'external link' });
    if (failure === 'checksum') await writeFile(next.checksum, `${'0'.repeat(64)}  archive.tar.gz\n`);
    const args = failure === 'download' ? ['--version', '0.1.1'] : ['--archive', next.file, '--checksum', next.checksum];
    if (failure === 'version') args.push('--version', '0.2.0');
    await expect(exec('bash', [join(root, 'install.sh'), '--skip-completion', ...args], {
      cwd: root, env: { ...env, AFK_RELEASE_BASE_URL: 'http://127.0.0.1:1' },
    })).rejects.toThrow();
    expect(await readlink(command)).toBe(target);
    expect((await exec(command, ['--version'], { env })).stdout.trim()).toBe('0.1.0');
  });

  it('requires force before replacing an unrelated executable', async () => {
    const { root, command, install } = await fixture();
    const { file, checksum } = await archive(root);
    await mkdir(join(command, '..'), { recursive: true });
    await writeFile(command, 'keep this file');
    await expect(install('--archive', file, '--checksum', checksum)).rejects.toThrow();
    expect(await readFile(command, 'utf8')).toBe('keep this file');
    await install('--force', '--archive', file, '--checksum', checksum);
    expect(await readlink(command)).toContain('.afk/cli/versions');
  });

});
