import { resolve as resolvePath } from 'path';
import { JumpProjectResolver, type ProjectResolver } from './project-resolver';

/** Immutable repository identity carried through a workflow run. */
export interface ProjectContext {
  readonly repoRoot: string;
  readonly projectName?: string;
  readonly originalCwd: string;
}

export interface ResolveProjectContextOptions {
  repoRoot?: string;
  projectName?: string;
  cwd?: string;
  resolver?: ProjectResolver;
}

/**
 * Resolve repository identity without changing process.cwd(). The explicit
 * path wins, then a named project is resolved/cloned, and finally cwd is used.
 */
export async function resolveProjectContext(options: ResolveProjectContextOptions = {}): Promise<ProjectContext> {
  const originalCwd = options.cwd ?? process.cwd();
  let repoRoot = options.repoRoot;

  if (!repoRoot && options.projectName) {
    const resolver = options.resolver ?? new JumpProjectResolver();
    try {
      repoRoot = await resolver.resolve(options.projectName);
    } catch (error) {
      repoRoot = await resolver.clone(options.projectName);
      void error;
    }
  }

  return {
    repoRoot: resolvePath(repoRoot ?? originalCwd),
    projectName: options.projectName,
    originalCwd,
  };
}
