import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertNoBundledAgent } from './package-cli-validation.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(root, 'apps/cli/package.json'), 'utf8'));
let output = join(root, 'release/cli');
let version = manifest.version;
const args = process.argv.slice(2);
while (args.length) {
  const flag = args.shift();
  if (flag === '--help') {
    console.log('Usage: pnpm release:cli [--output DIR] [--version VERSION]\nBuild, package production dependencies, and verify an offline installation.');
    process.exit(0);
  }
  const value = args.shift();
  if (!['--output', '--version'].includes(flag) || !value || value.startsWith('--')) throw new Error(`invalid argument: ${flag}`);
  if (flag === '--output') output = resolve(value);
  else version = value;
}
if (!/^\d+\.\d+\.\d+$/.test(version) || version !== manifest.version) throw new Error('release version must match apps/cli/package.json');
if (!['darwin', 'linux'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) throw new Error('supported targets: macOS/Linux x64/arm64; build on the target platform');
if (process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime) throw new Error('Linux releases require glibc');

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, { cwd: root, encoding: 'utf8', timeout: 600_000, maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} ${arguments_.join(' ')} failed: ${result.error?.message ?? result.stderr?.trim() ?? result.signal ?? result.status}`);
  return result.stdout?.trim();
}

/**
 * Agent CLIs are resolved from PATH at runtime (see packages/runtime/src/domain/agents/*),
 * never bundled. A packaged agent binary is both huge (~236MB) and a licensing problem,
 * so treat it as a hard release failure rather than a size warning.
 */
const MAX_ARCHIVE_BYTES = 40 * 1024 * 1024;
const DEVELOPMENT_ARTIFACT = [/\.d\.ts$/, /\.d\.mts$/, /\.d\.cts$/, /\.map$/];

async function walk(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries.map(entry => ({ entry, path: join(entry.parentPath ?? entry.path, entry.name) }));
}

/** Strip type declarations and source maps: runtime-irrelevant, and `.map` files carry `sourcesContent`. */
async function pruneDevelopmentArtifacts(directory) {
  let removed = 0;
  let bytes = 0;
  for (const { entry, path } of await walk(directory)) {
    if (!entry.isFile() || !DEVELOPMENT_ARTIFACT.some(pattern => pattern.test(entry.name))) continue;
    bytes += (await stat(path)).size;
    await rm(path, { force: true });
    removed += 1;
  }
  console.log(`Pruned ${removed} development artifacts (${(bytes / 1024 / 1024).toFixed(1)}MB).`);
}

/**
 * `pnpm deploy --legacy` additionally materializes `.pnpm/@/`, a mirror where the scope was
 * parsed as an empty string and every package is stored a second time. Nothing symlinks into
 * it and `.modules.yaml` never mentions it, so it is dead weight — but only remove it once
 * every entry is proven to have a real counterpart in the store.
 */
async function pruneDuplicateScopeMirror(directory) {
  const store = join(directory, 'node_modules/.pnpm');
  const mirror = join(store, '@');
  if (!(await stat(mirror).catch(() => undefined))) return;
  const storeEntries = await readdir(store);
  const orphans = [];
  for (const name of await readdir(mirror)) {
    for (const version of await readdir(join(mirror, name))) {
      const expected = `${name}@${version}`;
      if (!storeEntries.some(entry => entry === expected || entry.startsWith(`${expected}_`))) orphans.push(expected);
    }
  }
  if (orphans.length) throw new Error(`.pnpm/@ mirror entries have no counterpart in the store: ${orphans.join(', ')}`);
  let bytes = 0;
  for (const { entry, path } of await walk(mirror)) {
    if (entry.isFile()) bytes += (await stat(path)).size;
  }
  await rm(mirror, { recursive: true, force: true });
  console.log(`Removed duplicate .pnpm/@ mirror (${(bytes / 1024 / 1024).toFixed(1)}MB).`);
}

const temporary = await mkdtemp(join(tmpdir(), 'afk-release-'));
try {
  console.log(`Building AFK ${version} for ${process.platform}/${process.arch}...`);
  run('pnpm', ['--filter', 'afk...', 'build'], { stdio: 'inherit' });
  const states = await Promise.all(['.modules.yaml', '.pnpm-workspace-state-v1.json'].map(async name => {
    const file = join(root, 'node_modules', name);
    const contents = await readFile(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return { file, contents };
  }));
  try {
    run('pnpm', ['--filter', 'afk', 'deploy', '--legacy', '--prod', '--ignore-scripts', '--config.hoist=false', '--config.force=false', join(temporary, 'afk')], { stdio: 'inherit' });
  } finally {
    for (const { file, contents } of states) {
      if (contents) await writeFile(file, contents);
      else await rm(file, { force: true });
    }
  }
  await assertNoBundledAgent(join(temporary, 'afk'));
  await pruneDuplicateScopeMirror(join(temporary, 'afk'));
  await pruneDevelopmentArtifacts(join(temporary, 'afk'));
  await writeFile(join(temporary, 'afk/release.json'), JSON.stringify({ version, platform: process.platform, arch: process.arch, nodeMinimum: '22.16.0' }) + '\n');
  const asset = `afk-${process.platform}-${process.arch}.tar.gz`;
  const archive = join(temporary, asset);
  run('tar', ['-czf', archive, '-C', temporary, 'afk'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const archiveSize = (await stat(archive)).size;
  if (archiveSize > MAX_ARCHIVE_BYTES) {
    throw new Error(`release archive is ${(archiveSize / 1024 / 1024).toFixed(1)}MB, over the ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB budget`);
  }
  console.log(`Archive size: ${(archiveSize / 1024 / 1024).toFixed(1)}MB.`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  const checksum = `${archive}.sha256`;
  await writeFile(checksum, `${hash.digest('hex')}  ${asset}\n`);

  const home = join(temporary, 'home');
  const tools = join(temporary, 'tools');
  await mkdir(home);
  await mkdir(tools);
  for (const tool of ['pnpm', 'npm', 'tsc']) {
    await writeFile(join(tools, tool), '#!/bin/sh\necho "Installation invoked a build tool" >&2\nexit 99\n');
    await chmod(join(tools, tool), 0o755);
  }
  const env = { ...process.env, HOME: home, PATH: `${tools}:${process.env.PATH}`, AFK_HOME: join(home, '.afk'), AFK_WORKSPACE_ROOT: join(home, '.loop-workspace') };
  const installer = join(temporary, 'install.sh');
  await copyFile(join(root, 'install.sh'), installer);
  console.log('Verifying standalone installation outside the repository...');
  run('bash', [installer, '--skip-completion', '--archive', archive, '--checksum', checksum, '--version', version], { cwd: temporary, env, stdio: 'inherit' });
  const executable = join(home, '.local/bin/afk');
  if (run(executable, ['--version'], { cwd: home, env }) !== version) throw new Error('installed CLI version mismatch');
  run(executable, ['--help'], { cwd: home, env });
  const { COMMANDS } = await import(pathToFileURL(join(temporary, 'afk/dist/command-registry.js')).href);
  for (const command of COMMANDS.flatMap(entry => entry.names)) run(executable, [command, '--help'], { cwd: home, env });

  await mkdir(output, { recursive: true });
  for (const file of [asset, `${asset}.sha256`, 'install.sh']) await copyFile(join(temporary, file), join(output, file));
  console.log(`Verified ${COMMANDS.flatMap(entry => entry.names).length} command entry points. Release artifacts: ${output}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
