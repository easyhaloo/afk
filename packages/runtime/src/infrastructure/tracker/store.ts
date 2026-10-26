import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { workspaceStateDirectory } from '../workspace.js';

/**
 * Tracker store — the local record of the provider projects AFK has worked
 * with.
 *
 * AFK writes this file whenever it reaches a provider: listing a backlog,
 * showing one issue, running one task, taking an inventory. The record links
 * a provider project to the local directories it was reached from and to the
 * issues it contains. A later command can therefore resolve a bare issue id
 * to its project, or a working directory to its project, without the user
 * having to remember or configure either one.
 *
 * The store is a local index, not a source of truth: provider state always
 * comes from the provider. A missing or unreadable store degrades to "no
 * association known" and never fails a command.
 */

/** Provider platforms AFK can address. */
export type TrackerPlatform = 'github' | 'gitlab';

/** One issue AFK has seen in a provider project. */
export interface TrackerIssueRecord {
  title?: string;
  seenAt: string;
}

/** One provider project AFK has worked with. */
export interface TrackerProjectRecord {
  platform: TrackerPlatform;
  /** Provider project key, for example `owner/repo` or `group/sub/project`. */
  project: string;
  /** Provider instance host, for example `gitlab.company.com`. */
  host?: string;
  /** Local directories this project was reached from. */
  paths: string[];
  /** Known issues, keyed by their provider issue number. */
  issues: Record<string, TrackerIssueRecord>;
  updatedAt: string;
}

export interface TrackerStore {
  version: number;
  projects: Record<string, TrackerProjectRecord>;
}

/** What a command learned about a provider project. */
export interface TrackerActivity {
  platform: TrackerPlatform;
  project: string;
  host?: string;
  /** Directory the command ran in. Its repository root is recorded when there is one. */
  cwd?: string;
  /** Issues the command touched. */
  issues?: Array<{ id: string; title?: string }>;
}

const STORE_VERSION = 1;
const MAX_ISSUES_PER_PROJECT = 500;
const MAX_PATHS_PER_PROJECT = 20;

/** An untyped JSON object, narrowed from `unknown`. */
type UnknownObject = { [key: string]: unknown };

/**
 * The file that holds the local tracker index.
 *
 * The index is shared across execution workspaces in `~/.afk/tracker-projects.json`.
 */
export function trackerStorePath(directory?: string): string {
  return join(directory ?? workspaceStateDirectory(), 'tracker-projects.json');
}

/** Read the local tracker index. A missing or damaged file reads as empty. */
export function readTrackerStore(directory?: string): TrackerStore {
  const path = trackerStorePath(directory);
  if (!existsSync(path)) return { version: STORE_VERSION, projects: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.projects)) return { version: STORE_VERSION, projects: {} };
    const projects: Record<string, TrackerProjectRecord> = {};
    for (const [key, value] of Object.entries(parsed.projects)) {
      if (!isRecord(value)) continue;
      const platform = value.platform === 'github' || value.platform === 'gitlab' ? value.platform : undefined;
      const project = typeof value.project === 'string' ? value.project : undefined;
      if (!platform || !project) continue;
      projects[key] = {
        platform,
        project,
        host: typeof value.host === 'string' ? value.host : undefined,
        paths: Array.isArray(value.paths) ? value.paths.filter((entry): entry is string => typeof entry === 'string') : [],
        issues: isRecord(value.issues) ? value.issues as Record<string, TrackerIssueRecord> : {},
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
      };
    }
    return { version: STORE_VERSION, projects };
  } catch {
    // A damaged index is a cache miss, never a command failure.
    return { version: STORE_VERSION, projects: {} };
  }
}

/**
 * Record what a command learned about a provider project.
 *
 * The write is best effort: a failure here must never break the command that
 * produced the knowledge.
 */
export function recordTrackerActivity(activity: TrackerActivity, directory?: string): void {
  try {
    const store = readTrackerStore(directory);
    const key = projectKey(activity.platform, activity.project, activity.host);
    const existing = store.projects[key];
    const seenAt = new Date().toISOString();
    const record: TrackerProjectRecord = existing
      ? { ...existing, host: activity.host ?? existing.host, updatedAt: seenAt }
      : {
        platform: activity.platform,
        project: activity.project,
        host: activity.host,
        paths: [],
        issues: {},
        updatedAt: seenAt,
      };
    const path = repositoryRoot(activity.cwd);
    if (path && !record.paths.includes(path)) {
      record.paths = [path, ...record.paths].slice(0, MAX_PATHS_PER_PROJECT);
    }
    for (const issue of activity.issues ?? []) {
      if (!issue.id) continue;
      record.issues[issue.id] = { title: issue.title, seenAt };
    }
    record.issues = capIssues(record.issues);
    store.projects[key] = record;
    writeTrackerStore(store, directory);
  } catch {
    // The index is an optimisation; losing a write is not worth failing over.
  }
}

/**
 * Find the project that owns an issue id.
 *
 * When several projects carry the same issue id, the project that owns the
 * working directory wins; otherwise the most recently updated project wins.
 */
export function findProjectByIssue(
  store: TrackerStore,
  issueId: string,
  cwd?: string,
): TrackerProjectRecord | undefined {
  const owners = Object.values(store.projects).filter(record => record.issues[issueId]);
  if (owners.length === 0) return undefined;
  const local = cwd ? findProjectByPath(store, cwd) : undefined;
  if (local && owners.includes(local)) return local;
  return owners.reduce((latest, record) => (record.updatedAt > latest.updatedAt ? record : latest));
}

/** Find the project that owns a working directory. */
export function findProjectByPath(store: TrackerStore, cwd: string): TrackerProjectRecord | undefined {
  const target = resolve(cwd);
  let match: TrackerProjectRecord | undefined;
  let matchedLength = -1;
  for (const record of Object.values(store.projects)) {
    for (const path of record.paths) {
      if (!isInside(path, target)) continue;
      if (path.length > matchedLength) {
        match = record;
        matchedLength = path.length;
      }
    }
  }
  return match;
}

/**
 * Find the recorded project with this project key.
 *
 * The key alone does not name a platform, so a record is matched by its
 * project name and its recorded platform is adopted.
 */
export function findProjectByName(store: TrackerStore, project: string): TrackerProjectRecord | undefined {
  return Object.values(store.projects).find(record => record.project === project);
}

/** The identity of a provider project inside the store. */
export function projectKey(platform: TrackerPlatform, project: string, host?: string): string {
  return `${platform}:${host ?? ''}:${project}`;
}

/**
 * The tracker identity of a provider project reference.
 *
 * A GitLab project key carries its instance host (`git.corp/team/api`); the
 * tracker addresses the project by path, so the host is split off.
 */
export function trackerIdentityOf(reference: {
  platform: TrackerPlatform;
  projectKey: string;
  providerHost?: string;
}): { project: string; host?: string } {
  const host = reference.providerHost;
  const prefix = host ? `${host}/` : '';
  const project = host && reference.projectKey.startsWith(prefix)
    ? reference.projectKey.slice(prefix.length)
    : reference.projectKey;
  return { project, host };
}

function writeTrackerStore(store: TrackerStore, directory?: string): void {
  const path = trackerStorePath(directory);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = join(dirname(path), `.tracker-projects-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(store)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may already be gone.
    }
    throw error;
  }
}

function capIssues(issues: Record<string, TrackerIssueRecord>): Record<string, TrackerIssueRecord> {
  const entries = Object.entries(issues);
  if (entries.length <= MAX_ISSUES_PER_PROJECT) return issues;
  entries.sort((left, right) => (left[1].seenAt < right[1].seenAt ? -1 : 1));
  return Object.fromEntries(entries.slice(entries.length - MAX_ISSUES_PER_PROJECT));
}

/**
 * The repository root that owns a directory.
 *
 * Only repository roots are recorded: they are stable, meaningful anchors for
 * "where this project lives", unlike the directory a command happened to run
 * in.
 */
function repositoryRoot(cwd?: string): string | undefined {
  if (!cwd) return undefined;
  let directory = resolve(cwd);
  for (;;) {
    if (existsSync(join(directory, '.git'))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function isInside(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === '' || (!relation.startsWith('..') && !relation.startsWith('/'));
}

function isRecord(value: unknown): value is UnknownObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
