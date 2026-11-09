import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { CodeContextProvider, KnowledgeBaseProvider, ProjectMemoryProvider, RetrievalProvider, defaultContextFileSystem } from './context.js';
import { executeCommand } from './dependencies.js';

const roots: string[] = [];
async function root(): Promise<string> {
  const path = await fs.mkdtemp(join(tmpdir(), 'provider-context-'));
  roots.push(path);
  return path;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(path => fs.rm(path, { recursive: true, force: true })));
});

describe('context providers', () => {
  it('searches real source files, accepts file scope and excludes dependency and symlink entries', async () => {
    const path = await root();
    const outside = await root();
    await fs.mkdir(join(path, 'src'));
    await fs.writeFile(join(path, 'src', 'auth.ts'), 'export function token() { return "token"; }');
    await fs.writeFile(join(path, 'README.md'), 'project overview');
    await fs.mkdir(join(path, 'node_modules'));
    await fs.writeFile(join(path, 'node_modules', 'ignored.ts'), 'token');
    await fs.writeFile(join(outside, 'secret.ts'), 'token outside secret');
    await fs.symlink(join(outside, 'secret.ts'), join(path, 'alias.ts'));
    const provider = new CodeContextProvider({ root: path });
    for (const scope of ['.', 'src/auth.ts']) {
      await expect(provider.gather({ scope, prompt: 'token' })).resolves.toEqual([
        expect.objectContaining({ origin: 'src/auth.ts', content: expect.stringContaining('token') }),
      ]);
    }
    await expect(provider.gather({ scope: '../', prompt: 'token' })).rejects.toThrow('escapes root');
  });

  it('rejects explicit symbolic-link scope and parent escapes', async () => {
    const path = await root();
    const outside = await root();
    await fs.writeFile(join(outside, 'secret.ts'), 'token secret');
    await fs.symlink(outside, join(path, 'linked'));
    const provider = new CodeContextProvider({ root: path });
    await expect(provider.gather({ scope: 'linked', prompt: 'token' })).rejects.toThrow('symbolic link');
    await expect(provider.gather({ scope: 'linked/secret.ts', prompt: 'token' })).rejects.toThrow('symbolic link');
  });

  it('uses no-follow file opens and catches replacement after traversal', async () => {
    const path = await root();
    const outside = await root();
    const file = join(path, 'auth.ts');
    await fs.writeFile(file, 'token allowed');
    await fs.writeFile(join(outside, 'secret.ts'), 'token sensitive');
    const open = vi.fn(async (...args: Parameters<typeof defaultContextFileSystem.open>) => {
      await fs.rename(file, `${file}.bak`);
      await fs.symlink(join(outside, 'secret.ts'), file);
      return defaultContextFileSystem.open(...args);
    });
    await expect(new CodeContextProvider({ root: path, fs: { ...defaultContextFileSystem, open } }).gather({ scope: '.', prompt: 'token' })).rejects.toThrow();
    expect(open).toHaveBeenCalledOnce();
  });

  it('checks resource limits, zero results, binary files and cancellation', async () => {
    const path = await root();
    await fs.writeFile(join(path, 'a.ts'), 'token'.repeat(100));
    await expect(new CodeContextProvider({ root: path, maxFileBytes: 10 }).gather({ scope: '.', prompt: 'token' })).rejects.toThrow('byte limit');
    await expect(new CodeContextProvider({ root: path, maxFiles: 1 }).gather({ scope: '.', prompt: 'token' })).rejects.toThrow('file limit');
    await expect(new CodeContextProvider({ root: path }).gather({ scope: '.', prompt: 'token', limit: 0 })).resolves.toEqual([]);
    await expect(new CodeContextProvider({ root: path }).gather({ scope: '.', prompt: 'token', limit: NaN })).rejects.toThrow('Invalid context result limit');
    await fs.writeFile(join(path, 'a.ts'), 'token\0binary');
    await expect(new CodeContextProvider({ root: path }).gather({ scope: '.', prompt: 'token' })).resolves.toEqual([]);
    const controller = new AbortController();
    controller.abort(new Error('cancel'));
    await expect(new CodeContextProvider({ root: path }).gather({ scope: '.', prompt: 'token' }, { signal: controller.signal })).rejects.toThrow('cancel');
  });

  it('closes the file handle on cancellation between open and content read', async () => {
    const path = await root();
    await fs.writeFile(join(path, 'a.ts'), 'token');
    const controller = new AbortController();
    let close: MockInstance<[], Promise<void>> | undefined;
    const open = async (...args: Parameters<typeof defaultContextFileSystem.open>) => {
      const handle = await defaultContextFileSystem.open(...args);
      close = vi.spyOn(handle, 'close');
      controller.abort(new Error('cancel while reading'));
      return handle;
    };
    await expect(new CodeContextProvider({ root: path, fs: { ...defaultContextFileSystem, open } }).gather({ scope: '.', prompt: 'token' }, { signal: controller.signal })).rejects.toThrow('cancel while reading');
    expect(close).toHaveBeenCalledOnce();
  });

  it('ranks retrieval deterministically and snapshots injected documents', async () => {
    const documents = [{ origin: 'second', content: 'alpha' }, { origin: 'first', content: 'alpha alpha' }];
    const provider = new RetrievalProvider(documents);
    documents[0].content = 'changed';
    await expect(provider.gather({ scope: '.', prompt: 'alpha', limit: 2 })).resolves.toEqual([
      { origin: 'first', content: 'alpha alpha', score: 2 }, { origin: 'second', content: 'alpha', score: 1 },
    ]);
  });

  it('uses global knowledge-base fetch lazily and validates all returned fragments', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify([{ content: 'answer', origin: 'kb:1', score: 0.9 }])));
    vi.stubGlobal('fetch', fetch);
    const provider = new KnowledgeBaseProvider({ endpoint: 'https://kb.example/query' });
    expect(fetch).not.toHaveBeenCalled();
    await expect(provider.gather({ scope: 'project', prompt: 'answer' })).resolves.toEqual([{ content: 'answer', origin: 'kb:1', score: 0.9 }]);
    expect(fetch.mock.calls.length).toBe(1);
    for (const payload of [{}, [null], [{ content: 1, origin: 'bad' }], [{ content: 'a', origin: 'kb', score: 'bad' }]]) {
      await expect(new KnowledgeBaseProvider({ endpoint: 'https://kb.example/query', fetch: async () => new Response(JSON.stringify(payload)) }).gather({ scope: '.', prompt: 'x' })).rejects.toThrow('Knowledge base returned');
    }
  });

  it('times out knowledge-base body reads', async () => {
    const provider = new KnowledgeBaseProvider({ endpoint: 'https://kb.example/query', timeoutMs: 10, fetch: async () => new Response(new ReadableStream()) });
    await expect(provider.gather({ scope: '.', prompt: 'x' })).rejects.toThrow('timed out');
  });
});

describe('project memory integrity', () => {
  it('persists private records atomically and preserves all concurrent instance writes', async () => {
    const path = await root();
    const file = join(path, 'nested', 'memory.json');
    const provider = new ProjectMemoryProvider({ root: path, file });
    await Promise.all(Array.from({ length: 20 }, (_, index) => new ProjectMemoryProvider({ root: path, file }).remember({ content: `deploy ${index}`, origin: `run-${index}` })));
    const result = await provider.gather({ scope: '.', prompt: 'deploy', limit: 50 });
    expect(result).toHaveLength(20);
    expect(new Set(result.map(fragment => fragment.origin)).size).toBe(20);
    expect(await fs.readdir(join(path, 'nested'))).toEqual(['memory.json']);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it('serializes writers across real child processes', async () => {
    const path = await root();
    const file = join(path, 'memory.json');
    const script = 'const { ProjectMemoryProvider } = await import(process.argv[1]); await new ProjectMemoryProvider({root:process.argv[2],file:process.argv[3]}).remember({content:"deploy",origin:process.argv[4]});';
    await Promise.all(['child-1', 'child-2', 'child-3'].map(id => executeCommand({
      command: process.execPath,
      args: ['--import', 'tsx', '--input-type=module', '-e', script, new URL('./context.ts', import.meta.url).href, path, file, id],
    })));
    expect(await new ProjectMemoryProvider({ root: path, file }).gather({ scope: '.', prompt: 'deploy' })).toHaveLength(3);
  });

  it('rejects escaping paths and symlink parents/files without modifying external data', async () => {
    const path = await root();
    const outside = await root();
    expect(() => new ProjectMemoryProvider({ root: path, file: '../outside.json' })).toThrow('escapes root');
    const external = join(outside, 'memory.json');
    await fs.writeFile(external, '[{"content":"sensitive","origin":"outside"}]');
    await fs.symlink(outside, join(path, 'linked'));
    await fs.symlink(external, join(path, 'alias.json'));
    for (const file of ['linked/memory.json', 'alias.json']) {
      const provider = new ProjectMemoryProvider({ root: path, file });
      await expect(provider.remember({ content: 'deploy', origin: 'x' })).rejects.toThrow('symbolic link');
      await expect(provider.gather({ scope: '.', prompt: 'sensitive' })).rejects.toThrow('symbolic link');
    }
    expect(JSON.parse(await fs.readFile(external, 'utf8'))).toEqual([{ content: 'sensitive', origin: 'outside' }]);
  });

  it('rejects corrupt JSON/schema instead of overwriting or dropping existing records', async () => {
    const path = await root();
    const file = join(path, 'memory.json');
    for (const corrupt of ['not json', '{}', '[{"content":123,"origin":"x"}]']) {
      await fs.writeFile(file, corrupt);
      const provider = new ProjectMemoryProvider({ root: path, file });
      await expect(provider.remember({ content: 'deploy', origin: 'x' })).rejects.toThrow();
      expect(await fs.readFile(file, 'utf8')).toBe(corrupt);
      expect(await fs.readdir(path)).toEqual(['memory.json']);
    }
  });

  it('preserves original data and removes own temporary file and lock if rename fails', async () => {
    const path = await root();
    const file = join(path, 'memory.json');
    const original = '[{"content":"deploy old","origin":"old"}]';
    await fs.writeFile(file, original);
    const provider = new ProjectMemoryProvider({ root: path, file, fs: { ...defaultContextFileSystem, rename: async () => { throw new Error('disk failure'); } } });
    await expect(provider.remember({ content: 'deploy new', origin: 'new' })).rejects.toThrow('disk failure');
    expect(await fs.readFile(file, 'utf8')).toBe(original);
    expect(await fs.readdir(path)).toEqual(['memory.json']);
  });

  it('bounds lock waiting and supports cancellation without stealing another writer lock', async () => {
    const path = await root();
    const file = join(path, 'memory.json');
    await fs.mkdir(`${file}.lock`);
    const provider = new ProjectMemoryProvider({ root: path, file, lockTimeoutMs: 20 });
    await expect(provider.remember({ content: 'deploy', origin: 'x' })).rejects.toThrow('lock timed out');
    const controller = new AbortController();
    const result = provider.remember({ content: 'deploy', origin: 'x' }, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('cancel lock wait')), 5);
    await expect(result).rejects.toThrow('cancel lock wait');
    expect(await fs.readdir(path)).toEqual(['memory.json.lock']);
  });

  it('returns no records for missing memory, validates new records and bounds stored data', async () => {
    const path = await root();
    const provider = new ProjectMemoryProvider({ root: path, file: 'nested/memory.json', maxBytes: 30 });
    await expect(provider.gather({ scope: '.', prompt: 'deploy' })).resolves.toEqual([]);
    await expect(provider.remember({ content: 'deploy', origin: 'x', score: NaN })).rejects.toThrow('Invalid project memory record');
    await expect(provider.remember({ content: 'deploy'.repeat(100), origin: 'x' })).rejects.toThrow('byte limit');
    expect(await fs.readdir(join(path, 'nested'))).toEqual([]);
  });
});
