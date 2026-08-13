import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted to the top of the file by Vitest, before any
// variable declarations. vi.hoisted gives us a place to create values the
// factory can reference.
import { ProjectResolverModule } from './project-resolver';
import type { InitContext, LifecycleContext } from '../workflows/lifecycle';
import type { ProjectResolver } from '../core/project-resolver';

function makeResolver(over: Partial<ProjectResolver> = {}): ProjectResolver {
  return {
    resolve: vi.fn(async () => '/fake/resolved'),
    clone: vi.fn(async () => '/fake/cloned'),
    ...over,
  };
}

const initCtx = (over: Partial<InitContext> = {}): InitContext => ({
  iid: 42,
  projectName: 'easyhaloo/faker_agent',
  baseBranch: 'main',
  params: {},
  originalCwd: '/start',
  ...over,
});

const cleanCtx: LifecycleContext = {
  iid: 42,
  worktreePath: '',
  baseBranch: 'main',
  sessionName: '',
  params: {},
};

describe('ProjectResolverModule', () => {
  beforeEach(() => {
  });

  it('is a no-op when no projectName is set', async () => {
    const resolver = makeResolver();
    const mod = new ProjectResolverModule(resolver);

    await mod.onInit(initCtx({ projectName: undefined }));

    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(resolver.clone).not.toHaveBeenCalled();
  });

  it('writes the resolved path into context without changing cwd', async () => {
    const resolver = makeResolver({ resolve: vi.fn(async () => '/fake/resolved') });
    const mod = new ProjectResolverModule(resolver);

    const ctx = initCtx();
    const cwd = process.cwd();
    await mod.onInit(ctx);

    expect(resolver.resolve).toHaveBeenCalledWith('easyhaloo/faker_agent');
    expect(ctx.repoRoot).toBe('/fake/resolved');
    expect(process.cwd()).toBe(cwd);
  });

  it('falls back to clone when resolve fails', async () => {
    const resolver = makeResolver({
      resolve: vi.fn(async () => { throw new Error('not found'); }),
      clone: vi.fn(async () => '/fake/cloned'),
    });
    const mod = new ProjectResolverModule(resolver);

    const ctx = initCtx();
    await mod.onInit(ctx);

    expect(resolver.clone).toHaveBeenCalledWith('easyhaloo/faker_agent');
    expect(ctx.repoRoot).toBe('/fake/cloned');
  });

  it('does not mutate process cwd during cleanup', async () => {
    const resolver = makeResolver({ resolve: vi.fn(async () => '/fake/resolved') });
    const mod = new ProjectResolverModule(resolver);

    const cwd = process.cwd();
    await mod.onInit(initCtx({ originalCwd: '/start' }));
    await mod.onCleanup(cleanCtx);
    expect(process.cwd()).toBe(cwd);
  });

  it('onCleanup is a no-op when onInit never ran', async () => {
    const mod = new ProjectResolverModule(makeResolver());
    await expect(mod.onCleanup(cleanCtx)).resolves.not.toThrow();
  });
});
