/**
 * File-based session store — persists provider-native SessionSnapshots to
 * <worktree>/.afk/sessions/<run-id>.json with atomic write (temp + rename)
 * and sha256 checksum verification on load.
 *
 * Layout (one file per run):
 *   <worktree>/.afk/sessions/
 *     ├── <run-id>.json         <- snapshot + meta
 *     └── <run-id>.json.sha256  <- checksum sidecar
 *
 * Atomic write: write to `<run-id>.json.tmp` then `rename` to the final path.
 * On POSIX `rename(2)` is atomic, so a concurrent reader sees either the
 * previous version or the new version — never a half-written file. This is
 * the design-doc requirement ("避免新 generation 读取半截 JSONL").
 *
 * Corruption detection: load() re-computes the sha256 of the file content
 * and compares with the sidecar. Mismatch → SessionCorruptError so the runner
 * can fall back to the handoff Markdown without aborting the phase.
 */

import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import type { SessionSnapshot } from '../../domain/agents/types';
import type {
  SessionStore,
  SessionSaveOptions,
  SessionSaveResult,
  SessionLoadOptions,
  SessionListOptions,
  SessionStoreEntry,
} from './types';
import { SessionCorruptError, SessionNotFoundError } from './types';

const SESSIONS_DIR = '.afk/sessions';

/** On-disk envelope. Versioned so future migrations are explicit. */
interface Envelope {
  version: 1;
  runId: string;
  provider: string;
  /** ISO timestamp of capture. */
  capturedAt: string;
  /** Hex sha256 of `snapshot` (json-stringified canonically). */
  checksum: string;
  snapshot: SessionSnapshot;
}

export class FileSessionStore implements SessionStore {
  readonly name = 'file';
  readonly priority = 10; // higher than handoff-store (50) — native wins

  constructor(private readonly worktreePath: string) {}

  supportsProvider(_provider: string): boolean {
    // FileSessionStore is provider-agnostic: any snapshot can be JSON-encoded.
    return true;
  }

  /** Compute sha256 of canonical JSON for `snapshot`. Stable across runs. */
  static checksumOf(snapshot: SessionSnapshot): string {
    // Sort keys for stable hashing: snapshot has heterogeneous fields, but
    // json.stringify with sorted keys is enough for a check fingerprint.
    const canonical = JSON.stringify(snapshot, Object.keys(snapshot).sort());
    return createHash('sha256').update(canonical).digest('hex');
  }

  private filePath(runId: string): string {
    return join(this.worktreePath, SESSIONS_DIR, `${runId}.json`);
  }

  private checksumPath(runId: string): string {
    return join(this.worktreePath, SESSIONS_DIR, `${runId}.json.sha256`);
  }

  async save(options: SessionSaveOptions): Promise<SessionSaveResult> {
    const dir = join(this.worktreePath, SESSIONS_DIR);
    await fs.mkdir(dir, { recursive: true });

    const checksum = FileSessionStore.checksumOf(options.snapshot);
    const envelope: Envelope = {
      version: 1,
      runId: options.runId,
      provider: options.provider,
      capturedAt: options.snapshot.capturedAt,
      checksum,
      snapshot: options.snapshot,
    };

    const finalPath = this.filePath(options.runId);
    const tmpPath = `${finalPath}.tmp`;
    const sidecar = this.checksumPath(options.runId);
    const sidecarTmp = `${sidecar}.tmp`;

    const serialized = JSON.stringify(envelope, null, 2);
    await fs.writeFile(tmpPath, serialized, 'utf-8');
    await fs.writeFile(sidecarTmp, checksum, 'utf-8');

    // Atomic rename: temp -> final on both files.
    await fs.rename(tmpPath, finalPath);
    await fs.rename(sidecarTmp, sidecar);

    return { path: finalPath, checksum, provider: options.provider };
  }

  async load(options: SessionLoadOptions): Promise<SessionSnapshot> {
    const filePath = this.filePath(options.runId);
    const sidecar = this.checksumPath(options.runId);

    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SessionNotFoundError(options.runId);
      }
      throw err;
    }

    let expected: string | undefined;
    try {
      expected = (await fs.readFile(sidecar, 'utf-8')).trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // Sidecar missing — accept file content as-is (legacy / pre-checksum era).
    }

    let envelope: Envelope;
    try {
      envelope = JSON.parse(raw) as Envelope;
    } catch (err) {
      throw new SessionCorruptError(`invalid JSON: ${(err as Error).message}`, this.name, err);
    }
    if (envelope.version !== 1) {
      throw new SessionCorruptError(`unsupported version ${envelope.version}`, this.name);
    }
    if (typeof envelope.snapshot !== 'object' || envelope.snapshot === null) {
      throw new SessionCorruptError('envelope missing snapshot', this.name);
    }

    // Verify checksum if a sidecar exists.
    if (expected !== undefined) {
      const actual = FileSessionStore.checksumOf(envelope.snapshot);
      if (actual !== expected) {
        throw new SessionCorruptError(
          `checksum mismatch (expected ${expected}, got ${actual})`,
          this.name,
        );
      }
    }

    // Caller-provided expected checksum wins (e.g., roundtrip test).
    if (options.expectedChecksum && envelope.checksum !== options.expectedChecksum) {
      throw new SessionCorruptError(
        `expected checksum ${options.expectedChecksum}, got ${envelope.checksum}`,
        this.name,
      );
    }

    return envelope.snapshot;
  }

  async list(options: SessionListOptions = {}): Promise<SessionStoreEntry[]> {
    const dir = join(this.worktreePath, SESSIONS_DIR);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const results: SessionStoreEntry[] = [];
    for (const name of entries) {
      if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
      const runId = name.replace(/\.json$/, '');
      try {
        const raw = await fs.readFile(join(dir, name), 'utf-8');
        const env = JSON.parse(raw) as Envelope;
        if (options.provider && env.provider !== options.provider) continue;
        results.push({
          runId,
          provider: env.provider,
          capturedAt: env.capturedAt,
          checksum: env.checksum,
        });
      } catch {
        // Skip corrupt entries — list is best-effort.
        continue;
      }
    }
    // Most recent first.
    results.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
    return options.limit ? results.slice(0, options.limit) : results;
  }
}