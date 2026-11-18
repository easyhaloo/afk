import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FilesystemClaimLock } from '../../domain/backlog/claim.js';

export async function executionOwnershipKeys(workspaceRoot: string, repositories: readonly { platform: string; projectKey: string }[] = []): Promise<string[]> {
  const canonicalRoot = await realpath(workspaceRoot).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return resolve(workspaceRoot);
  });
  const identities = [`workspaces/${canonicalRoot}`, ...repositories.filter(repository => repository.platform && repository.projectKey)
    .map(repository => `repositories/${repository.platform === 'github' ? `${repository.platform}:${repository.projectKey}`.toLowerCase() : `${repository.platform}:${repository.projectKey}`}`)];
  return [...new Set(identities)].map(identity => `owned-executions/retained/${createHash('sha256').update(identity).digest('hex')}`).sort();
}

export async function assertWorkspaceOwnershipAvailable(workspaceRoot: string, repositories: readonly { platform: string; projectKey: string }[], ownershipClaims: readonly string[] = []): Promise<void> {
  const lock = new FilesystemClaimLock();
  for (const key of await executionOwnershipKeys(workspaceRoot, repositories)) {
    const held = await lock.inspect(key);
    if (held && !ownershipClaims.includes(held.claimId)) throw new Error(`workspace or repository is quarantined by an unclosed owned execution: ${workspaceRoot}`);
  }
}

export async function withWorkspaceOwnershipAvailable<Result>(workspaceRoot: string,
  repositories: readonly { platform: string; projectKey: string }[], operation: () => Promise<Result>): Promise<Result> {
  const lock = new FilesystemClaimLock();
  const keys = await executionOwnershipKeys(workspaceRoot, repositories);
  const enter = async (index: number): Promise<Result> => {
    if (index === keys.length) return operation();
    return lock.withExclusiveOperation(keys[index], async () => {
      if (await lock.inspect(keys[index])) throw new Error(`workspace or repository is quarantined by an unclosed owned execution: ${workspaceRoot}`);
      return enter(index + 1);
    });
  };
  return enter(0);
}
