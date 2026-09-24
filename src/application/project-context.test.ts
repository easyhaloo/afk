import { describe, expect, it, vi } from 'vitest';
import { resolveProjectContext } from './project-context';

describe('resolveProjectContext', () => {
  it('resolves a project without changing process cwd', async () => {
    const cwd = process.cwd();
    const resolver = { resolve: vi.fn(async () => '/tmp/target-repo'), clone: vi.fn() };
    const context = await resolveProjectContext({ projectName: 'org/repo', resolver });
    expect(context.repoRoot).toBe('/tmp/target-repo');
    expect(process.cwd()).toBe(cwd);
    expect(resolver.resolve).toHaveBeenCalledWith('org/repo');
  });

  it('uses an explicit repoRoot without invoking the resolver', async () => {
    const resolver = { resolve: vi.fn(), clone: vi.fn() };
    const context = await resolveProjectContext({ repoRoot: '/tmp/explicit', projectName: 'org/repo', resolver });
    expect(context).toMatchObject({ repoRoot: '/tmp/explicit', projectName: 'org/repo' });
    expect(resolver.resolve).not.toHaveBeenCalled();
  });
});
