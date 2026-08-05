import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CACHE_DIR = path.join(os.homedir(), '.afk');
const CACHE_FILE = path.join(CACHE_DIR, 'board-cache.json');

const LIST_TTL_MS = 5 * 60 * 1000;
const DETAIL_TTL_MS = 60 * 1000;

interface ListEntry<T> {
  items: T[];
  hasMore: boolean;
  fetchedAt: number;
}

interface DetailEntry {
  branches: any[];
  tags: any[];
  commits: any[];
  fetchedAt: number;
}

interface CacheShape {
  version: 2;
  backlogs: Record<string, ListEntry<any>>;
  projects: { all: ListEntry<any> | null };
  detail: Record<string, DetailEntry>;
}

const empty = (): CacheShape => ({
  version: 2,
  backlogs: {},
  projects: { all: null },
  detail: {},
});

let mem: CacheShape | null = null;

function load(): CacheShape {
  if (mem) return mem;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      mem = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) as CacheShape;
      if (mem.version !== 2) mem = empty();
      return mem;
    }
  } catch {
    // Corrupted cache — start fresh.
  }
  mem = empty();
  return mem;
}

/** Persist to disk. Best-effort, swallowed errors. */
function flush(): void {
  if (!mem) return;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(mem), 'utf-8');
  } catch {
    // Disk full / read-only — non-fatal.
  }
}

export function readBacklogList(key = 'all'): { items: any[]; hasMore: boolean } | null {
  const c = load();
  const entry = c.backlogs[key];
  if (!entry || Date.now() - entry.fetchedAt > LIST_TTL_MS) return null;
  return { items: entry.items, hasMore: entry.hasMore };
}

export function writeBacklogList(key = 'all', items: any[], hasMore = false): void {
  load();
  if (!mem) return;
  mem.backlogs[key] = { items, hasMore, fetchedAt: Date.now() };
  flush();
}

export function readProjectsList(): { items: any[]; hasMore: boolean } | null {
  const c = load();
  const entry = c.projects.all;
  if (!entry || Date.now() - entry.fetchedAt > LIST_TTL_MS) return null;
  return { items: entry.items, hasMore: entry.hasMore };
}

export function writeProjectsList(items: any[], hasMore: boolean): void {
  load();
  if (!mem) return;
  mem.projects.all = { items, hasMore, fetchedAt: Date.now() };
  flush();
}

export function readDetail(projectId: number): DetailEntry | null {
  const c = load();
  const entry = c.detail[String(projectId)];
  if (!entry || Date.now() - entry.fetchedAt > DETAIL_TTL_MS) return null;
  return entry;
}

export function writeDetail(projectId: number, branches: any[], tags: any[], commits: any[]): void {
  load();
  if (!mem) return;
  mem.detail[String(projectId)] = { branches, tags, commits, fetchedAt: Date.now() };
  flush();
}

export function clearDetailCache(): void {
  load();
  if (!mem) return;
  mem.detail = {};
  flush();
}
