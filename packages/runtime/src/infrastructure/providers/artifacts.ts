/**
 * Concrete Artifact/Report capability providers.
 *
 * Constructors never perform IO. Local storage defaults to Node's filesystem;
 * HTTP operations use an injected transport or global fetch at call time.
 *
 * Artifact names are validated to a safe single segment and every on-disk path
 * is resolved back inside the configured root, with a symlink guard in front of
 * each write, so a hostile artifact name can neither traverse out of the root
 * nor follow a pre-planted symlink to another file.
 */

import { createHash, randomBytes } from 'node:crypto';
import { promises as nodeFs } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  ArtifactDescriptor,
  ArtifactRef,
  ArtifactSink,
  ArtifactSinkCapability,
  ProviderHealth,
  ProviderOperationOptions,
} from '../../plugin-sdk/capabilities.js';
import { checkAbort, requestHttp, type FetchTransport } from './dependencies.js';

export type { ArtifactSinkCapability };

/**
 * Minimal filesystem surface the local providers need. Injected so tests run
 * against an in-memory adapter and so production uses the real `node:fs`.
 */
export interface ArtifactFileSystem {
  mkdir(path: string, options: { readonly recursive: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  writeFile(path: string, data: Uint8Array, options: { readonly mode: number }): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  readdir(path: string): Promise<readonly string[]>;
  lstat(path: string): Promise<ArtifactFileStat>;
}

export interface ArtifactFileStat {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
}

/** The real filesystem, adapted to {@link ArtifactFileSystem}. */
export const nodeArtifactFileSystem: ArtifactFileSystem = {
  mkdir: async (path, options) => {
    await nodeFs.mkdir(path, options);
  },
  rename: (from, to) => nodeFs.rename(from, to),
  writeFile: (path, data, options) => nodeFs.writeFile(path, data, options),
  readFile: path => nodeFs.readFile(path),
  readdir: async path => nodeFs.readdir(path),
  lstat: path => nodeFs.lstat(path),
};

/**
 * A safe artifact name is a single path segment: no separators, no `..`, no
 * leading dot, no NUL. This is the first line of defence against traversal.
 */
const SAFE_ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

export function assertSafeArtifactName(name: string): string {
  if (typeof name !== 'string' || !SAFE_ARTIFACT_NAME.test(name)) {
    throw new Error(`unsafe artifact name: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Resolve `relative` inside `root` and prove the result stayed inside. Returns
 * the resolved target or throws when the value would escape the root.
 */
export function resolveWithinRoot(root: string, relative: string): string {
  const normalizedRoot = resolve(root);
  const target = resolve(normalizedRoot, relative);
  if (target !== normalizedRoot && !target.startsWith(normalizedRoot + sep)) {
    throw new Error(`artifact path escapes the configured root: ${JSON.stringify(relative)}`);
  }
  return target;
}

/** SHA-256 hex digest of the given bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// --- Test report (local directory sink) ---

export interface TestReportProviderOptions {
  /** Directory artifacts are persisted into. Created on demand. */
  readonly root: string;
  /** Defaults to the real Node filesystem. */
  readonly fs?: ArtifactFileSystem;
}

/**
 * Persists report/test bytes to a local directory.
 *
 * Writes are atomic: bytes land in a unique temp file first and are renamed
 * into place, so a reader never observes a half-written artifact and a crash
 * leaves the previous artifact intact.
 */
export class TestReportProvider implements ArtifactSink {
  readonly id = 'test-report-local';
  readonly capabilities: Readonly<Record<ArtifactSinkCapability, boolean>> = {
    write: true,
    read: true,
    list: true,
  };

  private readonly fs: ArtifactFileSystem;

  constructor(private readonly options: TestReportProviderOptions) {
    this.fs = options.fs ?? nodeArtifactFileSystem;
  }

  async put(artifact: ArtifactDescriptor, options?: ProviderOperationOptions): Promise<ArtifactRef> {
    checkAbort(options);
    const name = assertSafeArtifactName(artifact.name);
    if (typeof artifact.mediaType !== 'string' || artifact.mediaType.length === 0) {
      throw new Error('artifact mediaType is required');
    }
    const target = resolveWithinRoot(this.options.root, name);
    await this.fs.mkdir(this.options.root, { recursive: true });
    await this.rejectSymlink(target);
    await this.writeAtomic(target, artifact.bytes);
    return { uri: pathToFileURL(target).href, name };
  }

  async read(name: string, options?: ProviderOperationOptions): Promise<Uint8Array> {
    checkAbort(options);
    const safe = assertSafeArtifactName(name);
    const target = resolveWithinRoot(this.options.root, safe);
    await this.rejectSymlink(target);
    return this.fs.readFile(target);
  }

  async list(options?: ProviderOperationOptions): Promise<readonly string[]> {
    checkAbort(options);
    const entries = await this.fs.readdir(this.options.root);
    const readable: string[] = [];
    for (const entry of entries) {
      checkAbort(options);
      if (!SAFE_ARTIFACT_NAME.test(entry)) continue;
      try {
        const stat = await this.fs.lstat(resolveWithinRoot(this.options.root, entry));
        if (stat.isFile() && !stat.isSymbolicLink()) readable.push(entry);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    checkAbort(options);
    return readable.sort();
  }

  async health(): Promise<ProviderHealth> {
    try {
      await this.fs.mkdir(this.options.root, { recursive: true });
      return { status: 'ok' };
    } catch (error) {
      return { status: 'unavailable', message: `artifact root is not usable: ${(error as Error).message}` };
    }
  }

  /** Refuse to write through a symlink planted at the target path. */
  private async rejectSymlink(target: string): Promise<void> {
    let stat: ArtifactFileStat;
    try {
      stat = await this.fs.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`artifact path is a symbolic link: ${target}`);
  }

  private async writeAtomic(target: string, bytes: Uint8Array): Promise<void> {
    const temporary = join(this.options.root, `.artifact.tmp-${process.pid}-${randomBytes(8).toString('hex')}`);
    await this.fs.writeFile(temporary, bytes, { mode: 0o600 });
    await this.fs.rename(temporary, target);
  }
}

// --- Evidence bundle (deterministic JSON + SHA-256, stored via a sink) ---

export interface EvidenceBundleRecord {
  readonly id: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface EvidenceBundleRequest {
  readonly name: string;
  readonly records: readonly EvidenceBundleRecord[];
}

export interface EvidenceBundleRecordMeta {
  readonly id: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly size: number;
}

export interface EvidenceBundle {
  readonly version: 1;
  readonly algorithm: 'sha256';
  readonly recordCount: number;
  readonly totalBytes: number;
  /** Digest over the canonical, sorted record metadata (excludes itself). */
  readonly bundleSha256: string;
  readonly records: readonly EvidenceBundleRecordMeta[];
}

export interface EvidenceBundleResult {
  readonly ref: ArtifactRef;
  readonly bundle: EvidenceBundle;
}

/**
 * Builds a deterministic JSON evidence bundle and hands the bytes to an
 * injected {@link ArtifactSink}.
 *
 * Determinism: records are sorted by id and the bundle digest is taken over the
 * canonical metadata (not over timestamps), so identical inputs always produce
 * byte-identical bundles. No secret material is copied into the bundle — only
 * per-record digests and sizes.
 */
export class EvidenceBundleProvider implements ArtifactSink {
  readonly id = 'evidence-bundle';
  readonly capabilities: Readonly<Record<ArtifactSinkCapability, boolean>> = {
    write: true,
    read: false,
    list: false,
  };

  constructor(private readonly sink: ArtifactSink) {}

  async put(artifact: ArtifactDescriptor, options?: ProviderOperationOptions): Promise<ArtifactRef> {
    checkAbort(options);
    assertSafeArtifactName(artifact.name);
    if (!artifact.mediaType || !(artifact.bytes instanceof Uint8Array)) throw new Error('Invalid evidence artifact');
    const ref = await this.sink.put(artifact, options);
    checkAbort(options);
    return ref;
  }

  async create(request: EvidenceBundleRequest, options?: ProviderOperationOptions): Promise<EvidenceBundleResult> {
    checkAbort(options);
    assertSafeArtifactName(request.name);
    const bundle = this.build(request.records);
    const bytes = Buffer.from(JSON.stringify(bundle, null, 2), 'utf8');
    checkAbort(options);
    const ref = await this.put(
      { name: request.name, mediaType: 'application/json', bytes },
      options,
    );
    return { ref, bundle };
  }

  private build(records: readonly EvidenceBundleRecord[]): EvidenceBundle {
    const metas: EvidenceBundleRecordMeta[] = records.map(record => ({
      id: record.id,
      mediaType: record.mediaType,
      sha256: sha256Hex(record.bytes),
      size: record.bytes.byteLength,
    }));
    metas.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    // The digest covers the canonical metadata only, so it is reproducible and
    // independent of the array's original ordering.
    const bundleSha256 = sha256Hex(Buffer.from(JSON.stringify(metas), 'utf8'));
    return {
      version: 1,
      algorithm: 'sha256',
      recordCount: metas.length,
      totalBytes: metas.reduce((total, meta) => total + meta.size, 0),
      bundleSha256,
      records: metas,
    };
  }
}

// --- Object storage (HTTP PUT to a presigned URL or endpoint) ---

export interface ObjectStorageProviderOptions {
  /** Optional transport; defaults to global fetch at operation time. */
  readonly transport?: FetchTransport;
  /** Full object URL base; the artifact name is appended when used directly. */
  readonly endpoint?: string;
  /** Returns a presigned/upload URL for the artifact. Takes precedence. */
  readonly resolveUrl?: (artifact: ArtifactDescriptor) => string | Promise<string>;
}

/**
 * Uploads raw artifact bytes with HTTP PUT.
 *
 * The destination is either an injected presigned URL or a configured endpoint;
 * this provider never computes an AWS/V4 signature or signs a request itself.
 */
export class ObjectStorageProvider implements ArtifactSink {
  readonly id = 'object-storage';
  readonly capabilities: Readonly<Record<ArtifactSinkCapability, boolean>> = {
    write: true,
    read: false,
    list: false,
  };

  constructor(private readonly options: ObjectStorageProviderOptions) {}

  async put(artifact: ArtifactDescriptor, options?: ProviderOperationOptions): Promise<ArtifactRef> {
    checkAbort(options);
    assertSafeArtifactName(artifact.name);
    if (typeof artifact.mediaType !== 'string' || artifact.mediaType.length === 0) {
      throw new Error('artifact mediaType is required');
    }
    const target = await this.resolveTarget(artifact);
    const response = await requestHttp(
      this.options.transport,
      target,
      {
        method: 'PUT',
        body: Buffer.from(artifact.bytes),
        headers: { 'content-type': artifact.mediaType },
      },
      options,
    );
    const uri = await this.extractUri(response, target);
    return { uri, name: artifact.name };
  }

  async health(): Promise<ProviderHealth> {
    if (!this.options.endpoint && !this.options.resolveUrl) {
      return { status: 'unavailable', message: 'object storage requires an endpoint or a presigned URL resolver' };
    }
    if (!this.options.resolveUrl) {
      try { artifactHttpUri(this.options.endpoint); } catch {
        return { status: 'unavailable', message: 'invalid object storage endpoint' };
      }
    }
    return this.options.transport || typeof globalThis.fetch === 'function'
      ? { status: 'ok' }
      : { status: 'unavailable', message: 'fetch is unavailable' };
  }

  private async resolveTarget(artifact: ArtifactDescriptor): Promise<string> {
    if (this.options.resolveUrl) return this.options.resolveUrl(artifact);
    if (this.options.endpoint) {
      const base = this.options.endpoint.replace(/\/+$/, '');
      return `${base}/${encodeURIComponent(artifact.name)}`;
    }
    throw new Error('object storage requires an endpoint or a presigned URL resolver');
  }

  /**
   * Prefer an object location the server reports; otherwise fall back to the
   * request target with any presigned query string stripped so a signature is
   * never persisted into the artifact reference.
   */
  private async extractUri(response: Response, target: string): Promise<string> {
    const text = await response.text().catch(() => '');
    if (text.trim()) {
      let parsed: { uri?: unknown; location?: unknown } | null;
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        return artifactHttpUri(target);
      }
      const candidate = parsed?.uri ?? parsed?.location;
      if (candidate !== undefined) {
        try { return artifactHttpUri(candidate); } catch {
          throw new Error('object storage returned an invalid artifact URI');
        }
      }
    }
    return artifactHttpUri(target);
  }
}

// --- Report platform (HTTP POST raw artifact, validates returned URI) ---

export interface ReportPlatformProviderOptions {
  /** Optional transport; defaults to global fetch at operation time. */
  readonly transport?: FetchTransport;
  /** Full upload endpoint that accepts the raw artifact body. */
  readonly endpoint: string;
  /** Optional bearer token sent as an Authorization header. */
  readonly token?: string;
}

/**
 * POSTs the raw artifact bytes with an explicit Content-Type and requires the
 * platform to answer with an HTTP(S) artifact URI. A response without a valid
 * URI is rejected rather than being turned into a fabricated reference.
 */
export class ReportPlatformProvider implements ArtifactSink {
  readonly id = 'report-platform';
  readonly capabilities: Readonly<Record<ArtifactSinkCapability, boolean>> = {
    write: true,
    read: false,
    list: false,
  };

  constructor(private readonly options: ReportPlatformProviderOptions) {}

  async put(artifact: ArtifactDescriptor, options?: ProviderOperationOptions): Promise<ArtifactRef> {
    checkAbort(options);
    assertSafeArtifactName(artifact.name);
    if (typeof artifact.mediaType !== 'string' || artifact.mediaType.length === 0) {
      throw new Error('artifact mediaType is required');
    }
    const endpoint = new URL(artifactHttpUri(this.options.endpoint));
    if (this.options.token && endpoint.protocol !== 'https:') throw new Error('report platform bearer token requires HTTPS');
    const response = await requestHttp(
      this.options.transport,
      this.options.endpoint,
      {
        method: 'POST',
        body: Buffer.from(artifact.bytes),
        headers: {
          'content-type': artifact.mediaType,
          ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
        },
      },
      options,
    );
    const uri = await this.readReturnedUri(response);
    if (!uri) throw new Error('report platform did not return a valid artifact URI');
    return { uri, name: artifact.name };
  }

  async health(): Promise<ProviderHealth> {
    try {
      const endpoint = new URL(artifactHttpUri(this.options.endpoint));
      if (this.options.token && endpoint.protocol !== 'https:') throw new Error('bearer token requires HTTPS');
      return this.options.transport || typeof globalThis.fetch === 'function'
        ? { status: 'ok' }
        : { status: 'unavailable', message: 'fetch is unavailable' };
    } catch {
      return { status: 'unavailable', message: 'invalid report platform configuration' };
    }
  }

  private async readReturnedUri(response: Response): Promise<string | undefined> {
    const text = await response.text().catch(() => '');
    if (!text.trim()) return undefined;
    try {
      const parsed = JSON.parse(text) as { uri?: unknown; url?: unknown; location?: unknown } | null;
      return artifactHttpUri(parsed?.uri ?? parsed?.url ?? parsed?.location);
    } catch {
      return undefined;
    }
  }
}

function artifactHttpUri(candidate: unknown): string {
  if (typeof candidate !== 'string') throw new Error('Invalid artifact URI');
  const uri = new URL(candidate);
  if (!['http:', 'https:'].includes(uri.protocol) || uri.username || uri.password) throw new Error('Invalid artifact URI');
  uri.search = '';
  uri.hash = '';
  return uri.href;
}
