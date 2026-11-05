import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { workspaceStateDirectory } from '../workspace.js';
import { openSqlite, transaction, type SqliteDatabase } from '../storage/sqlite.js';

/**
 * Tracker store — the local record of the provider projects AFK has worked
 * with.
 *
 * AFK writes this store whenever it reaches a provider: listing a backlog,
 * showing one issue, running one task, taking an inventory. The record links
 * a provider project to the local directories it was reached from and to the
 * issues it contains. A later command can therefore resolve a bare issue id
 * to its project, or a working directory to its project, without the user
 * having to remember or configure either one.
 *
 * The store is a local index, not a source of truth: provider state always
 * comes from the provider. A missing or unreadable store degrades to "no
 * association known" and never fails a command.
 *
 * It lives in `~/.afk/storage/tracker.sqlite`. It used to be a JSON file at
 * the state root, rewritten in full on every write — which lost entries
 * whenever two processes recorded an activity at the same time. One SQLite
 * database with UPSERTs replaces that read-modify-write; the JSON file is
 * imported once and renamed, and is read as a fallback for one release.
 */

/** Provider platforms AFK can address. */
export type TrackerPlatform = 'github' | 'gitlab';

/** One issue AFK has seen in a provider project. */
export interface TrackerIssueRecord {
  /** When the issue was last seen. Titles are provider data and are not cached here. */
  seenAt: string;
}

/** One provider project AFK has worked with. */
export interface TrackerProjectRecord {
  platform: TrackerPlatform;
  /** Provider project key, for example `owner/repo` or `group/sub/project`. */
  project: string;
  /** Provider instance host, for example `gitlab.company.com`. */
  host?: string;
  /** Local directories this project was reached from, most recent first. */
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
  /** Issues the command touched. The title is accepted but not cached. */
  issues?: Array<{ id: string; title?: string }>;
}

const STORE_VERSION = 1;
const MAX_ISSUES_PER_PROJECT = 500;
const MAX_PATHS_PER_PROJECT = 20;
const LEGACY_STORE_FILENAME = 'tracker-projects.json';

const TRACKER_SCHEMA = `
CREATE TABLE tracker_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  legacy_imported_at_ms INTEGER
) STRICT;

CREATE TABLE tracker_projects (
  platform TEXT NOT NULL CHECK (platform IN ('github', 'gitlab')),
  host TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  PRIMARY KEY (platform, host, project)
) STRICT;

CREATE TABLE tracker_paths (
  platform TEXT NOT NULL,
  host TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL,
  path TEXT NOT NULL,
  rank INTEGER NOT NULL CHECK (rank >= 0),
  PRIMARY KEY (platform, host, project, path),
  FOREIGN KEY (platform, host, project) REFERENCES tracker_projects(platform, host, project) ON DELETE CASCADE
) STRICT;

CREATE TABLE tracker_issues (
  platform TEXT NOT NULL,
  host TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  seen_at_ms INTEGER NOT NULL CHECK (seen_at_ms >= 0),
  PRIMARY KEY (platform, host, project, issue_id),
  FOREIGN KEY (platform, host, project) REFERENCES tracker_projects(platform, host, project) ON DELETE CASCADE
) STRICT;
`;

/** An untyped JSON object, narrowed from `unknown`. */
type UnknownObject = { [key: string]: unknown };

/** The database holding the local tracker index, under the state directory. */
export function trackerDatabasePath(directory?: string): string {
  return join(directory ?? workspaceStateDirectory(), 'storage', 'tracker.sqlite');
}

/** Where the retired JSON index lived, for the one-release import and fallback. */
function legacyTrackerStorePath(directory?: string): string {
  return join(directory ?? workspaceStateDirectory(), LEGACY_STORE_FILENAME);
}

function openTrackerDatabase(directory?: string): SqliteDatabase {
  const stateDirectory = directory ?? workspaceStateDirectory();
  return openSqlite({
    file: trackerDatabasePath(stateDirectory),
    schema: TRACKER_SCHEMA,
    initialize: database => importLegacyStore(database, stateDirectory),
  });
}

/**
 * Read the local tracker index. A missing or damaged store reads as empty.
 *
 * An unreadable database falls back to the retired JSON file so an upgrade
 * keeps resolving projects even if the import could not run.
 */
export function readTrackerStore(directory?: string): TrackerStore {
  const store = readDatabaseStore(directory);
  if (Object.keys(store.projects).length > 0) return store;
  return readLegacyTrackerStore(legacyTrackerStorePath(directory)) ?? store;
}

function readDatabaseStore(directory?: string): TrackerStore {
  let database: SqliteDatabase | undefined;
  try {
    database = openTrackerDatabase(directory);
    return assembleStore(database);
  } catch {
    return { version: STORE_VERSION, projects: {} };
  } finally {
    database?.close();
  }
}

function assembleStore(database: SqliteDatabase): TrackerStore {
  const projects: Record<string, TrackerProjectRecord> = {};
  const rows = database.prepare('SELECT platform, host, project, updated_at_ms FROM tracker_projects ORDER BY platform, host, project').all();
  for (const row of rows) {
    const platform = row.platform === 'github' || row.platform === 'gitlab' ? row.platform : undefined;
    if (!platform) continue;
    const host = String(row.host ?? '');
    const project = String(row.project ?? '');
    const key = projectKey(platform, project, host === '' ? undefined : host);
    projects[key] = {
      platform,
      project,
      ...(host === '' ? {} : { host }),
      paths: [],
      issues: {},
      updatedAt: new Date(Number(row.updated_at_ms)).toISOString(),
    };
  }
  if (rows.length === 0) return { version: STORE_VERSION, projects };
  for (const row of database.prepare('SELECT platform, host, project, path FROM tracker_paths ORDER BY platform, host, project, rank').all()) {
    const key = projectKey(row.platform as TrackerPlatform, String(row.project), String(row.host ?? '') || undefined);
    const record = projects[key];
    record?.paths.push(String(row.path));
  }
  for (const row of database.prepare('SELECT platform, host, project, issue_id, seen_at_ms FROM tracker_issues ORDER BY platform, host, project, seen_at_ms').all()) {
    const key = projectKey(row.platform as TrackerPlatform, String(row.project), String(row.host ?? '') || undefined);
    const record = projects[key];
    if (record) record.issues[String(row.issue_id)] = { seenAt: new Date(Number(row.seen_at_ms)).toISOString() };
  }
  return { version: STORE_VERSION, projects };
}

/**
 * Record what a command learned about a provider project.
 *
 * One transaction of UPSERTs replaces the read-modify-write the JSON file
 * needed, so two loops recording at the same time both land. The write is
 * best effort: a failure here must never break the command that produced the
 * knowledge.
 */
export function recordTrackerActivity(activity: TrackerActivity, directory?: string): void {
  let opened: SqliteDatabase | undefined;
  try {
    const host = activity.host ?? '';
    const seenAt = Date.now();
    const repository = repositoryRoot(activity.cwd);
    opened = openTrackerDatabase(directory);
    const database = opened;
    transaction(database, () => {
      database.prepare(`INSERT INTO tracker_projects (platform, host, project, updated_at_ms) VALUES (?, ?, ?, ?)
        ON CONFLICT(platform, host, project) DO UPDATE SET updated_at_ms = excluded.updated_at_ms`)
        .run(activity.platform, host, activity.project, seenAt);
      if (repository) recordPath(database, activity.platform, host, activity.project, repository);
      for (const issue of activity.issues ?? []) {
        if (!issue.id) continue;
        database.prepare(`INSERT INTO tracker_issues (platform, host, project, issue_id, seen_at_ms) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(platform, host, project, issue_id) DO UPDATE SET seen_at_ms = excluded.seen_at_ms`)
          .run(activity.platform, host, activity.project, issue.id, seenAt);
      }
      database.prepare(`DELETE FROM tracker_issues WHERE platform = ? AND host = ? AND project = ? AND issue_id NOT IN (
        SELECT issue_id FROM tracker_issues WHERE platform = ? AND host = ? AND project = ? ORDER BY seen_at_ms DESC LIMIT ?)`)
        .run(activity.platform, host, activity.project, activity.platform, host, activity.project, MAX_ISSUES_PER_PROJECT);
    });
  } catch {
    // The index is an optimisation; losing a write is not worth failing over.
  } finally {
    opened?.close();
  }
}

/** Move a path to the front of the project's list and drop the tail past the cap. */
function recordPath(database: SqliteDatabase, platform: string, host: string, project: string, path: string): void {
  database.prepare('DELETE FROM tracker_paths WHERE platform = ? AND host = ? AND project = ? AND path = ?').run(platform, host, project, path);
  database.prepare('UPDATE tracker_paths SET rank = rank + 1 WHERE platform = ? AND host = ? AND project = ?').run(platform, host, project);
  database.prepare('INSERT INTO tracker_paths (platform, host, project, path, rank) VALUES (?, ?, ?, ?, 0)').run(platform, host, project, path);
  database.prepare('DELETE FROM tracker_paths WHERE platform = ? AND host = ? AND project = ? AND rank >= ?')
    .run(platform, host, project, MAX_PATHS_PER_PROJECT);
}

/**
 * Import the retired JSON index once, then get out of the way.
 *
 * Runs inside the schema transaction, so a failed import leaves neither rows
 * nor a renamed file. The rename is what stops the next version from reading
 * two sources; the file itself is kept, because it is the only copy of the
 * history if the import turns out wrong.
 */
function importLegacyStore(database: SqliteDatabase, stateDirectory: string): void {
  const migrated = database.prepare('SELECT legacy_imported_at_ms FROM tracker_meta WHERE singleton = 1').get();
  if (migrated) return;
  const legacyPath = join(stateDirectory, LEGACY_STORE_FILENAME);
  try {
    if (existsSync(legacyPath)) {
      const legacy = readLegacyTrackerStore(legacyPath);
      for (const record of Object.values(legacy?.projects ?? {})) {
        const host = record.host ?? '';
        database.prepare(`INSERT OR IGNORE INTO tracker_projects (platform, host, project, updated_at_ms) VALUES (?, ?, ?, ?)`)
          .run(record.platform, host, record.project, Date.parse(record.updatedAt) || Date.now());
        record.paths.slice().reverse().forEach((path, rank) => {
          database.prepare('INSERT OR IGNORE INTO tracker_paths (platform, host, project, path, rank) VALUES (?, ?, ?, ?, ?)')
            .run(record.platform, host, record.project, path, rank);
        });
        for (const [issueId, issue] of Object.entries(record.issues)) {
          database.prepare('INSERT OR IGNORE INTO tracker_issues (platform, host, project, issue_id, seen_at_ms) VALUES (?, ?, ?, ?, ?)')
            .run(record.platform, host, record.project, issueId, Date.parse(issue.seenAt) || Date.now());
        }
      }
      renameSync(legacyPath, migratedPath(legacyPath));
    }
  } catch {
    // A damaged or unrenamable legacy file must not block opening the store.
  }
  database.prepare('INSERT INTO tracker_meta (singleton, legacy_imported_at_ms) VALUES (1, ?)').run(Date.now());
}

function migratedPath(legacyPath: string): string {
  const candidate = `${legacyPath}.migrated-${new Date().toISOString().slice(0, 10)}`;
  return existsSync(candidate) ? `${candidate}-${Date.now()}` : candidate;
}

/** Read the retired JSON index, matching what the previous implementation accepted. */
function readLegacyTrackerStore(path: string): TrackerStore | undefined {
  if (!existsSync(path)) return undefined;
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
    const parent = join(directory, '..');
    if (parent === directory) return undefined;
    directory = resolve(parent);
  }
}

function isInside(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === '' || (!relation.startsWith('..') && !relation.startsWith('/'));
}

function isRecord(value: unknown): value is UnknownObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
