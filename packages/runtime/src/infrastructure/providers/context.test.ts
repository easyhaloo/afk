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

  it.each(['retrieval', 'code', 'memory'] as const)('recalls Chinese business context through %s', async kind => {
    const path = await root();
    const documents = [
      { origin: 'login.md', content: '如何配置登录后的邮箱通知。' },
      { origin: 'disk.md', content: '磁盘空间不足时应清理构建缓存，再重新运行测试。' },
    ];
    let provider: RetrievalProvider | CodeContextProvider | ProjectMemoryProvider;
    if (kind === 'code') {
      await Promise.all(documents.map(document => fs.writeFile(join(path, document.origin), document.content)));
      provider = new CodeContextProvider({ root: path });
    } else if (kind === 'memory') {
      const memory = new ProjectMemoryProvider({ root: path, file: join(path, 'memory.json') });
      for (const document of documents) await memory.remember(document);
      provider = memory;
    } else provider = new RetrievalProvider(documents);
    await expect(provider.gather({ scope: '.', prompt: '如何解决磁盘空间不足导致的构建失败？', limit: 1 }))
      .resolves.toEqual([expect.objectContaining({ origin: 'disk.md' })]);
    await expect(provider.gather({ scope: '.', prompt: '如何同步企业联系人信息？' })).resolves.toEqual([]);
    await expect(provider.gather({ scope: '.', prompt: '磁盘空间不足', limit: 0 })).resolves.toEqual([]);
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

describe('knowledge-base operation credentials', () => {
  const endpoint = 'https://kb.example/query';
  const query = { scope: 'project', prompt: 'answer' };

  it('resolves a fresh secret only for each gather and forwards operation options', async () => {
    const token = vi.fn().mockResolvedValueOnce({ secret: 'first' }).mockResolvedValueOnce({ secret: 'second' });
    const fetch = vi.fn<Parameters<typeof globalThis.fetch>, ReturnType<typeof globalThis.fetch>>().mockImplementation(async () => new Response('[]'));
    const provider = new KnowledgeBaseProvider({ endpoint, token, fetch });
    expect(provider.id).toBe('context.knowledge-base');
    expect(provider.capabilities.search).toBe(true);
    expect(token).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    const options = { signal: new AbortController().signal, deadlineAt: Date.now() + 5000 };
    await provider.gather(query, options);
    await provider.gather(query, options);
    expect(token.mock.calls).toEqual([[options], [options]]);
    expect(fetch.mock.calls.map(([, init]) => init?.headers)).toEqual([
      { 'content-type': 'application/json', authorization: 'Bearer first' },
      { 'content-type': 'application/json', authorization: 'Bearer second' },
    ]);
    expect(fetch.mock.calls[0][1]).toEqual(expect.objectContaining({ method: 'POST', body: JSON.stringify(query), redirect: 'error' }));
  });

  it.each([undefined, 'static-secret'])('retains anonymous HTTP and supports static HTTPS credentials (%s)', async token => {
    const fetch = vi.fn<Parameters<typeof globalThis.fetch>, ReturnType<typeof globalThis.fetch>>().mockResolvedValue(new Response('[]'));
    await new KnowledgeBaseProvider({ endpoint: token === undefined ? 'http://kb.example/query' : endpoint, token, fetch }).gather(query);
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe(token === undefined ? null : `Bearer ${token}`);
  });

  it.each(['revoked', 'expired', 'unavailable', 'invalid', 'empty-static'])('blocks network for %s credentials with a sanitized error', async state => {
    const token = state === 'empty-static' ? '' : vi.fn(async () => {
      if (state === 'unavailable') throw new Error('private credential resolver details');
      if (state === 'invalid') return { secret: 'private\r\nheader' };
      return { secret: 'private-token', revoked: state === 'revoked', ...(state === 'expired' ? { expiresAt: '2000-01-01T00:00:00Z' } : {}) };
    });
    const fetch = vi.fn<Parameters<typeof globalThis.fetch>, ReturnType<typeof globalThis.fetch>>();
    await expect(new KnowledgeBaseProvider({ endpoint, token, fetch }).gather(query)).rejects.toThrow(/^Operation credential unavailable$/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('checks revocation again after an earlier successful gather', async () => {
    const token = vi.fn().mockResolvedValueOnce({ secret: 'private-token' }).mockResolvedValueOnce({ secret: 'private-token', revoked: true });
    const fetch = vi.fn<Parameters<typeof globalThis.fetch>, ReturnType<typeof globalThis.fetch>>().mockResolvedValue(new Response('[]'));
    const provider = new KnowledgeBaseProvider({ endpoint, token, fetch });
    await provider.gather(query);
    await expect(provider.gather(query)).rejects.toThrow(/^Operation credential unavailable$/);
    expect(token).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('requires HTTPS before resolving a bearer credential', async () => {
    const token = vi.fn(async () => ({ secret: 'private-token' }));
    const fetch = vi.fn<Parameters<typeof globalThis.fetch>, ReturnType<typeof globalThis.fetch>>();
    await expect(new KnowledgeBaseProvider({ endpoint: 'http://kb.example/query', token, fetch }).gather(query)).rejects.toThrow('bearer token requires HTTPS');
    expect(token).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancels pending credential resolution without exposing the abort reason or starting HTTP', async () => {
    let rejectSecret!: (error: Error) => void;
    const token = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectSecret = reject; }));
    const fetch = vi.fn<Parameters<typeof globalThis.fetch>, ReturnType<typeof globalThis.fetch>>();
    const controller = new AbortController();
    const pending = new KnowledgeBaseProvider({ endpoint, token, fetch }).gather(query, { signal: controller.signal });
    await Promise.resolve();
    expect(token).toHaveBeenCalledOnce();
    controller.abort(new Error('private abort reason'));
    await expect(pending).rejects.toThrow(/^Operation credential unavailable$/);
    rejectSecret(new Error('private late rejection'));
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('bounds pending credential resolution by the operation deadline', async () => {
    vi.useFakeTimers();
    try {
      const token = vi.fn(() => new Promise<never>(() => undefined));
      const fetch = vi.fn<Parameters<typeof globalThis.fetch>, ReturnType<typeof globalThis.fetch>>();
      const pending = new KnowledgeBaseProvider({ endpoint, token, fetch }).gather(query, { deadlineAt: Date.now() + 25 });
      const rejected = expect(pending).rejects.toThrow(/^Operation credential unavailable$/);
      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      expect(token).toHaveBeenCalledOnce();
      expect(fetch).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(['aborted', 'deadline'])('does not resolve credentials for a pre-%s operation', async state => {
    const controller = new AbortController();
    controller.abort(new Error('private abort reason'));
    const token = vi.fn(async () => ({ secret: 'private-token' }));
    const fetch = vi.fn<Parameters<typeof globalThis.fetch>, ReturnType<typeof globalThis.fetch>>();
    const options = state === 'aborted' ? { signal: controller.signal } : { deadlineAt: Date.now() - 1 };
    await expect(new KnowledgeBaseProvider({ endpoint, token, fetch }).gather(query, options)).rejects.toThrow(state === 'aborted' ? /^Knowledge base request cancelled$/ : /deadline exceeded/);
    expect(token).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['deadline', 'timeout'])('bounds authenticated HTTP body reads by the %s', async bound => {
    vi.useFakeTimers();
    try {
      const token = async () => {
        if (bound === 'deadline') await new Promise(resolve => setTimeout(resolve, 20));
        return { secret: 'private-token' };
      };
      const fetch = vi.fn<Parameters<typeof globalThis.fetch>, ReturnType<typeof globalThis.fetch>>().mockImplementation(async () => new Response(new ReadableStream()));
      const provider = new KnowledgeBaseProvider({ endpoint, token, fetch, timeoutMs: bound === 'deadline' ? 100 : 25 });
      const pending = provider.gather(query, bound === 'deadline' ? { deadlineAt: Date.now() + 25 } : undefined);
      const rejected = expect(pending).rejects.toThrow(/^Provider HTTP request timed out$/);
      if (bound === 'deadline') {
        await vi.advanceTimersByTimeAsync(20);
        expect(fetch).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(5);
      } else await vi.advanceTimersByTimeAsync(25);
      await rejected;
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(['transport', 'redirect', 'unauthorized'])('does not expose tokens from %s errors or follow redirects', async failure => {
    const fetch = vi.fn<Parameters<typeof globalThis.fetch>, ReturnType<typeof globalThis.fetch>>().mockImplementation(async () => {
      if (failure === 'transport') throw new Error('Bearer private-token');
      return new Response('Bearer private-token', { status: failure === 'redirect' ? 302 : 401, headers: { location: 'https://other.example/?secret=private-token' } });
    });
    const pending = new KnowledgeBaseProvider({ endpoint, token: 'private-token', fetch }).gather(query);
    await expect(pending).rejects.toThrow(failure === 'transport' ? /^Provider HTTP transport failed$/ : new RegExp(`^Provider HTTP request failed \\(${failure === 'redirect' ? 302 : 401}\\)$`));
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1]?.redirect).toBe('error');
  });

  it('sanitizes abort reasons after the authenticated HTTP request starts', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<Parameters<typeof globalThis.fetch>, ReturnType<typeof globalThis.fetch>>().mockImplementation(async () => {
      controller.abort(new Error('Bearer private-token'));
      throw new Error('Bearer private-token');
    });
    await expect(new KnowledgeBaseProvider({ endpoint, token: 'private-token', fetch }).gather(query, { signal: controller.signal })).rejects.toThrow(/^Knowledge base request cancelled$/);
    expect(fetch).toHaveBeenCalledOnce();
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
