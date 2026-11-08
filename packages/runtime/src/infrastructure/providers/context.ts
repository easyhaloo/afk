import { constants, promises as nodeFs, type Dirent, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ContextFragment, ContextQuery, ContextSource, ProviderOperationOptions } from '../../plugin-sdk/capabilities.js';
import { checkAbort, requestHttp, type FetchTransport } from './dependencies.js';

export interface ContextFileSystem {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
  writeFile(path: string, data: string, options?: { mode?: number }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<Stats>;
  open(path: string, flags: number, mode?: number): Promise<FileHandle>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
}

const defaultContextFileSystem: ContextFileSystem = {
  readFile: (path, encoding) => nodeFs.readFile(path, encoding),
  readdir: (path, options) => nodeFs.readdir(path, options),
  mkdir: (path, options) => nodeFs.mkdir(path, options).then(() => undefined),
  writeFile: (path, data, options) => nodeFs.writeFile(path, data, options),
  rename: (from, to) => nodeFs.rename(from, to),
  realpath: path => nodeFs.realpath(path),
  lstat: path => nodeFs.lstat(path),
  open: (path, flags, mode) => nodeFs.open(path, flags, mode),
  unlink: path => nodeFs.unlink(path),
  rmdir: path => nodeFs.rmdir(path),
};

const TEXT_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.css', '.go', '.h', '.hpp', '.java', '.js', '.jsx', '.json', '.md', '.py', '.rb', '.rs', '.sh', '.sql', '.ts', '.tsx', '.txt', '.vue', '.yaml', '.yml']);
const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build']);

function safePath(root: string, input: string): string {
  if (!input || input.includes('\0')) throw new Error('Invalid context path');
  const candidate = resolve(root, input);
  const location = relative(root, candidate);
  if (location === '..' || location.startsWith(`..${sep}`) || isAbsolute(location)) throw new Error('Context path escapes root');
  return candidate;
}

async function checkedPath(root: string, path: string, fs: ContextFileSystem): Promise<Stats> {
  const target = safePath(root, path);
  let current = root;
  let metadata = await fs.lstat(root);
  for (const segment of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, segment);
    metadata = await fs.lstat(current);
    if (metadata.isSymbolicLink()) throw new Error('Context path contains a symbolic link');
  }
  safePath(root, await fs.realpath(target));
  return metadata;
}

async function readBounded(root: string, path: string, fs: ContextFileSystem, maxBytes: number, options?: ProviderOperationOptions): Promise<string> {
  checkAbort(options);
  await checkedPath(root, path, fs);
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    const current = await checkedPath(root, path, fs);
    if (!metadata.isFile() || metadata.dev !== current.dev || metadata.ino !== current.ino) throw new Error('Context file changed during open');
    if (metadata.size > maxBytes) throw new Error('Context file exceeds byte limit');
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      checkAbort(options);
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes - total + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      checkAbort(options);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error('Context file exceeds byte limit');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await handle.close();
  }
}

function queryLimit(limit = 10): number {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1000) throw new Error('Invalid context result limit');
  return limit;
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid context resource limit');
  return value;
}

function rankedFragments(prompt: string, documents: readonly { origin: string; content: string }[], limit: number): ContextFragment[] {
  const queryTerms = [...new Set(prompt.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean))];
  return documents.map(document => {
    const lower = document.content.toLowerCase();
    const score = queryTerms.reduce((total, term) => total + (lower.split(term).length - 1), 0);
    return { content: document.content.slice(0, 20_000), origin: document.origin, score };
  }).filter(fragment => fragment.score > 0).sort((left, right) => right.score - left.score || left.origin.localeCompare(right.origin)).slice(0, limit);
}

export interface CodeContextOptions {
  readonly root: string;
  readonly fs?: ContextFileSystem;
  readonly maxFileBytes?: number;
  readonly maxFiles?: number;
}

export class CodeContextProvider implements ContextSource {
  readonly id = 'context.code';
  readonly capabilities = { 'read-only': true, summarize: false, search: true } as const;
  private readonly root: string;
  private readonly fs: ContextFileSystem;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;

  constructor(options: CodeContextOptions) {
    this.root = resolve(options.root);
    this.fs = options.fs ?? defaultContextFileSystem;
    this.maxFileBytes = positiveLimit(options.maxFileBytes ?? 1024 * 1024);
    this.maxFiles = positiveLimit(options.maxFiles ?? 1000);
  }

  async gather(query: ContextQuery, options?: ProviderOperationOptions): Promise<readonly ContextFragment[]> {
    checkAbort(options);
    const limit = queryLimit(query.limit);
    if (!limit) return [];
    const lexicalScope = safePath(this.root, query.scope || '.');
    const root = await this.fs.realpath(this.root);
    const scope = safePath(root, relative(this.root, lexicalScope) || '.');
    const pending = [scope];
    const documents: { origin: string; content: string }[] = [];
    let visited = 0;
    while (pending.length) {
      checkAbort(options);
      const path = pending.pop()!;
      if (++visited > this.maxFiles) throw new Error('Context traversal exceeds file limit');
      const metadata = await checkedPath(root, path, this.fs);
      if (metadata.isDirectory()) {
        const entries = await this.fs.readdir(path, { withFileTypes: true });
        for (const entry of entries.sort((left, right) => right.name.localeCompare(left.name))) {
          if (entry.isSymbolicLink() || EXCLUDED_DIRECTORIES.has(entry.name) || (!entry.isDirectory() && !TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase()))) continue;
          pending.push(safePath(root, join(path, entry.name)));
          if (pending.length + visited > this.maxFiles) throw new Error('Context traversal exceeds file limit');
        }
      } else if (metadata.isFile() && TEXT_EXTENSIONS.has(extname(path).toLowerCase())) {
        const content = await readBounded(root, path, this.fs, this.maxFileBytes, options);
        if (!content.includes('\0')) documents.push({ origin: relative(root, path) || basename(path), content });
      } else throw new Error('Unsupported context file type');
    }
    return rankedFragments(query.prompt, documents, limit);
  }
}

export interface KnowledgeBaseOptions {
  readonly endpoint: string;
  readonly fetch?: FetchTransport;
  readonly timeoutMs?: number;
}

export class KnowledgeBaseProvider implements ContextSource {
  readonly id = 'context.knowledge-base';
  readonly capabilities = { 'read-only': true, summarize: false, search: true } as const;
  private readonly config: KnowledgeBaseOptions;

  constructor(options: KnowledgeBaseOptions) { this.config = { ...options }; }

  async gather(query: ContextQuery, options?: ProviderOperationOptions): Promise<readonly ContextFragment[]> {
    const limit = queryLimit(query.limit);
    const response = await requestHttp(this.config.fetch, this.config.endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(query),
    }, { ...options, timeoutMs: this.config.timeoutMs });
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new Error('Knowledge base returned invalid JSON'); }
    if (!Array.isArray(payload)) throw new Error('Knowledge base returned an invalid response');
    return payload.map(value => {
      if (!value || typeof value !== 'object') throw new Error('Knowledge base returned an invalid fragment');
      const fragment = value as { content?: unknown; origin?: unknown; score?: unknown };
      if (typeof fragment.content !== 'string' || typeof fragment.origin !== 'string'
        || (fragment.score !== undefined && (typeof fragment.score !== 'number' || !Number.isFinite(fragment.score)))) throw new Error('Knowledge base returned an invalid fragment');
      return { content: fragment.content, origin: fragment.origin, ...(typeof fragment.score === 'number' ? { score: fragment.score } : {}) };
    }).slice(0, limit);
  }
}

export interface RetrievalDocument { readonly origin: string; readonly content: string; }
export class RetrievalProvider implements ContextSource {
  readonly id = 'context.retrieval';
  readonly capabilities = { 'read-only': true, summarize: false, search: true } as const;
  private readonly documents: readonly RetrievalDocument[];

  constructor(documents: readonly RetrievalDocument[]) { this.documents = documents.map(document => ({ ...document })); }

  async gather(query: ContextQuery, options?: ProviderOperationOptions): Promise<readonly ContextFragment[]> {
    checkAbort(options);
    return rankedFragments(query.prompt, this.documents, queryLimit(query.limit));
  }
}

export interface ProjectMemoryOptions {
  readonly file: string;
  readonly root?: string;
  readonly fs?: ContextFileSystem;
  readonly lockTimeoutMs?: number;
  readonly maxBytes?: number;
}

async function waitForLock(options?: ProviderOperationOptions): Promise<void> {
  checkAbort(options);
  await new Promise<void>((complete, reject) => {
    const abort = () => {
      clearTimeout(timer);
      options?.signal?.removeEventListener('abort', abort);
      reject(options?.signal?.reason ?? new Error('Operation aborted'));
    };
    const timer = setTimeout(() => { options?.signal?.removeEventListener('abort', abort); complete(); }, 10);
    options?.signal?.addEventListener('abort', abort, { once: true });
    if (options?.signal?.aborted) abort();
  });
}

export class ProjectMemoryProvider implements ContextSource {
  readonly id = 'context.project-memory';
  readonly capabilities = { 'read-only': true, summarize: false, search: true } as const;
  private readonly root: string;
  private readonly file: string;
  private readonly fs: ContextFileSystem;
  private readonly lockTimeoutMs: number;
  private readonly maxBytes: number;

  constructor(options: ProjectMemoryOptions) {
    this.root = resolve(options.root ?? dirname(resolve(options.file)));
    this.file = safePath(this.root, options.root ? options.file : resolve(options.file));
    if (this.file === this.root) throw new Error('Memory path must name a file');
    this.fs = options.fs ?? defaultContextFileSystem;
    this.lockTimeoutMs = positiveLimit(options.lockTimeoutMs ?? 5000);
    this.maxBytes = positiveLimit(options.maxBytes ?? 4 * 1024 * 1024);
  }

  async remember(fragment: ContextFragment, options?: ProviderOperationOptions): Promise<void> {
    checkAbort(options);
    this.validateRecord(fragment);
    await this.fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = await this.fs.realpath(this.root);
    const file = safePath(root, relative(this.root, this.file));
    let parent = root;
    for (const segment of relative(root, dirname(file)).split(sep).filter(Boolean)) {
      parent = join(parent, segment);
      try { await this.fs.mkdir(parent, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      if (!(await checkedPath(root, parent, this.fs)).isDirectory()) throw new Error('Invalid memory directory');
    }
    const lock = `${file}.lock`;
    const deadline = performance.now() + this.lockTimeoutMs;
    for (;;) {
      checkAbort(options);
      await checkedPath(root, dirname(file), this.fs);
      try { await this.fs.mkdir(lock, { mode: 0o700 }); break; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const metadata = await this.fs.lstat(lock).catch(missing => {
          if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw missing;
        });
        if (metadata && !metadata.isDirectory()) throw new Error('Invalid memory lock path');
        if (performance.now() >= deadline) throw new Error('Project memory lock timed out');
        await waitForLock(options);
      }
    }
    const temporary = `${file}.${randomUUID()}.tmp`;
    let created = false;
    try {
      const records = await this.readRecords(root, file, options);
      records.push({ content: fragment.content, origin: fragment.origin, ...(fragment.score === undefined ? {} : { score: fragment.score }) });
      const content = JSON.stringify(records);
      if (Buffer.byteLength(content) > this.maxBytes) throw new Error('Project memory exceeds byte limit');
      await checkedPath(root, dirname(file), this.fs);
      const handle = await this.fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      checkAbort(options);
      await checkedPath(root, dirname(file), this.fs);
      try { await checkedPath(root, file, this.fs); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await this.fs.rename(temporary, file);
      created = false;
    } finally {
      try { if (created) await this.fs.unlink(temporary); } finally { await this.fs.rmdir(lock); }
    }
  }

  async gather(query: ContextQuery, options?: ProviderOperationOptions): Promise<readonly ContextFragment[]> {
    checkAbort(options);
    const limit = queryLimit(query.limit);
    let root: string;
    try { root = await this.fs.realpath(this.root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    return rankedFragments(query.prompt, await this.readRecords(root, safePath(root, relative(this.root, this.file)), options), limit);
  }

  private validateRecord(value: ContextFragment): void {
    if (!value || typeof value.content !== 'string' || typeof value.origin !== 'string'
      || (value.score !== undefined && (typeof value.score !== 'number' || !Number.isFinite(value.score)))) throw new Error('Invalid project memory record');
  }

  private async readRecords(root: string, file: string, options?: ProviderOperationOptions): Promise<ContextFragment[]> {
    let content: string;
    try { content = await readBounded(root, file, this.fs, this.maxBytes, options); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    let value: unknown;
    try { value = JSON.parse(content); } catch { throw new Error('Project memory is unreadable'); }
    if (!Array.isArray(value)) throw new Error('Invalid project memory document');
    for (const record of value) this.validateRecord(record);
    return value;
  }
}

export { defaultContextFileSystem };
