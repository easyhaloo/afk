import { resolveRemoteTarget, type RemoteTrackerTarget } from './resolver.js';
import {
  findProjectByIssue,
  findProjectByName,
  findProjectByPath,
  readTrackerStore,
  type TrackerPlatform,
  type TrackerProjectRecord,
  type TrackerStore,
} from './store.js';

/**
 * Tracker target resolution.
 *
 * A tracker target is the (platform, project) pair that names the provider
 * project AFK talks to. The project is chosen by the first source that names
 * one:
 *
 *   1. explicit command-line flag (`--project`)
 *   2. the local tracker index, by issue id — AFK wrote that association when
 *      it last worked with the issue
 *   3. the local tracker index, by working directory
 *   4. the `AFK_TRACKER_PROJECT` environment variable
 *   5. the `origin` remote of the working directory
 *
 * The platform follows the project: the flag wins, then the platform recorded
 * next to the project, then `AFK_TRACKER_PLATFORM`, then the shape of the
 * project key, then the git remote, then the configured credentials.
 *
 * The git remote is therefore optional. Commands that only inspect provider
 * state — `afk backlog show`, `afk backlog list` — work from any directory
 * once the target is known, instead of failing with a platform detection
 * error.
 */

export type { TrackerPlatform } from './store.js';

/** Where a resolved half of the target came from. */
export type TrackerTargetSource =
  | 'flag'
  | 'env'
  | 'remote'
  | 'inferred'
  | 'index'
  | 'index-path';

/** Credential availability, used to disambiguate a two-segment project key. */
export interface TrackerTargetCredentials {
  github: boolean;
  gitlab: boolean;
}

export interface TrackerTargetOptions {
  /** Explicit provider project from the command line. */
  project?: string;
  /** Explicit provider platform from the command line. */
  platform?: string;
  /** Issue the command addresses, used to look the project up in the local index. */
  issueId?: string;
  /** Directory used for index and git remote detection. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Environment used for the `AFK_TRACKER_*` fallbacks. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /**
   * Lazy credential probe. It runs only when the platform has to be inferred
   * from the project key, so a plain git-backed command never shells out.
   */
  credentials?: () => TrackerTargetCredentials;
  /** Local tracker index override. Defaults to the index read from disk. */
  store?: TrackerStore;
  /** Directory that holds the local tracker index. Defaults to the workspace. */
  trackerDirectory?: string;
}

export interface TrackerTarget {
  platform: TrackerPlatform;
  projectId: string;
  /** Provider instance host, when the project lives on a named instance. */
  host?: string;
  platformSource: TrackerTargetSource;
  projectSource: TrackerTargetSource;
}

const NO_TARGET_MESSAGE =
  'A tracker project must be resolved before the provider can be created. '
  + 'Run inside a git repository that has an origin remote, pass --project and --platform, '
  + 'or set AFK_TRACKER_PROJECT in the environment.';

/**
 * Resolve the tracker target for one command invocation.
 *
 * @throws when neither a project nor a platform can be determined.
 */
export async function resolveTrackerTarget(options: TrackerTargetOptions = {}): Promise<TrackerTarget> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const flagProject = trimmed(options.project);
  const flagPlatform = asTrackerPlatform(options.platform);
  const envProject = trimmed(env.AFK_TRACKER_PROJECT);
  const envPlatform = asTrackerPlatform(env.AFK_TRACKER_PLATFORM);

  // A fully explicit target never touches git: the caller already named both
  // halves, so there is nothing left to detect.
  if (flagProject && flagPlatform) {
    return {
      platform: flagPlatform,
      projectId: flagProject,
      platformSource: 'flag',
      projectSource: 'flag',
    };
  }

  const store = options.store ?? readTrackerStore(options.trackerDirectory);
  let selection = selectProject({ store, cwd, flagProject, envProject, issueId: trimmed(options.issueId) });
  if (!selection) {
    const remote = await resolveRemoteTarget(cwd);
    if (!remote) throw new Error(NO_TARGET_MESSAGE);
    selection = { projectId: remote.projectId, platform: remote.platform, host: remote.host, source: 'remote' };
  }
  const remote = selection.source === 'remote' ? null : await resolveRemoteTarget(cwd);
  const platform = selectPlatform({
    selection,
    flagPlatform,
    envPlatform,
    remote,
    credentials: options.credentials,
  });

  return {
    platform: platform.platform,
    projectId: selection.projectId,
    host: selection.host,
    platformSource: platform.source,
    projectSource: selection.source,
  };
}

/**
 * Guess the platform from a project key.
 *
 * A numeric key is a GitLab project ID and a key with three or more path
 * segments is a GitLab namespace path; GitHub repositories are always exactly
 * `owner/repo`. A two-segment key is ambiguous, so it follows the available
 * credentials: GitLab wins only when GitHub is not configured at all.
 */
export function inferPlatformFromProject(
  projectId: string,
  credentials: TrackerTargetCredentials = { github: false, gitlab: false },
): TrackerPlatform {
  return decisivePlatformFromProject(projectId)
    ?? (credentials.gitlab && !credentials.github ? 'gitlab' : 'github');
}

/** Parse a platform string, ignoring anything that is not github/gitlab. */
export function asTrackerPlatform(value: unknown): TrackerPlatform | undefined {
  return value === 'github' || value === 'gitlab' ? value : undefined;
}

interface ProjectSelection {
  projectId: string;
  source: TrackerTargetSource;
  platform?: TrackerPlatform;
  host?: string;
}

function selectProject(input: {
  store: TrackerStore;
  cwd: string;
  flagProject?: string;
  envProject?: string;
  issueId?: string;
}): ProjectSelection | undefined {
  const { store, cwd, flagProject, envProject, issueId } = input;

  if (flagProject) {
    const known = findProjectByName(store, flagProject);
    return {
      projectId: flagProject,
      platform: known?.platform,
      host: known?.host,
      source: 'flag',
    };
  }
  if (issueId) {
    const byIssue = findProjectByIssue(store, issueId, cwd);
    if (byIssue) {
      return {
        projectId: byIssue.project,
        platform: byIssue.platform,
        host: byIssue.host,
        source: 'index',
      };
    }
  }
  const byPath = findProjectByPath(store, cwd);
  if (byPath) {
    return {
      projectId: byPath.project,
      platform: byPath.platform,
      host: byPath.host,
      source: 'index-path',
    };
  }
  if (envProject) {
    const known = findProjectByName(store, envProject);
    return {
      projectId: envProject,
      platform: known?.platform,
      host: known?.host,
      source: 'env',
    };
  }
  return undefined;
}

function selectPlatform(input: {
  selection: ProjectSelection;
  flagPlatform?: TrackerPlatform;
  envPlatform?: TrackerPlatform;
  remote?: RemoteTrackerTarget | null;
  credentials?: () => TrackerTargetCredentials;
}): { platform: TrackerPlatform; source: TrackerTargetSource } {
  const { selection, flagPlatform, envPlatform, remote, credentials } = input;
  if (flagPlatform) return { platform: flagPlatform, source: 'flag' };
  if (selection.platform) return { platform: selection.platform, source: selection.source };
  if (envPlatform) return { platform: envPlatform, source: 'env' };
  const decisive = decisivePlatformFromProject(selection.projectId);
  if (decisive) return { platform: decisive, source: 'inferred' };
  if (remote && remote.projectId !== selection.projectId) {
    return { platform: remote.platform, source: 'remote' };
  }
  return {
    platform: inferPlatformFromProject(selection.projectId, credentials?.() ?? { github: false, gitlab: false }),
    source: 'inferred',
  };
}

/** The platform a project key determines on its own, if it determines one. */
function decisivePlatformFromProject(projectId: string): TrackerPlatform | undefined {
  if (/^\d+$/.test(projectId)) return 'gitlab';
  const segments = projectId.split('/').filter(Boolean);
  return segments.length >= 3 ? 'gitlab' : undefined;
}

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

export type { TrackerProjectRecord };
