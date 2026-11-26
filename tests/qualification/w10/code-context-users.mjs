import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, chownSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [archiveArg, checksumArg, installerArg, expectedVersion] = process.argv.slice(2);
const [archive, checksum, installer] = [archiveArg, checksumArg, installerArg].map(path => resolve(path));
assert.equal(process.platform, 'linux');
assert.equal(process.getuid(), 0);
assert.match(expectedVersion, /^\d+\.\d+\.\d+$/);
const root = mkdtempSync(join(tmpdir(), 'w10-context-users-'));
chmodSync(root, 0o711);

const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const execute = (program, args, options) => {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 30000, ...options });
  assert.ifError(result.error);
  return result;
};
const success = result => {
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

try {
  const install = join(root, 'install');
  mkdirSync(install, { mode: 0o755 });
  // The two accounts share executable bytes, with separate profiles and private workspaces.
  const executable = join(install, 'bin', 'afk');
  success(execute('bash', [installer, '--skip-completion', '--archive', archive, '--checksum', checksum,
    '--version', expectedVersion, '--prefix', join(install, 'bin')], {
    cwd: install, env: { PATH: process.env.PATH, HOME: install, AFK_HOME: join(install, 'store') },
  }));
  const read = { prompt: 'widget', limit: 10 };
  const accounts = [10001, 10002].map(uid => {
    const home = join(root, `home-${uid}`);
    const workspace = join(root, `workspace-${uid}`);
    for (const path of [home, workspace]) {
      mkdirSync(path, { mode: 0o700 });
      chownSync(path, uid, uid);
    }
    const content = `export const widget = "${randomBytes(12).toString('hex')}";`;
    const file = join(workspace, 'widget.ts');
    writeFileSync(file, content, { mode: 0o600 });
    chownSync(file, uid, uid);
    const call = (program, args) => execute('setpriv', ['--no-new-privs', `--reuid=${uid}`, `--regid=${uid}`,
      '--clear-groups', program, ...args], {
      cwd: workspace, env: { PATH: process.env.PATH, HOME: home, AFK_HOME: join(home, '.afk'),
        AFK_WORKSPACE_ROOT: join(home, 'workspaces') },
    });
    const cli = (...args) => call(executable, args);
    const input = (name, value) => {
      const path = join(home, `${name}.json`);
      writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
      chownSync(path, uid, uid);
      return path;
    };
    const gather = scope => cli('plugin', 'invoke', 'context.provider', 'context.code', 'gather', '--input',
      input('query', { ...read, scope }), '--json');
    return { uid, workspace, content, file, call, cli, input, gather };
  });
  const refused = (result, expectedError) => {
    assert.equal(result.status, 1);
    const output = result.stderr + result.stdout;
    assert.match(output, expectedError);
    for (const account of accounts) assert.ok(!output.includes(account.content));
  };
  const checks = accounts.map((current, index) => {
    const other = accounts[1 - index];
    const { call, cli, gather, input, uid, workspace, content } = current;
    assert.equal(success(call('id', ['-u'])), String(uid));
    assert.equal(success(call('id', ['-G'])), String(uid));
    assert.equal(success(cli('--version')), expectedVersion);
    const expected = [{ origin: 'widget.ts', content, score: 1 }];
    assert.deepEqual(JSON.parse(success(gather('widget.ts'))), expected);
    refused(gather(`../workspace-${other.uid}/widget.ts`), /Context path escapes root/);
    refused(gather(other.file), /Context path escapes root/);
    symlinkSync(other.file, join(workspace, 'linked.ts'));
    refused(gather('linked.ts'), /Context path contains a symbolic link/);
    assert.deepEqual(JSON.parse(success(gather('.'))), expected);
    assert.notEqual(call('cat', [other.file]).status, 0);
    success(cli('plugin', 'configure', 'context.code', '--builtin', '--file', input('root', { root: other.workspace })));
    refused(gather('widget.ts'), /EACCES|permission denied/i);
    success(cli('plugin', 'configure', 'context.code', '--builtin', '--file', input('root', { root: workspace })));
    assert.deepEqual(JSON.parse(success(gather('widget.ts'))), expected);
    return { uid, groups: [uid], ownerRead: true, relativeCrossRootRejected: true, absoluteCrossRootRejected: true,
      linkedFileRejected: true, directoryScanExcludesLink: true, osCrossReadDenied: true,
      configuredForeignRootDenied: true, ownerReadRestored: true };
  });
  console.log(JSON.stringify({ version: expectedVersion, platform: `${process.platform}-${process.arch}`,
    archiveSha256: sha256(archive), separateProfileAndWorkspacePerUid: true, checks }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
