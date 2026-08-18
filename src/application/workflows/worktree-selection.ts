export function shouldReusePrimaryWorktree(branch: unknown): boolean {
  return branch === undefined
    || (typeof branch === 'object'
      && branch !== null
      && (branch as { type?: unknown; iid?: unknown }).type === 'issue'
      && (branch as { iid?: unknown }).iid === 0);
}
