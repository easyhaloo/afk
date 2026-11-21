#!/usr/bin/env bash
set -euo pipefail

command -v node >/dev/null 2>&1 || { printf '%s\n' 'Node.js 22.16+ is required.' >&2; exit 1; }
exec node --input-type=module - "$@" <<'NODE'
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { constants as osConstants, homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

const help = `AFK CLI installer — installs a precompiled release; no build tools required.

Usage: bash install.sh [options]
  --version VERSION  Install a specific CLI version (default: latest)
  --prefix DIR       Executable directory (default: ~/.local/bin)
  --archive FILE     Install a local release archive
  --checksum FILE    SHA-256 file; required with --archive
  --force            Replace an executable not managed by this installer
  --skip-completion  Skip shell completion setup
  --system           Use /usr/local/bin; requires existing write access
  -h, --help         Show this help

Release storage: $AFK_HOME/cli/versions/ (AFK_HOME defaults to ~/.afk)
Download cache: $AFK_HOME/cli/downloads/
Mirror override: AFK_RELEASE_BASE_URL (default: GitHub easyhaloo/afk releases)
Requires Node.js 22.16+ and tar; downloads also require curl.
Downloads respect HTTPS_PROXY/https_proxy, ALL_PROXY/all_proxy and NO_PROXY/no_proxy.
No elevated permissions are needed.
`;

const options = { version: 'latest', prefix: join(homedir(), '.local/bin'), archive: '', checksum: '', force: false, completion: true };
let temporary;
let pendingLink;
let activeChild;
let interruption;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    interruption ??= signal;
    activeChild?.kill('SIGKILL');
  });
}

function checkInterrupted() {
  if (interruption) throw new Error(`interrupted by ${interruption}`);
}

async function execute(command, args, options, configure) {
  checkInterrupted();
  let result;
  const child = execFile(command, args, options, (error, stdout, stderr) => { result = { error, stdout, stderr }; });
  activeChild = child;
  configure?.(child);
  await new Promise(resolve => child.once('close', resolve));
  activeChild = undefined;
  checkInterrupted();
  return result;
}

async function run(command, args, extra = {}) {
  const { error, stdout, stderr } = await execute(command, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024, ...extra });
  if (error) throw new Error(`${command} failed: ${stderr.trim() || error.message}`);
  return stdout.trim();
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function download(url, file, { resume = false, expected = '', restart = false } = {}) {
  if (resume) {
    const existing = await sha256(file).catch(() => '');
    if (existing === expected) { console.log('Using verified download cache.'); return; }
    console.log(`Downloading archive; interrupted downloads resume from ${file}`);
  }
  try {
    let { error, stdout, stderr } = await execute('curl', [
      '--disable', '--fail', '--location', '--show-error',
      ...(!resume || !process.stderr.isTTY ? ['--silent'] : []),
      '--proto', '=https,http', '--proto-redir', '=https,http',
      '--connect-timeout', '15', '--max-time', resume ? '0' : '600',
      '--speed-limit', '1024', '--speed-time', '60',
      '--retry', '2', '--retry-delay', '1', '--retry-max-time', '600',
      ...(resume && !restart ? ['--continue-at', '-'] : []),
      '--write-out', '%{http_code}',
      '--output', file, url,
    ], {}, child => {
      if (resume && process.stderr.isTTY) child.stderr.on('data', chunk => process.stderr.write(chunk));
    });
    if (!error && stdout.trim() === '416') error = Object.assign(new Error('HTTP 416: byte range rejected'), { code: 33 });
    if (error) {
      const detail = error.code === 'ENOENT' ? 'curl is required for downloads'
        : stderr.split(/[\r\n]+/).filter(line => line.startsWith('curl:')).join('\n') || error.message;
      throw new Error(`download failed: ${url}\n${detail}\nCheck your network or configure HTTPS_PROXY/ALL_PROXY or AFK_RELEASE_BASE_URL; offline installation supports --archive and --checksum.`, { cause: error });
    }
  } catch (error) {
    if (resume && !restart && (error.cause?.code === 33 || (error.cause?.code === 22 && error.message.includes('416')))) {
      console.log('Server cannot resume this archive; restarting download.');
      await rm(file, { force: true });
      await download(url, file, { resume: true, expected, restart: true });
    } else throw error;
  }
}

async function validateLinks(directory, root) {
  root ??= await realpath(directory);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const destination = relative(root, await realpath(file));
      if (destination === '..' || destination.startsWith('../') || isAbsolute(destination)) throw new Error(`release link escapes its directory: ${file}`);
    } else if (entry.isDirectory()) await validateLinks(file, root);
  }
}

try {
  const args = process.argv.slice(2);
  while (args.length) {
    const flag = args.shift();
    if (flag === '-h' || flag === '--help') { console.log(help); process.exit(0); }
    if (['--version', '--prefix', '--archive', '--checksum'].includes(flag)) {
      const value = args.shift();
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
      options[flag.slice(2)] = value;
    } else if (flag === '--force') options.force = true;
    else if (flag === '--skip-completion') options.completion = false;
    else if (flag === '--system') options.prefix = '/usr/local/bin';
    else throw new Error(`unknown option: ${flag}`);
  }
  if (options.version.startsWith('v')) options.version = options.version.slice(1);
  if (options.version !== 'latest' && !/^\d+\.\d+\.\d+$/.test(options.version)) throw new Error('version must be latest or a stable version such as 0.1.0');
  if (Boolean(options.archive) !== Boolean(options.checksum)) throw new Error('--archive and --checksum must be supplied together');
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 16)) throw new Error('Node.js 22.16+ is required');
  if (!['darwin', 'linux'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) throw new Error('supported platforms: macOS/Linux on x64/arm64');
  if (process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime) throw new Error('Linux releases require glibc; musl/Alpine is not supported');

  const prefix = resolve(options.prefix.replace(/^~(?=\/|$)/, homedir()));
  const profileRoot = process.env.AFK_HOME ?? join(homedir(), '.afk');
  if (!isAbsolute(profileRoot)) throw new Error('AFK_HOME must be an absolute path');
  const storage = join(profileRoot, 'cli');
  const versions = join(storage, 'versions');
  const downloads = join(storage, 'downloads');
  const executable = join(prefix, 'afk');
  await mkdir(prefix, { recursive: true });
  await access(prefix, constants.W_OK);
  const existing = await lstat(executable).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const target = existing?.isSymbolicLink() ? resolve(prefix, await readlink(executable)) : '';
  if (existing && (existing.isDirectory() || (!target.startsWith(`${versions}/`) && !options.force))) {
    throw new Error(`${executable} is not managed by this installer; choose --prefix or use --force for a file`);
  }
  await mkdir(versions, { recursive: true });
  await mkdir(downloads, { recursive: true });
  temporary = await mkdtemp(join(storage, '.install-'));
  const asset = `afk-${process.platform}-${process.arch}.tar.gz`;
  let archive = resolve(options.archive || join(temporary, asset));
  let checksum = resolve(options.checksum || `${archive}.sha256`);
  if (!options.archive) {
    const base = (process.env.AFK_RELEASE_BASE_URL ?? 'https://github.com/easyhaloo/afk/releases').replace(/\/$/, '');
    const release = options.version === 'latest' ? 'latest/download' : `download/cli-v${options.version}`;
    console.log(`Downloading AFK ${options.version} (${process.platform}/${process.arch})...`);
    const archiveUrl = `${base}/${release}/${asset}`;
    checksum = join(temporary, `${asset}.sha256`);
    await download(`${archiveUrl}.sha256`, checksum);
    const expected = (await readFile(checksum, 'utf8')).trim().split(/\s+/)[0].toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error(`release checksum is invalid: ${archiveUrl}.sha256`);
    archive = join(downloads, `${options.version}-${process.platform}-${process.arch}-${expected}-${asset}`);
    await download(archiveUrl, archive, { resume: true, expected });
  }
  console.log('Verifying release checksum...');
  const expected = (await readFile(checksum, 'utf8')).trim().split(/\s+/)[0];
  const actual = await sha256(archive);
  if (!/^[a-f0-9]{64}$/i.test(expected) || actual !== expected.toLowerCase()) {
    if (!options.archive) await rm(archive, { force: true });
    throw new Error('release checksum does not match');
  }

  const entries = (await run('tar', ['-tzf', archive])).split('\n');
  if (entries.some(entry => !/^afk(?:\/|$)/.test(entry) || entry.split('/').includes('..') || entry.includes('\\'))) throw new Error('archive contains an unsafe path');
  await run('tar', ['-xzf', archive, '--no-same-owner', '-C', temporary]);
  const candidate = join(temporary, 'afk');
  await validateLinks(candidate);
  const manifest = JSON.parse(await readFile(join(candidate, 'release.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version) || manifest.platform !== process.platform || manifest.arch !== process.arch || manifest.nodeMinimum !== '22.16.0') throw new Error('release metadata does not match this platform or supported runtime');
  if (options.version !== 'latest' && manifest.version !== options.version) throw new Error('release version does not match requested version');
  const entry = join(candidate, 'dist/index.js');
  await chmod(entry, 0o755);
  console.log('Checking CLI startup...');
  if (await run(process.execPath, [entry, '--version'], { cwd: temporary }) !== manifest.version) throw new Error('CLI version does not match release metadata');

  const destination = join(versions, `${manifest.version}-${manifest.platform}-${manifest.arch}-${actual}`);
  const installed = await lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (installed) {
    if (!installed.isDirectory() || installed.isSymbolicLink()) throw new Error('existing release directory is invalid');
    await validateLinks(destination);
    if (await run(process.execPath, [join(destination, 'dist/index.js'), '--version']) !== manifest.version) throw new Error('existing release is damaged');
  } else await rename(candidate, destination);
  pendingLink = join(prefix, `.afk-${process.pid}-${Date.now()}`);
  await symlink(join(destination, 'dist/index.js'), pendingLink);
  checkInterrupted();
  await rename(pendingLink, executable);
  pendingLink = undefined;
  console.log(`AFK ${manifest.version} installed at ${executable}`);

  const shell = (process.env.SHELL ?? '').split('/').pop();
  if (options.completion && ['bash', 'zsh', 'fish'].includes(shell)) {
    const result = spawnSync(executable, ['completion', shell, '--install'], { encoding: 'utf8', timeout: 30_000 });
    if (result.error || result.status !== 0) console.warn('Completion setup skipped; run afk completion --install later.');
    else console.log('Shell completion installed; restart your shell to load it.');
  }
  if (!(process.env.PATH ?? '').split(':').includes(prefix)) console.log(`Add to your shell profile: export PATH=${JSON.stringify(prefix)}:$PATH`);
  else {
    const selected = spawnSync('sh', ['-c', 'command -v afk'], { encoding: 'utf8' }).stdout?.trim();
    if (selected && selected !== executable) console.warn(`Another afk appears first in PATH: ${selected}. Put ${prefix} first.`);
  }
} catch (error) {
  console.error(`Installation failed: ${error.message}`);
  process.exitCode = interruption ? 128 + osConstants.signals[interruption] : 1;
} finally {
  if (pendingLink) await rm(pendingLink, { force: true });
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
NODE
