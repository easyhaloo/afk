import { constants, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CompliancePolicyProvider,
  LicensePolicyProvider,
  SecretScanPolicyProvider,
  nodePolicyFileSystem,
  type ComplianceRule,
  type PolicyFileSystem,
} from './policy.js';

const dirs: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const path = await fs.mkdtemp(join(tmpdir(), prefix));
  dirs.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(path => fs.rm(path, { recursive: true, force: true })));
});

async function write(root: string, relative: string, contents: string): Promise<void> {
  const target = join(root, relative);
  await fs.mkdir(join(target, '..'), { recursive: true });
  await fs.writeFile(target, contents, 'utf8');
}

describe('SecretScanPolicyProvider', () => {
  it('allows a clean tree', async () => {
    const root = await tempRoot('afk-scan-');
    await write(root, 'src/app.ts', 'export const answer = 42;\n');
    const provider = new SecretScanPolicyProvider({ root });
    expect(await provider.evaluate({ action: 'static-review' })).toEqual({ allowed: true, rule: 'secret-scan' });
  });

  it.each([
    ['github-token', 'token = ghp_0123456789abcdefghijklmnopqrstuv\n'],
    ['github-token', 'github_pat_0123456789abcdefghijklmnopq\n'],
    ['aws-access-key', 'key AKIAIOSFODNN7EXAMPLE here\n'],
    ['private-key', '-----BEGIN RSA PRIVATE KEY-----\nabc\n'],
    ['credential-assignment', 'password = "hunter2secretvalue"\n'],
    ['credential-assignment', 'api_key: "0123456789abcdef"\n'],
  ])('denies and reports %s without leaking the value', async (kind, contents) => {
    const root = await tempRoot('afk-scan-');
    await write(root, 'leak.txt', contents);
    const provider = new SecretScanPolicyProvider({ root });
    const decision = await provider.evaluate({ action: 'pre-execution' });
    expect(decision.allowed).toBe(false);
    expect(decision.rule).toBe('secret-scan');
    expect(decision.reason).toContain(kind);
    // The decision never carries the secret text back.
    const secretFragment = contents.trim().split(/[\s=:"']+/).find(part => part.length > 8) ?? '';
    expect(decision.reason).not.toContain(secretFragment);
    expect(decision.reason).not.toContain(contents);
  });

  it('reports which files matched via scan()', async () => {
    const root = await tempRoot('afk-scan-');
    await write(root, 'a.txt', 'nothing here\n');
    await write(root, 'nested/b.txt', 'aws AKIAIOSFODNN7EXAMPLE\n');
    const provider = new SecretScanPolicyProvider({ root });
    const findings = await provider.scan();
    expect(findings).toEqual([{ file: 'nested/b.txt', kind: 'aws-access-key' }]);
  });

  it('scans only the supplied relative files when provided', async () => {
    const root = await tempRoot('afk-scan-');
    await write(root, 'clean.txt', 'ok\n');
    await write(root, 'dirty.txt', 'token = ghp_0123456789abcdefghijklmnopqrstuv\n');
    const provider = new SecretScanPolicyProvider({ root, files: ['clean.txt'] });
    expect((await provider.evaluate({ action: 'static-review' })).allowed).toBe(true);
  });

  it('rejects a supplied file that escapes the root', async () => {
    const root = await tempRoot('afk-scan-');
    const provider = new SecretScanPolicyProvider({ root, files: ['../outside.txt'] });
    await expect(provider.evaluate({ action: 'static-review' })).rejects.toThrow(/escapes the scan root/);
  });

  it('refuses to scan a symlink planted in the root', async () => {
    const root = await tempRoot('afk-scan-');
    const outside = await tempRoot('afk-outside-');
    await fs.writeFile(join(outside, 'target'), 'AKIAIOSFODNN7EXAMPLE\n', 'utf8');
    await fs.symlink(join(outside, 'target'), join(root, 'link.txt'));
    const provider = new SecretScanPolicyProvider({ root });
    await expect(provider.evaluate({ action: 'static-review' })).rejects.toThrow(/symbolic link/);
  });

  it('does not touch the filesystem until evaluate is called', async () => {
    const calls: string[] = [];
    const tracking: PolicyFileSystem = {
      readFile: async path => {
        calls.push('readFile');
        return nodePolicyFileSystem.readFile(path);
      },
      lstat: async path => {
        calls.push('lstat');
        return nodePolicyFileSystem.lstat(path);
      },
      readdir: async path => {
        calls.push('readdir');
        return nodePolicyFileSystem.readdir(path);
      },
      realpath: async path => {
        calls.push('realpath');
        return nodePolicyFileSystem.realpath(path);
      },
      open: async (path, flags) => {
        calls.push('open');
        return nodePolicyFileSystem.open(path, flags);
      },
    };
    const root = await tempRoot('afk-scan-');
    // Constructing with a root that does not even exist must not scan.
    const provider = new SecretScanPolicyProvider({ root: join(root, 'missing'), fs: tracking });
    expect(calls).toEqual([]);
  });

  it('denies an incomplete scan when a file exceeds the size limit', async () => {
    const root = await tempRoot('afk-scan-');
    await write(root, 'big.txt', `x${'A'.repeat(64)}\nAKIAIOSFODNN7EXAMPLE\n`);
    const provider = new SecretScanPolicyProvider({ root, maxFileBytes: 4 });
    const decision = await provider.evaluate({ action: 'static-review' });
    expect(decision.allowed).toBe(false);
    expect(decision.rule).toBe('secret-scan-incomplete');
    expect(decision.reason).toContain('maxFileBytes');
  });

  it('honours cancellation', async () => {
    const root = await tempRoot('afk-scan-');
    await write(root, 'a.txt', 'ok\n');
    const provider = new SecretScanPolicyProvider({ root });
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(provider.evaluate({ action: 'static-review' }, { signal: controller.signal })).rejects.toThrow('stop');
  });

  it('scans with an injected in-memory filesystem', async () => {
    const files = new Map<string, string>([['app.ts', 'const t = "ghp_0123456789abcdefghijklmnopqrstuv";\n']]);
    const mem: PolicyFileSystem = {
      readFile: async path => {
        const entry = [...files.entries()].find(([name]) => path.endsWith(name));
        if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return Buffer.from(entry[1], 'utf8');
      },
      lstat: async path => ({
        isSymbolicLink: () => false,
        isDirectory: () => path === '/virtual',
        isFile: () => path !== '/virtual',
        size: path === '/virtual' ? 0 : (await mem.readFile(path)).length,
        dev: 1,
        ino: path === '/virtual' ? 1 : 2,
      }),
      readdir: async () => [...files.keys()],
      realpath: async path => resolve(path),
      open: async path => {
        const contents = await mem.readFile(path);
        let position = 0;
        return {
          stat: () => mem.lstat(path),
          read: async (buffer, offset, length) => {
            const chunk = contents.subarray(position, position + length);
            buffer.set(chunk, offset);
            position += chunk.length;
            return { bytesRead: chunk.length };
          },
          close: async () => {},
        };
      },
    };
    const provider = new SecretScanPolicyProvider({ root: '/virtual', fs: mem });
    const decision = await provider.evaluate({ action: 'static-review' });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('github-token');
  });
});

describe('SecretScanPolicyProvider worktree boundary', () => {
  it('scans changed files in the application-supplied worktree rather than the original repository', async () => {
    const original = await tempRoot('policy-original-');
    const worktree = await tempRoot('policy-worktree-');
    await write(original, 'src/generated.ts', 'export const value = 1;');
    await write(worktree, 'src/generated.ts', 'const token = "ghp_0123456789abcdefghijklmnopqrstuv";');
    const provider = new SecretScanPolicyProvider({ root: original, files: ['src/generated.ts'] });
    expect((await provider.evaluate({ action: 'static-review' })).allowed).toBe(true);
    const decision = await provider.evaluate({ action: 'post-execution', context: { worktreePath: worktree } });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('github-token');
    expect(decision.reason).not.toContain('ghp_0123456789abcdefghijklmnopqrstuv');
  });

  it('finds new files created after an earlier pre-execution scan', async () => {
    const original = await tempRoot('policy-original-');
    const worktree = await tempRoot('policy-worktree-');
    const provider = new SecretScanPolicyProvider({ root: original });
    const context = { worktreePath: worktree };
    expect((await provider.evaluate({ action: 'pre-execution', context })).allowed).toBe(true);
    await write(worktree, 'new/private.pem', '-----BEGIN PRIVATE KEY-----\nkey-material\n');
    expect((await provider.evaluate({ action: 'post-execution', context })).allowed).toBe(false);
    expect(provider.capabilities['post-execution']).toBe(true);
  });

  it('does not scan the original repository when an explicit worktree is clean', async () => {
    const original = await tempRoot('policy-original-');
    const worktree = await tempRoot('policy-worktree-');
    await write(original, 'secret.txt', 'AKIAIOSFODNN7EXAMPLE');
    await write(worktree, 'clean.txt', 'export const value = 1;');
    const provider = new SecretScanPolicyProvider({ root: original });
    expect((await provider.evaluate({ action: 'static-review', context: { worktreePath: worktree } })).allowed).toBe(true);
  });

  it.each(['', ' ', 'relative/worktree', '../worktree', '/tmp/work\0tree', 42, false])('rejects invalid worktreePath %j without falling back to a clean root', async worktreePath => {
    const root = await tempRoot('policy-original-');
    const provider = new SecretScanPolicyProvider({ root });
    await expect(provider.evaluate({ action: 'static-review', context: { worktreePath } })).rejects.toThrow(/scan root|worktree/i);
  });

  it('rejects a missing worktree and a worktree path pointing to a regular file', async () => {
    const root = await tempRoot('policy-original-');
    await write(root, 'file.txt', 'clean');
    const provider = new SecretScanPolicyProvider({ root });
    await expect(provider.evaluate({ action: 'static-review', context: { worktreePath: join(root, 'missing') } })).rejects.toThrow();
    await expect(provider.evaluate({ action: 'static-review', context: { worktreePath: join(root, 'file.txt') } })).rejects.toThrow(/directory/);
  });

  it('rejects a symlink used as the worktree root', async () => {
    const root = await tempRoot('policy-original-');
    const worktree = await tempRoot('policy-worktree-');
    const parent = await tempRoot('policy-links-');
    await fs.symlink(worktree, join(parent, 'linked'));
    const provider = new SecretScanPolicyProvider({ root });
    await expect(provider.evaluate({ action: 'static-review', context: { worktreePath: join(parent, 'linked') } })).rejects.toThrow(/symbolic link/);
  });

  it('rejects a symlink in the parent path of an explicitly selected file', async () => {
    const root = await tempRoot('policy-worktree-');
    const outside = await tempRoot('policy-outside-');
    await write(outside, 'clean.txt', 'clean');
    await fs.symlink(outside, join(root, 'linked'));
    const provider = new SecretScanPolicyProvider({ root, files: ['linked/clean.txt'] });
    await expect(provider.evaluate({ action: 'static-review' })).rejects.toThrow(/symbolic link/);
  });

  it.each([NaN, Infinity, -1, 1.5])('rejects an invalid maxFileBytes %s', maxFileBytes => {
    expect(() => new SecretScanPolicyProvider({ root: '/unused', maxFileBytes })).toThrow(/maxFileBytes/);
  });

  it('does not read oversized files and scan() also rejects instead of silently skipping', async () => {
    const root = await tempRoot('policy-worktree-');
    await write(root, 'large.txt', 'a'.repeat(100));
    const open = vi.fn(nodePolicyFileSystem.open);
    const provider = new SecretScanPolicyProvider({ root, maxFileBytes: 4, fs: { ...nodePolicyFileSystem, open } });
    expect((await provider.evaluate({ action: 'post-execution' })).allowed).toBe(false);
    await expect(provider.scan()).rejects.toThrow(/maxFileBytes/);
    expect(open).not.toHaveBeenCalled();
  });

  it('accepts an empty file at a zero-byte limit and denies nonempty files', async () => {
    const root = await tempRoot('policy-worktree-');
    await write(root, 'empty.txt', '');
    const provider = new SecretScanPolicyProvider({ root, maxFileBytes: 0 });
    expect((await provider.evaluate({ action: 'static-review' })).allowed).toBe(true);
    await write(root, 'empty.txt', 'x');
    expect((await provider.evaluate({ action: 'static-review' })).allowed).toBe(false);
  });

  it('denies if a file grows beyond maxFileBytes during bounded reading and closes the handle', async () => {
    const root = await tempRoot('policy-worktree-');
    await write(root, 'growing.txt', 'x');
    let closed = false;
    const adapter: PolicyFileSystem = {
      ...nodePolicyFileSystem,
      open: async (path, flags) => {
        expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
        const handle = await nodePolicyFileSystem.open(path, flags);
        let appended = false;
        return {
          stat: () => handle.stat(),
          read: async (buffer, offset, length, position) => {
            if (!appended) {
              await fs.appendFile(path, 'y'.repeat(20));
              appended = true;
            }
            return handle.read(buffer, offset, length, position);
          },
          close: async () => { closed = true; await handle.close(); },
        };
      },
    };
    const decision = await new SecretScanPolicyProvider({ root, maxFileBytes: 4, fs: adapter }).evaluate({ action: 'static-review' });
    expect(decision).toMatchObject({ allowed: false, rule: 'secret-scan-incomplete' });
    expect(closed).toBe(true);
  });

  it('refuses a leaf symlink introduced between validation and opening', async () => {
    const root = await tempRoot('policy-worktree-');
    const outside = await tempRoot('policy-outside-');
    await write(root, 'file.txt', 'clean');
    await write(outside, 'other.txt', 'clean');
    const adapter: PolicyFileSystem = {
      ...nodePolicyFileSystem,
      open: async (path, flags) => {
        await fs.unlink(path);
        await fs.symlink(join(outside, 'other.txt'), path);
        return nodePolicyFileSystem.open(path, flags);
      },
    };
    const provider = new SecretScanPolicyProvider({ root, fs: adapter });
    await expect(provider.evaluate({ action: 'static-review' })).rejects.toThrow();
  });

  it('refuses a parent directory replaced with a symlink during open before reading any bytes', async () => {
    const root = await tempRoot('policy-worktree-');
    const outside = await tempRoot('policy-outside-');
    await write(root, 'src/file.txt', 'clean');
    await write(outside, 'file.txt', 'clean');
    const read = vi.fn();
    let closed = false;
    const adapter: PolicyFileSystem = {
      ...nodePolicyFileSystem,
      open: async (path, flags) => {
        await fs.rename(join(root, 'src'), join(root, 'original-src'));
        await fs.symlink(outside, join(root, 'src'));
        const handle = await nodePolicyFileSystem.open(path, flags);
        return {
          stat: () => handle.stat(),
          read: async (buffer, offset, length, position) => {
            read();
            return handle.read(buffer, offset, length, position);
          },
          close: async () => { closed = true; await handle.close(); },
        };
      },
    };
    const provider = new SecretScanPolicyProvider({ root, files: ['src/file.txt'], fs: adapter });
    await expect(provider.evaluate({ action: 'static-review' })).rejects.toThrow(/symbolic link/);
    expect(read).not.toHaveBeenCalled();
    expect(closed).toBe(true);
  });

  it('honours cancellation during a read and always closes its file handle', async () => {
    const root = await tempRoot('policy-worktree-');
    await write(root, 'file.txt', 'clean');
    const controller = new AbortController();
    let closed = false;
    const adapter: PolicyFileSystem = {
      ...nodePolicyFileSystem,
      open: async (path, flags) => {
        const handle = await nodePolicyFileSystem.open(path, flags);
        return {
          stat: () => handle.stat(),
          read: async (buffer, offset, length, position) => {
            const result = await handle.read(buffer, offset, length, position);
            controller.abort(new Error('cancel scan'));
            return result;
          },
          close: async () => { closed = true; await handle.close(); },
        };
      },
    };
    const provider = new SecretScanPolicyProvider({ root, fs: adapter });
    await expect(provider.evaluate({ action: 'post-execution' }, { signal: controller.signal })).rejects.toThrow('cancel scan');
    expect(closed).toBe(true);
  });

  it('does not let a directory selected through files[] silently count as a completed scan', async () => {
    const root = await tempRoot('policy-worktree-');
    await write(root, 'src/secret.txt', 'AKIAIOSFODNN7EXAMPLE');
    const decision = await new SecretScanPolicyProvider({ root, files: ['src'] }).evaluate({ action: 'static-review' });
    expect(decision).toMatchObject({ allowed: false, rule: 'secret-scan-incomplete' });
  });

  it('does not change the configured root during concurrent worktree evaluations', async () => {
    const original = await tempRoot('policy-original-');
    const dirty = await tempRoot('policy-dirty-');
    const clean = await tempRoot('policy-clean-');
    await write(dirty, 'secret.txt', 'AKIAIOSFODNN7EXAMPLE');
    const provider = new SecretScanPolicyProvider({ root: original });
    const [denied, allowed] = await Promise.all([
      provider.evaluate({ action: 'post-execution', context: { worktreePath: dirty } }),
      provider.evaluate({ action: 'post-execution', context: { worktreePath: clean } }),
    ]);
    expect(denied.allowed).toBe(false);
    expect(allowed.allowed).toBe(true);
    expect((await provider.evaluate({ action: 'static-review' })).allowed).toBe(true);
  });
});

describe('LicensePolicyProvider', () => {
  const provider = () => new LicensePolicyProvider({ allowlist: ['MIT', 'Apache-2.0'] });

  it('allows a simple allowlisted license', async () => {
    expect(await provider().evaluate({ action: 'static-review', context: { license: 'MIT' } })).toEqual({
      allowed: true,
      rule: 'license-allowlist',
    });
  });

  it('denies a license outside the allowlist', async () => {
    const decision = await provider().evaluate({ action: 'static-review', context: { license: 'GPL-3.0-only' } });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('GPL-3.0-only');
  });

  it('allows a compound OR when one side is allowlisted', async () => {
    const decision = await provider().evaluate({
      action: 'static-review',
      context: { license: 'GPL-3.0-only OR MIT' },
    });
    expect(decision.allowed).toBe(true);
  });

  it('denies a compound OR when neither side is allowlisted', async () => {
    const decision = await provider().evaluate({
      action: 'static-review',
      context: { license: 'GPL-3.0-only OR AGPL-3.0-only' },
    });
    expect(decision.allowed).toBe(false);
  });

  it('allows a compound AND only when both sides are allowlisted', async () => {
    const good = await provider().evaluate({
      action: 'static-review',
      context: { license: 'MIT AND Apache-2.0' },
    });
    expect(good.allowed).toBe(true);
    const bad = await provider().evaluate({
      action: 'static-review',
      context: { license: 'MIT AND GPL-3.0-only' },
    });
    expect(bad.allowed).toBe(false);
  });

  it('handles parentheses precedence', async () => {
    const decision = await provider().evaluate({
      action: 'static-review',
      context: { license: '(GPL-3.0-only OR MIT) AND Apache-2.0' },
    });
    expect(decision.allowed).toBe(true);
  });

  it('fails closed on an unsupported compound (exception clause)', async () => {
    const decision = await provider().evaluate({
      action: 'static-review',
      context: { license: 'GPL-2.0 WITH Classpath-exception-2.0' },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('unsupported license expression');
  });

  it('fails closed on malformed expressions', async () => {
    for (const malformed of ['MIT AND', '(MIT OR Apache-2.0', 'MIT OR OR Apache-2.0']) {
      const decision = await provider().evaluate({ action: 'static-review', context: { license: malformed } });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('unsupported license expression');
    }
  });

  it('evaluates constructor-supplied manifest licenses when context omits one', async () => {
    const allow = new LicensePolicyProvider({ allowlist: ['MIT'], licenses: ['MIT'] });
    expect((await allow.evaluate({ action: 'static-review' })).allowed).toBe(true);
    const deny = new LicensePolicyProvider({ allowlist: ['MIT'], licenses: ['GPL-3.0-only'] });
    expect((await deny.evaluate({ action: 'static-review' })).allowed).toBe(false);
  });

  it('prefers the context license over constructor licenses', async () => {
    const mixed = new LicensePolicyProvider({ allowlist: ['MIT'], licenses: ['GPL-3.0-only'] });
    expect((await mixed.evaluate({ action: 'static-review', context: { license: 'MIT' } })).allowed).toBe(true);
  });

  it('denies when no license is supplied at all', async () => {
    const decision = await new LicensePolicyProvider({ allowlist: ['MIT'] }).evaluate({ action: 'static-review' });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('no package license supplied');
  });

  it('honours cancellation', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(
      provider().evaluate({ action: 'static-review', context: { license: 'MIT' } }, { signal: controller.signal }),
    ).rejects.toThrow('stop');
  });
});

describe('CompliancePolicyProvider', () => {
  const rules: ComplianceRule[] = [
    { id: 'allow-deploy-prod', effect: 'allow', actions: ['deploy'], when: context => context.env === 'prod', reason: 'prod deploy approved' },
    { id: 'deny-force-push', effect: 'deny', actions: ['push'], reason: 'force push is forbidden' },
  ];

  it('allows an action that a rule permits', async () => {
    const decision = await new CompliancePolicyProvider({ rules }).evaluate({
      action: 'deploy',
      context: { env: 'prod' },
    });
    expect(decision).toEqual({ allowed: true, rule: 'allow-deploy-prod', reason: 'prod deploy approved' });
  });

  it('applies deny precedence over an allow', async () => {
    const both: ComplianceRule[] = [
      { id: 'allow-all', effect: 'allow', actions: ['*'] },
      { id: 'deny-push', effect: 'deny', actions: ['push'] },
    ];
    const decision = await new CompliancePolicyProvider({ rules: both }).evaluate({ action: 'push' });
    expect(decision.allowed).toBe(false);
    expect(decision.rule).toBe('deny-push');
  });

  it('defaults to deny when no rule matches', async () => {
    const decision = await new CompliancePolicyProvider({ rules }).evaluate({ action: 'unknown' });
    expect(decision.allowed).toBe(false);
    expect(decision.rule).toBe('default-deny');
  });

  it('defaults to deny when a matching rule has no effect on context', async () => {
    const decision = await new CompliancePolicyProvider({ rules }).evaluate({
      action: 'deploy',
      context: { env: 'dev' },
    });
    expect(decision.allowed).toBe(false);
  });

  it('honours an explicit defaultEffect of allow', async () => {
    const provider = new CompliancePolicyProvider({ rules: [], defaultEffect: 'allow' });
    expect((await provider.evaluate({ action: 'anything' })).allowed).toBe(true);
  });

  it('matches a wildcard action', async () => {
    const provider = new CompliancePolicyProvider({ rules: [{ id: 'deny-all', effect: 'deny', actions: ['*'] }] });
    const decision = await provider.evaluate({ action: 'whatever' });
    expect(decision.allowed).toBe(false);
    expect(decision.rule).toBe('deny-all');
  });

  it('is not a placeholder that always passes', async () => {
    const provider = new CompliancePolicyProvider({ rules });
    const denied = await provider.evaluate({ action: 'push' });
    expect(denied.allowed).toBe(false);
  });

  it('honours cancellation', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(
      new CompliancePolicyProvider({ rules }).evaluate({ action: 'deploy' }, { signal: controller.signal }),
    ).rejects.toThrow('stop');
  });
});
