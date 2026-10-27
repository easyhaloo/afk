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
    expect(await readdir(join(home, '.afk/cli'))).toEqual(['downloads', 'versions']);
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
    expect(requests).toEqual([`${path}/${asset}.sha256`, `${path}/${asset}`]);
    expect((await exec(command, ['--version'], { env })).stdout.trim()).toBe('0.1.1');
    expect(await readdir(join(home, '.afk/cli/versions'))).toHaveLength(2);
  });

  it('downloads through an environment proxy', async () => {
    const { root, env, command } = await fixture();
    const release = await archive(root);
    const requests: string[] = [];
    const server = createServer(async (request, response) => {
      requests.push(request.url!);
      response.end(await readFile(request.url!.endsWith('.sha256') ? release.checksum : release.file));
    });
    servers.push(server);
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address() as { port: number };
    const proxy = `http://127.0.0.1:${address.port}`;
    const base = 'http://afk.invalid/releases';
    await exec('bash', [join(root, 'install.sh'), '--skip-completion'], {
      cwd: root,
      env: { ...env, AFK_RELEASE_BASE_URL: base, http_proxy: proxy, HTTP_PROXY: proxy, ALL_PROXY: '', all_proxy: '', NO_PROXY: '', no_proxy: '', NODE_USE_ENV_PROXY: '0' },
    });
    const asset = `${base}/latest/download/afk-${process.platform}-${process.arch}.tar.gz`;
    expect(requests).toEqual([`${asset}.sha256`, asset]);
    expect((await exec(command, ['--version'], { env })).stdout.trim()).toBe('0.1.0');
  });

  it('retries a transient download failure and follows redirects', async () => {
    const { root, env, command } = await fixture();
    const release = await archive(root);
    const asset = `/latest/download/afk-${process.platform}-${process.arch}.tar.gz`;
    let attempts = 0;
    const server = createServer(async (request, response) => {
      if (request.url === asset) {
        attempts += 1;
        response.writeHead(attempts === 1 ? 503 : 302, { Location: '/archive' });
        response.end();
      } else response.end(await readFile(request.url!.endsWith('.sha256') ? release.checksum : release.file));
    });
    servers.push(server);
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address() as { port: number };
    await exec('bash', [join(root, 'install.sh'), '--skip-completion'], {
      cwd: root, env: { ...env, AFK_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}` },
    });
    expect(attempts).toBe(2);
    expect((await exec(command, ['--version'], { env })).stdout.trim()).toBe('0.1.0');
  });

  it('reuses a verified release archive on repeated installation', async () => {
    const { root, env, command } = await fixture();
    const release = await archive(root);
    const requests: string[] = [];
    const server = createServer(async (request, response) => {
      requests.push(request.url!);
      response.end(await readFile(request.url!.endsWith('.sha256') ? release.checksum : release.file));
    });
    servers.push(server);
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address() as { port: number };
    const install = { ...env, AFK_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}` };
    await exec('bash', [join(root, 'install.sh'), '--skip-completion'], { cwd: root, env: install });
    await exec('bash', [join(root, 'install.sh'), '--skip-completion'], { cwd: root, env: install });
    expect(requests.filter(request => !request.endsWith('.sha256'))).toHaveLength(1);
    expect((await exec(command, ['--version'], { env })).stdout.trim()).toBe('0.1.0');
  });

  it.each(['supported', 'ignored', 'rejected'])('retains an interrupted download (ranges %s)', async rangeSupport => {
    const { root, home, env, command } = await fixture();
    const release = await archive(root);
    const contents = await readFile(release.file);
    const offset = Math.floor(contents.length / 2);
    const ranges: Array<string | undefined> = [];
    const server = createServer(async (request, response) => {
      if (request.url!.endsWith('.sha256')) {
        response.end(await readFile(release.checksum));
        return;
      }
      ranges.push(request.headers.range);
      if (ranges.length === 1) {
        response.writeHead(200, { 'Content-Length': contents.length, Connection: 'close' });
        response.end(contents.subarray(0, offset));
      } else if (rangeSupport === 'supported') {
        response.writeHead(206, { 'Content-Range': `bytes ${offset}-${contents.length - 1}/${contents.length}` });
        response.end(contents.subarray(offset));
      } else if (rangeSupport === 'rejected' && request.headers.range) {
        response.writeHead(416);
        response.end();
      } else response.end(contents);
    });
    servers.push(server);
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address() as { port: number };
    const install = () => exec('bash', [join(root, 'install.sh'), '--skip-completion'], {
      cwd: root, env: { ...env, AFK_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}` },
    });
    await expect(install()).rejects.toThrow();
    const cache = join(home, '.afk/cli/downloads');
    const files = await readdir(cache);
    expect(files).toHaveLength(1);
    expect(await readFile(join(cache, files[0]))).toEqual(contents.subarray(0, offset));
    await install();
    expect(ranges).toEqual(rangeSupport === 'supported' ? [undefined, `bytes=${offset}-`] : [undefined, `bytes=${offset}-`, undefined]);
    expect((await exec(command, ['--version'], { env })).stdout.trim()).toBe('0.1.0');
  });

  it('uses a separate cache when the latest release checksum changes', async () => {
    const { root, env, command } = await fixture();
    const first = await archive(root);
    const second = await archive(root, '0.1.1');
    let release = first;
    const ranges: Array<string | undefined> = [];
    const server = createServer(async (request, response) => {
      if (!request.url!.endsWith('.sha256')) ranges.push(request.headers.range);
      response.end(await readFile(request.url!.endsWith('.sha256') ? release.checksum : release.file));
    });
    servers.push(server);
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address() as { port: number };
    const install = () => exec('bash', [join(root, 'install.sh'), '--skip-completion'], {
      cwd: root, env: { ...env, AFK_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}` },
    });
    await install();
    release = second;
    await install();
    expect(ranges).toEqual([undefined, undefined]);
    expect((await exec(command, ['--version'], { env })).stdout.trim()).toBe('0.1.1');
  });

  it('discards a corrupt download so a later installation can recover', async () => {
    const { root, home, env, command } = await fixture();
    const release = await archive(root);
    const contents = await readFile(release.file);
    let corrupted = true;
    const server = createServer(async (request, response) => {
      response.end(request.url!.endsWith('.sha256') ? await readFile(release.checksum) : corrupted ? Buffer.from('corrupt') : contents);
    });
    servers.push(server);
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address() as { port: number };
    const install = () => exec('bash', [join(root, 'install.sh'), '--skip-completion'], {
      cwd: root, env: { ...env, AFK_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}` },
    });
    await expect(install()).rejects.toThrow('checksum does not match');
    expect(await readdir(join(home, '.afk/cli/downloads'))).toEqual([]);
    corrupted = false;
    await install();
    expect((await exec(command, ['--version'], { env })).stdout.trim()).toBe('0.1.0');
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
    const result = exec('bash', [join(root, 'install.sh'), '--skip-completion', ...args], {
      cwd: root, env: { ...env, AFK_RELEASE_BASE_URL: 'http://127.0.0.1:1' },
    });
    await expect(result).rejects.toThrow();
    if (failure === 'download') {
      await expect(result).rejects.toMatchObject({ stderr: expect.stringContaining('download failed: http://127.0.0.1:1/') });
      await expect(result).rejects.toMatchObject({ stderr: expect.stringContaining('curl') });
    }
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
