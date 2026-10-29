import { execFileSync } from 'node:child_process';
import { lstat, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { Command } from 'commander';
import { readFileSync } from 'node:fs';

const REPOSITORY = 'easyhaloo/afk';
const RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const RAW_BASE = `https://raw.githubusercontent.com/${REPOSITORY}`;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

interface LatestRelease {
  version: string;
  tag: string;
}

interface PackageMetadata {
  version: string;
}

function currentVersion(): string {
  const metadata = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as PackageMetadata;
  if (!VERSION_PATTERN.test(metadata.version)) throw new Error(`Invalid installed AFK version: ${metadata.version}`);
  return metadata.version;
}

export function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export function parseLatestRelease(payload: unknown): LatestRelease {
  if (!payload || typeof payload !== 'object' || !('tag_name' in payload)) {
    throw new Error('GitHub latest-release response is missing tag_name');
  }
  const tag = (payload as { tag_name?: unknown }).tag_name;
  if (typeof tag !== 'string' || !tag.startsWith('cli-v')) {
    throw new Error('Latest GitHub release is not an AFK CLI release');
  }
  const version = tag.slice('cli-v'.length);
  if (!VERSION_PATTERN.test(version)) throw new Error(`Invalid AFK CLI release tag: ${tag}`);
  return { version, tag };
}

async function getLatestRelease(fetchImpl: typeof fetch = fetch): Promise<LatestRelease> {
  const response = await fetchImpl(RELEASE_API, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'afk-cli-updater' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Unable to check AFK updates: GitHub returned HTTP ${response.status}`);
  return parseLatestRelease(await response.json());
}

async function findManagedInstallPrefix(): Promise<string> {
  const storage = resolve(homedir(), '.afk/cli/versions');
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const executable = join(directory, 'afk');
    try {
      const stat = await lstat(executable);
      if (!stat.isSymbolicLink()) continue;
      const target = await realpath(executable);
      if (target.startsWith(`${storage}/`) && target.endsWith('/dist/index.js')) return directory;
      // Keep the link target explicit so a managed install cannot be confused with an unrelated binary.
      await readlink(executable);
    } catch {
      // Continue scanning PATH entries that do not contain a managed AFK installation.
    }
  }
  throw new Error(
    'Self-update is supported for AFK releases installed by install.sh. ' +
    'This executable is not linked from ~/.afk/cli/versions; reinstall with the official installer first.',
  );
}

async function installVersion(version: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const prefix = await findManagedInstallPrefix();
  const installerUrl = `${RAW_BASE}/cli-v${version}/install.sh`;
  const response = await fetchImpl(installerUrl, {
    headers: { 'user-agent': 'afk-cli-updater' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Unable to download the installer for AFK ${version} (HTTP ${response.status})`);
  const installer = await response.text();
  if (!installer.startsWith('#!/usr/bin/env bash') || !installer.includes('AFK CLI installer')) {
    throw new Error('Downloaded AFK installer did not pass its basic integrity check');
  }
  process.stdout.write(`Updating AFK ${currentVersion()} → ${version}...\n`);
  const output = execFileSync('bash', ['-s', '--', '--version', version, '--prefix', prefix, '--skip-completion'], {
    encoding: 'utf8',
    input: installer,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10 * 60 * 1000,
    env: process.env,
  });
  if (output.trim()) process.stdout.write(`${output.trim()}\n`);
}

export function registerUpdateCommand(program: Command): void {
  program.command('update')
    .description('Check for and install a newer AFK CLI release')
    .option('--check', 'Check the latest version without installing it')
    .action(async (options: { check?: boolean }) => {
      const installed = currentVersion();
      const latest = await getLatestRelease();
      if (compareVersions(latest.version, installed) <= 0) {
        console.log(`AFK ${installed} is up to date.`);
        return;
      }
      if (options.check) {
        console.log(`AFK ${latest.version} is available (installed: ${installed}). Run ` + '`afk update`' + ' to install it.');
        return;
      }
      await installVersion(latest.version);
    });
}
