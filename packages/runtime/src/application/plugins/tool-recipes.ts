import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_ASSET_HASHES } from './tool-asset-hashes.js';

export const PLAYWRIGHT_RECIPE_ID = 'browser-check-1.62.1';
export const PLAYWRIGHT_PLUGIN_ID = 'verification.playwright-managed';
export const PLAYWRIGHT_PROVIDER_ID = 'playwright-managed';
export const TOOL_ASSETS = fileURLToPath(new URL('./tool-assets/playwright/', import.meta.url));
const receiptName = '.tool-seal.json';
const sdkRoot = fileURLToPath(new URL('../../../', import.meta.url));
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export interface ToolInstallOptions {
  readonly target: string;
  readonly offline?: boolean;
  readonly signal?: AbortSignal;
}

interface NpmPackage {
  readonly version: string;
  readonly resolved: string;
  readonly integrity: string;
  readonly dependencies?: { readonly [name: string]: string };
  readonly optionalDependencies?: { readonly [name: string]: string };
  readonly os?: readonly string[];
}

interface NpmLock {
  readonly lockfileVersion: number;
  readonly packages: { readonly [path: string]: NpmPackage };
}

export interface ToolSeal {
  readonly recipe: typeof PLAYWRIGHT_RECIPE_ID;
  readonly platform: string;
  readonly architecture: string;
  readonly node: string;
  readonly nodeVersion: string;
  readonly nodeDigest: string;
  readonly tree: string;
  readonly cli: 'node_modules/@playwright/test/cli.js';
}

export function assertToolTarget(recipe: string, options: ToolInstallOptions): void {
  options.signal?.throwIfAborted();
  if (recipe !== PLAYWRIGHT_RECIPE_ID) throw new Error('Unknown approved installation recipe');
  if (options.target !== 'host-local') throw new Error('This recipe supports only an explicit host-local target');
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Recipe platform/architecture unsupported; expected darwin/arm64');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 16)) throw new Error('Managed recipe requires Node >=22.16');
}

async function expectedLock(): Promise<NpmLock> {
  const bytes = await fs.readFile(join(TOOL_ASSETS, 'npm-lock.json'));
  if (digest(bytes) !== TOOL_ASSET_HASHES['package-lock.json']) throw new Error('Trusted recipe lock integrity changed');
  return JSON.parse(bytes.toString()) as NpmLock;
}

export async function prepareToolStage(directory: string, options: ToolInstallOptions): Promise<void> {
  assertToolTarget(PLAYWRIGHT_RECIPE_ID, options);
  const assets = Object.entries(TOOL_ASSET_HASHES).map(([name, hash]) => ({ name, hash, shipped: name === '.npmrc' ? 'npm-config' : name === 'package-lock.json' ? 'npm-lock.json' : name }));
  const names = (await fs.readdir(directory)).sort();
  if (JSON.stringify(names) !== JSON.stringify(assets.map(asset => asset.shipped).sort())) throw new Error('Unexpected recipe package files');
  for (const { name, hash, shipped } of assets) {
    const path = join(directory, shipped);
    if (!(await fs.lstat(path)).isFile() || digest(await fs.readFile(path)) !== hash) throw new Error(`Trusted recipe asset integrity changed: ${name}`);
    if (shipped !== name) await fs.rename(path, join(directory, name));
  }
  const space = await fs.statfs(directory);
  if (space.bavail * space.bsize < 256 * 1024 * 1024) throw new Error('Insufficient installation capacity');
  options.signal?.throwIfAborted();
}

export function toolNpmArguments(existing: readonly string[], options: ToolInstallOptions): string[] {
  return ['ci', ...existing.slice(1), '--registry=https://registry.npmjs.org/', ...(options.offline ? ['--offline'] : [])];
}

export function toolNpmEnvironment(directory: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    HOME: join(dirname(directory), '.npm-home'),
    npm_config_cache: join(dirname(directory), '.npm-cache'),
    npm_config_userconfig: join(directory, '.npmrc'),
    npm_config_globalconfig: '/dev/null', npm_config_ignore_scripts: 'true',
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value) ?? 'undefined';
}

async function validateClosure(directory: string): Promise<void> {
  const lock = await expectedLock();
  for (const [name, hash] of Object.entries(TOOL_ASSET_HASHES)) {
    if (digest(await fs.readFile(join(directory, name))) !== hash) throw new Error(`Recipe asset changed during installation: ${name}`);
  }
  if (digest(await fs.readFile(join(directory, 'package-lock.json'))) !== TOOL_ASSET_HASHES['package-lock.json']) throw new Error('Recipe lock was rewritten');
  const installed = JSON.parse(await fs.readFile(join(directory, 'node_modules', '.package-lock.json'), 'utf8')) as NpmLock;
  const paths = Object.keys(lock.packages).filter(Boolean).sort();
  if (installed.lockfileVersion !== 3 || canonical(Object.keys(installed.packages).sort()) !== canonical(paths)) throw new Error('Installed closure has missing or extra packages');
  for (const path of paths) {
    const expected = lock.packages[path], actual = installed.packages[path];
    for (const key of ['version', 'resolved', 'integrity'] as const) {
      if (actual[key] !== expected[key]) throw new Error(`Installed closure ${key} mismatch: ${path}`);
    }
    const metadata = JSON.parse(await fs.readFile(join(directory, path, 'package.json'), 'utf8')) as { name: string; cpu?: readonly string[] } & NpmPackage;
    if (metadata.name !== path.slice('node_modules/'.length) || metadata.version !== expected.version) throw new Error('Installed package identity/version mismatch');
    if (metadata.cpu && (!Array.isArray(metadata.cpu) || metadata.cpu.includes('!' + process.arch) || (!metadata.cpu.includes(process.arch) && !metadata.cpu.every(cpu => cpu.startsWith('!'))))) throw new Error('Installed package architecture mismatch');
    for (const key of ['dependencies', 'optionalDependencies', 'os'] as const) {
      if (canonical(metadata[key] ?? (key === 'os' ? [] : {})) !== canonical(expected[key] ?? (key === 'os' ? [] : {}))) throw new Error(`Installed dependency/platform mismatch: ${path}`);
    }
  }
  const actualPaths: string[] = [];
  for (const name of await fs.readdir(join(directory, 'node_modules'))) {
    if (name === '.bin' || name === '.package-lock.json') continue;
    if (name.startsWith('@')) {
      for (const child of await fs.readdir(join(directory, 'node_modules', name))) {
        if (name === '@afk' && child === 'runtime') continue;
        actualPaths.push(`node_modules/${name}/${child}`);
      }
    } else actualPaths.push(`node_modules/${name}`);
  }
  if (canonical(actualPaths.sort()) !== canonical(paths)) throw new Error('Unexpected installed package directory');
}

async function treeDigest(directory: string): Promise<string> {
  const root = await fs.realpath(directory);
  const hash = createHash('sha256');
  let files = 0, bytes = 0;
  async function visit(path: string): Promise<void> {
    const name = relative(root, path).split(sep).join('/');
    if (name === receiptName) return;
    if (++files > 40000) throw new Error('Installation closure file limit exceeded');
    const stat = await fs.lstat(path);
    hash.update(JSON.stringify([name, stat.mode & 0o777]));
    if (stat.isSymbolicLink()) {
      const target = await fs.realpath(path);
      if (name === 'node_modules/@afk/runtime' && target === await fs.realpath(sdkRoot)) { hash.update('trusted-product-sdk:' + target); return; }
      if (target !== root && !target.startsWith(root + sep)) throw new Error('Installation symlink escapes managed package');
      hash.update(await fs.readlink(path));
    } else if (stat.isDirectory()) {
      if (name.endsWith('/node_modules')) throw new Error('Unapproved nested package closure');
      for (const child of (await fs.readdir(path)).sort()) await visit(join(path, child));
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > 256 * 1024 * 1024) throw new Error('Installation closure byte limit exceeded');
      hash.update(await fs.readFile(path));
    } else throw new Error('Unsupported installation file type');
  }
  await visit(root);
  return hash.digest('hex');
}

export async function sealToolStage(directory: string, options: ToolInstallOptions): Promise<string> {
  assertToolTarget(PLAYWRIGHT_RECIPE_ID, options);
  await validateClosure(directory);
  const root = await fs.realpath(directory), cli = await fs.realpath(join(directory, 'node_modules/@playwright/test/cli.js'));
  if (!cli.startsWith(root + sep) || !(await fs.stat(cli)).isFile()) throw new Error('Managed CLI is not contained in its installation');
  const node = await fs.realpath(process.execPath);
  const seal: ToolSeal = {
    recipe: PLAYWRIGHT_RECIPE_ID, platform: process.platform, architecture: process.arch,
    node, nodeVersion: process.versions.node, nodeDigest: digest(await fs.readFile(node)),
    tree: await treeDigest(directory), cli: 'node_modules/@playwright/test/cli.js',
  };
  const bytes = JSON.stringify(seal);
  await fs.writeFile(join(directory, receiptName), bytes, { mode: 0o600, flag: 'wx' });
  options.signal?.throwIfAborted();
  return digest(bytes);
}

export async function verifyToolPackage(directory: string, expectedReceipt: string): Promise<ToolSeal> {
  assertToolTarget(PLAYWRIGHT_RECIPE_ID, { target: 'host-local' });
  const bytes = await fs.readFile(join(directory, receiptName));
  if (digest(bytes) !== expectedReceipt) throw new Error('Managed tool receipt integrity mismatch');
  const seal = JSON.parse(bytes.toString()) as ToolSeal;
  if (seal.recipe !== PLAYWRIGHT_RECIPE_ID || seal.platform !== process.platform || seal.architecture !== process.arch || seal.cli !== 'node_modules/@playwright/test/cli.js') throw new Error('Managed tool identity/platform mismatch');
  if (seal.node !== await fs.realpath(process.execPath) || seal.nodeVersion !== process.versions.node || seal.nodeDigest !== digest(await fs.readFile(process.execPath))) throw new Error('Managed Node binding changed; reinstall required');
  await validateClosure(directory);
  if (seal.tree !== await treeDigest(directory)) throw new Error('Managed tool closure seal mismatch');
  const root = await fs.realpath(directory), cli = await fs.realpath(join(directory, seal.cli));
  if (!cli.startsWith(root + sep) || !(await fs.stat(cli)).isFile()) throw new Error('Managed CLI is not contained in its installation');
  return seal;
}

export async function localToolTarget(workspaceRoot: string, target: string): Promise<string> {
  if (!isAbsolute(target) || /^[A-Za-z][A-Za-z+.-]*:\/\//.test(target) || target.includes('\0')) throw new Error('Verification requires a local workspace target');
  const root = await fs.realpath(workspaceRoot), path = await fs.realpath(resolve(target));
  if ((path !== root && !path.startsWith(root + sep)) || !(await fs.stat(path)).isDirectory()) throw new Error('Verification target escapes authorized local workspace');
  return path;
}
