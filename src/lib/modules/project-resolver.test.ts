import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted to the top of the file by Vitest, before any
// variable declarations. vi.hoisted gives us a place to create values the
// factory can reference.
const { chdirMock } = vi.hoisted(() => ({ chdirMock: vi.fn() }));

vi.mock('process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('process')>();
  return { ...actual, chdir: chdirMock };
});

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
    chdirMock.mockReset();
  });

  it('is a no-op when no projectName is set', async () => {
    const resolver = makeResolver();
    const mod = new ProjectResolverModule(resolver);

    await mod.onInit(initCtx({ projectName: undefined }));

    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(resolver.clone).not.toHaveBeenCalled();
    expect(chdirMock).not.toHaveBeenCalled();
  });

  it('chdirs to the resolved path on onInit', async () => {
    const resolver = makeResolver({ resolve: vi.fn(async () => '/fake/resolved') });
    const mod = new ProjectResolverModule(resolver);

    await mod.onInit(initCtx());

    expect(resolver.resolve).toHaveBeenCalledWith('easyhaloo/faker_agent');
    expect(chdirMock).toHaveBeenCalledWith('/fake/resolved');
  });

  it('falls back to clone when resolve fails', async () => {
    const resolver = makeResolver({
      resolve: vi.fn(async () => { throw new Error('not found'); }),
      clone: vi.fn(async () => '/fake/cloned'),
    });
    const mod = new ProjectResolverModule(resolver);

    await mod.onInit(initCtx());

    expect(resolver.clone).toHaveBeenCalledWith('easyhaloo/faker_agent');
    expect(chdirMock).toHaveBeenCalledWith('/fake/cloned');
  });

  it('restores originalCwd on onCleanup', async () => {
    const resolver = makeResolver({ resolve: vi.fn(async () => '/fake/resolved') });
    const mod = new ProjectResolverModule(resolver);

    await mod.onInit(initCtx({ originalCwd: '/start' }));
    expect(chdirMock).toHaveBeenCalledWith('/fake/resolved');

    chdirMock.mockClear();
    await mod.onCleanup(cleanCtx);
    expect(chdirMock).toHaveBeenCalledWith('/start');
  });

  it('onCleanup is a no-op when onInit never ran', async () => {
    const mod = new ProjectResolverModule(makeResolver());
    await expect(mod.onCleanup(cleanCtx)).resolves.not.toThrow();
    expect(chdirMock).not.toHaveBeenCalled();
  });
});