import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactSink } from '../../plugin-sdk/capabilities.js';
import {
  EvidenceBundleProvider,
  ObjectStorageProvider,
  ReportPlatformProvider,
  TestReportProvider,
  assertSafeArtifactName,
  nodeArtifactFileSystem,
  resolveWithinRoot,
  sha256Hex,
  type ArtifactFileSystem,
  type ArtifactSinkCapability,
} from './artifacts.js';
import type { FetchTransport } from './dependencies.js';

const roots: string[] = [];

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network request'); })); });

async function tempRoot(prefix: string): Promise<string> {
  const path = await fs.mkdtemp(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(path => fs.rm(path, { recursive: true, force: true })));
});

const bytesOf = (text: string): Uint8Array => Buffer.from(text, 'utf8');

/** Wraps the real filesystem and records every call, to assert write behaviour. */
function recordingFs(): { fs: ArtifactFileSystem; calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const track = (method: string, args: unknown[]): void => {
    calls.push({ method, args });
  };
  const adapter: ArtifactFileSystem = {
    async mkdir(path, options) {
      track('mkdir', [path, options]);
      return nodeArtifactFileSystem.mkdir(path, options);
    },
    async rename(from, to) {
      track('rename', [from, to]);
      return nodeArtifactFileSystem.rename(from, to);
    },
    async writeFile(path, data, options) {
      track('writeFile', [path, data, options]);
      return nodeArtifactFileSystem.writeFile(path, data, options);
    },
    async readFile(path) {
      track('readFile', [path]);
      return nodeArtifactFileSystem.readFile(path);
    },
    async readdir(path) {
      track('readdir', [path]);
      return nodeArtifactFileSystem.readdir(path);
    },
    async lstat(path) {
      track('lstat', [path]);
      return nodeArtifactFileSystem.lstat(path);
    },
  };
  return { fs: adapter, calls };
}

/** A fetch transport that records requests and answers from a handler. */
function fakeTransport(handler: (url: string, init: RequestInit) => Response): {
  transport: FetchTransport;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport = (async (input: unknown, init: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as FetchTransport;
  return { transport, calls };
}

function json(response: unknown, status = 200): Response {
  return new Response(JSON.stringify(response), { status, headers: { 'content-type': 'application/json' } });
}

/** Asserts a sink only advertises the write capability it truly implements. */
function expectOnlyWrite(sink: ArtifactSink): void {
  const record = sink.capabilities as Readonly<Record<ArtifactSinkCapability, boolean>>;
  expect(record.write).toBe(true);
}

describe('assertSafeArtifactName / resolveWithinRoot', () => {
  it('accepts a normal single-segment name', () => {
    expect(assertSafeArtifactName('report-1.json')).toBe('report-1.json');
  });

  it.each(['../evil', 'sub/dir', '..\\evil', '.hidden', '', 'a\0b'])('rejects unsafe name %j', name => {
    expect(() => assertSafeArtifactName(name)).toThrow(/unsafe artifact name/);
  });

  it('rejects a relative path that escapes the root', () => {
    expect(() => resolveWithinRoot('/srv/artifacts', '../outside')).toThrow(/escapes the configured root/);
  });

  it('keeps a normal path inside the root', () => {
    expect(resolveWithinRoot('/srv/artifacts', 'a.txt')).toBe('/srv/artifacts/a.txt');
  });
});

describe('TestReportProvider', () => {
  it('checks a missing root without creating it and initializes it only on put', async () => {
    const parent = await tempRoot('afk-report-health-');
    const root = join(parent, 'missing', 'reports');
    const { fs: adapter, calls } = recordingFs();
    const provider = new TestReportProvider({ root, fs: adapter });
    expect(await provider.health()).toMatchObject({ status: 'degraded' });
    expect(calls.map(call => call.method)).toEqual(['lstat']);
    await expect(fs.lstat(join(parent, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
    await provider.put({ name: 'report.json', mediaType: 'application/json', bytes: bytesOf('durable report') });
    expect(await fs.readFile(join(root, 'report.json'), 'utf8')).toBe('durable report');
    expect((await provider.health()).status).toBe('ok');
  });

  it('reports unreadable roots safely without trying to initialize them', async () => {
    const mkdir = vi.fn(async () => { throw new Error('private mkdir failure'); });
    const provider = new TestReportProvider({ root: '/private/report-root', fs: {
      ...nodeArtifactFileSystem, mkdir,
      lstat: async () => { throw Object.assign(new Error('secret=private-health-detail'), { code: 'EACCES' }); },
    } });
    const result = await provider.health();
    expect(result.status).toBe('unavailable');
    expect(JSON.stringify(result)).not.toMatch(/private|secret|EACCES/);
    expect(mkdir).not.toHaveBeenCalled();
  });

  it('rejects file and symlink roots during read-only health checks', async () => {
    const root = await tempRoot('afk-report-health-');
    const file = join(root, 'file');
    const linked = join(root, 'linked');
    await fs.writeFile(file, 'unchanged');
    await fs.symlink(root, linked);
    for (const target of [file, linked]) {
      expect((await new TestReportProvider({ root: target }).health()).status).toBe('unavailable');
    }
    expect(await fs.readFile(file, 'utf8')).toBe('unchanged');
    expect((await fs.lstat(linked)).isSymbolicLink()).toBe(true);
  });

  it('persists bytes and reads them back', async () => {
    const root = await tempRoot('afk-report-');
    const provider = new TestReportProvider({ root });
    const bytes = bytesOf('passed: 42');
    const ref = await provider.put({ name: 'report.json', mediaType: 'application/json', bytes });
    expect(ref.name).toBe('report.json');
    expect(ref.uri).toMatch(/^file:\/\//);
    expect((await provider.read('report.json')).toString()).toBe('passed: 42');
    expect(await fs.readFile(join(root, 'report.json'))).toEqual(Buffer.from(bytes));
    expect(await provider.list()).toEqual(['report.json']);
    expectOnlyWrite(provider);
  });

  it('writes atomically via a temp file and renames into place with 0600', async () => {
    const root = await tempRoot('afk-report-');
    const { fs: adapter, calls } = recordingFs();
    const provider = new TestReportProvider({ root, fs: adapter });
    await provider.put({ name: 'r.txt', mediaType: 'text/plain', bytes: bytesOf('x') });

    const write = calls.find(call => call.method === 'writeFile')!;
    const rename = calls.find(call => call.method === 'rename')!;
    const tempPath = write.args[0] as string;
    const finalPath = join(root, 'r.txt');
    // The temp file sits beside the target with a unique suffix, written 0600.
    expect(tempPath.startsWith(`${root}/.artifact.tmp-`)).toBe(true);
    expect(tempPath.slice(root.length + 1)).toMatch(/^\.artifact\.tmp-\d+-[0-9a-f]+$/);
    expect(write.args[1]).toEqual(Buffer.from('x'));
    expect(write.args[2]).toEqual({ mode: 0o600 });
    // ...and is renamed atomically onto the final path.
    expect(rename.args[0]).toBe(tempPath);
    expect(rename.args[1]).toBe(finalPath);
    // No temp leftover remains after the rename.
    expect(await provider.list()).toEqual(['r.txt']);
  });

  it('rejects traversal names and writes nothing', async () => {
    const root = await tempRoot('afk-report-');
    const provider = new TestReportProvider({ root });
    for (const name of ['../escaped', 'nested/file', '..\\win']) {
      await expect(
        provider.put({ name, mediaType: 'text/plain', bytes: bytesOf('nope') }),
      ).rejects.toThrow(/unsafe artifact name/);
    }
    expect(await provider.list()).toEqual([]);
  });

  it('refuses to write through a symlink planted at the target', async () => {
    const root = await tempRoot('afk-report-');
    const victim = await tempRoot('afk-victim-');
    await fs.writeFile(join(victim, 'secret'), 'do not clobber', 'utf8');
    await fs.symlink(join(victim, 'secret'), join(root, 'report.json'));
    const provider = new TestReportProvider({ root });
    await expect(
      provider.put({ name: 'report.json', mediaType: 'text/plain', bytes: bytesOf('pwn') }),
    ).rejects.toThrow(/symbolic link/);
    // The symlink target was untouched.
    expect(await fs.readFile(join(victim, 'secret'), 'utf8')).toBe('do not clobber');
  });

  it('rejects an empty mediaType', async () => {
    const root = await tempRoot('afk-report-');
    const provider = new TestReportProvider({ root });
    await expect(
      provider.put({ name: 'r.txt', mediaType: '', bytes: bytesOf('x') }),
    ).rejects.toThrow(/mediaType is required/);
  });

  it('honours cancellation', async () => {
    const root = await tempRoot('afk-report-');
    const provider = new TestReportProvider({ root });
    const controller = new AbortController();
    controller.abort(new Error('caller gave up'));
    await expect(
      provider.put({ name: 'r.txt', mediaType: 'text/plain', bytes: bytesOf('x') }, { signal: controller.signal }),
    ).rejects.toThrow('caller gave up');
    expect(await provider.list()).toEqual([]);
  });
});

describe('EvidenceBundleProvider', () => {
  it('produces a deterministic bundle with correct SHA-256 metadata', async () => {
    const stored: Array<{ name: string; mediaType: string; bytes: Uint8Array }> = [];
    const sink: ArtifactSink = {
      id: 'capture',
      capabilities: { write: true, read: false, list: false },
      put: async artifact => {
        stored.push(artifact);
        return { uri: `mem://${artifact.name}`, name: artifact.name };
      },
    };
    const provider = new EvidenceBundleProvider(sink);
    const records = [
      { id: 'b', mediaType: 'text/plain', bytes: bytesOf('second') },
      { id: 'a', mediaType: 'application/json', bytes: bytesOf('{"ok":true}') },
    ];
    const { ref, bundle } = await provider.create({ name: 'evidence.json', records });

    expect(ref).toEqual({ uri: 'mem://evidence.json', name: 'evidence.json' });
    expect(bundle.recordCount).toBe(2);
    expect(bundle.totalBytes).toBe(bytesOf('second').byteLength + bytesOf('{"ok":true}').byteLength);
    expect(bundle.records.map(record => record.id)).toEqual(['a', 'b']);
    expect(bundle.records[0].sha256).toBe(sha256Hex(bytesOf('{"ok":true}')));

    // The stored bytes are the JSON bundle and match the metadata.
    const storedArtifact = stored[0];
    expect(storedArtifact.mediaType).toBe('application/json');
    const parsed = JSON.parse(Buffer.from(storedArtifact.bytes).toString('utf8'));
    expect(parsed.bundleSha256).toBe(bundle.bundleSha256);
  });

  it('is byte-identical regardless of input ordering', async () => {
    const sink: ArtifactSink = {
      id: 'capture',
      capabilities: { write: true, read: false, list: false },
      put: async artifact => ({ uri: `mem://${artifact.name}`, name: artifact.name }),
    };
    const provider = new EvidenceBundleProvider(sink);
    const base = [
      { id: 'x', mediaType: 'text/plain', bytes: bytesOf('x') },
      { id: 'y', mediaType: 'text/plain', bytes: bytesOf('y') },
      { id: 'z', mediaType: 'text/plain', bytes: bytesOf('z') },
    ];
    const first = await provider.create({ name: 'e.json', records: base });
    const second = await provider.create({ name: 'e.json', records: [...base].reverse() });
    expect(second.bundle).toEqual(first.bundle);
    expect(second.bundle.bundleSha256).toBe(first.bundle.bundleSha256);
  });

  it('does not copy secret bytes into the bundle, only digests', async () => {
    let captured = '';
    const sink: ArtifactSink = {
      id: 'capture',
      capabilities: { write: true, read: false, list: false },
      put: async artifact => {
        captured = Buffer.from(artifact.bytes).toString('utf8');
        return { uri: 'mem://e', name: artifact.name };
      },
    };
    const secret = 'ghp_0123456789abcdefghijklmnopqrstuv';
    const provider = new EvidenceBundleProvider(sink);
    await provider.create({ name: 'e.json', records: [{ id: 's', mediaType: 'text/plain', bytes: bytesOf(secret) }] });
    expect(captured).not.toContain(secret);
  });

  it('honours cancellation before calling the sink', async () => {
    let called = false;
    const sink: ArtifactSink = {
      id: 'capture',
      capabilities: { write: true, read: false, list: false },
      put: async () => {
        called = true;
        return { uri: 'mem://e', name: 'e' };
      },
    };
    const provider = new EvidenceBundleProvider(sink);
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(
      provider.create({ name: 'e.json', records: [] }, { signal: controller.signal }),
    ).rejects.toThrow('stop');
    expect(called).toBe(false);
  });
});

describe('ObjectStorageProvider', () => {
  const artifact = { name: 'coverage.lcov', mediaType: 'text/plain', bytes: bytesOf('SF:src/a.ts') };

  it('PUTs bytes to an injected presigned URL and returns the reported uri', async () => {
    const { transport, calls } = fakeTransport(() => json({ uri: 'https://objects.example/coverage.lcov' }));
    const provider = new ObjectStorageProvider({
      transport,
      resolveUrl: () => 'https://objects.example/presigned?sig=abc',
    });
    const ref = await provider.put(artifact);
    expect(ref).toEqual({ uri: 'https://objects.example/coverage.lcov', name: 'coverage.lcov' });
    const request = calls[0];
    expect(request.init.method).toBe('PUT');
    expect((request.init.headers as Record<string, string>)['content-type']).toBe('text/plain');
    expect(Buffer.from(request.init.body as Uint8Array).toString()).toBe('SF:src/a.ts');
  });

  it('falls back to the endpoint location and strips any presigned query', async () => {
    const { transport } = fakeTransport(() => new Response('', { status: 200 }));
    const provider = new ObjectStorageProvider({
      transport,
      resolveUrl: () => 'https://objects.example/bucket/coverage.lcov?X-Amz-Signature=secret',
    });
    const ref = await provider.put(artifact);
    expect(ref.uri).toBe('https://objects.example/bucket/coverage.lcov');
  });

  it('uses endpoint + encoded name when no resolver is given', async () => {
    const { transport, calls } = fakeTransport(() => new Response('', { status: 200 }));
    const provider = new ObjectStorageProvider({ transport, endpoint: 'https://objects.example/bucket' });
    await provider.put(artifact);
    expect(calls[0].url).toBe('https://objects.example/bucket/coverage.lcov');
  });

  it('throws on a non-ok response', async () => {
    const { transport } = fakeTransport(() => new Response('denied', { status: 403 }));
    const provider = new ObjectStorageProvider({ transport, endpoint: 'https://objects.example/bucket' });
    await expect(provider.put(artifact)).rejects.toThrow(/failed \(403\)/);
  });

  it('uses default fetch only when uploading, with configuration-only health', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const provider = new ObjectStorageProvider({ endpoint: 'https://objects.example/bucket' });
    expect((await provider.health()).status).toBe('ok');
    expect(fetch).not.toHaveBeenCalled();
    expect((await provider.put(artifact)).uri).toBe('https://objects.example/bucket/coverage.lcov');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('requires an endpoint or resolver', async () => {
    const { transport } = fakeTransport(() => new Response('', { status: 200 }));
    const provider = new ObjectStorageProvider({ transport });
    await expect(provider.put(artifact)).rejects.toThrow(/requires an endpoint or a presigned URL resolver/);
  });

  it('honours cancellation before any request', async () => {
    const { transport, calls } = fakeTransport(() => new Response('', { status: 200 }));
    const provider = new ObjectStorageProvider({ transport, endpoint: 'https://objects.example/bucket' });
    const controller = new AbortController();
    controller.abort(new Error('nope'));
    await expect(provider.put(artifact, { signal: controller.signal })).rejects.toThrow('nope');
    expect(calls).toEqual([]);
  });
});

describe('ReportPlatformProvider', () => {
  const artifact = { name: 'report.html', mediaType: 'text/html', bytes: bytesOf('<h1>ok</h1>') };
  const endpoint = 'https://reports.example/upload';

  it('POSTs the raw artifact with a Content-Type and validates the returned URI', async () => {
    const { transport, calls } = fakeTransport(() => json({ uri: 'https://reports.example/r/123' }));
    const provider = new ReportPlatformProvider({ transport, endpoint, token: 't0k' });
    const ref = await provider.put(artifact);
    expect(ref).toEqual({ uri: 'https://reports.example/r/123', name: 'report.html' });
    const request = calls[0];
    expect(request.url).toBe(endpoint);
    expect(request.init.method).toBe('POST');
    expect((request.init.headers as Record<string, string>)['content-type']).toBe('text/html');
    expect((request.init.headers as Record<string, string>).authorization).toBe('Bearer t0k');
    expect(Buffer.from(request.init.body as Uint8Array).toString()).toBe('<h1>ok</h1>');
  });

  it('rejects a response without a valid HTTP(S) URI', async () => {
    const { transport } = fakeTransport(() => json({ id: 123 }));
    const provider = new ReportPlatformProvider({ transport, endpoint });
    await expect(provider.put(artifact)).rejects.toThrow(/did not return a valid artifact URI/);
  });

  it('rejects a non-http returned value', async () => {
    const { transport } = fakeTransport(() => json({ uri: 'javascript:alert(1)' }));
    const provider = new ReportPlatformProvider({ transport, endpoint });
    await expect(provider.put(artifact)).rejects.toThrow(/did not return a valid artifact URI/);
  });

  it('rejects a non-ok response', async () => {
    const { transport } = fakeTransport(() => new Response('boom', { status: 500 }));
    const provider = new ReportPlatformProvider({ transport, endpoint });
    await expect(provider.put(artifact)).rejects.toThrow(/failed \(500\)/);
  });

  it('uses default fetch only when uploading, with configuration-only health', async () => {
    const fetch = vi.fn(async () => json({ uri: 'https://reports.example/r/1' }));
    vi.stubGlobal('fetch', fetch);
    const provider = new ReportPlatformProvider({ endpoint });
    expect((await provider.health()).status).toBe('ok');
    expect(fetch).not.toHaveBeenCalled();
    expect((await provider.put(artifact)).uri).toBe('https://reports.example/r/1');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('honours cancellation', async () => {
    const { transport, calls } = fakeTransport(() => json({ uri: 'https://reports.example/r/1' }));
    const provider = new ReportPlatformProvider({ transport, endpoint });
    const controller = new AbortController();
    controller.abort(new Error('halt'));
    await expect(provider.put(artifact, { signal: controller.signal })).rejects.toThrow('halt');
    expect(calls).toEqual([]);
  });
});

describe('artifact capability and failure boundaries', () => {
  const artifact = { name: 'report.json', mediaType: 'application/json', bytes: bytesOf('{}') };

  it('lists only readable regular artifacts for its advertised read/list capabilities', async () => {
    const root = await tempRoot('report-list-');
    const provider = new TestReportProvider({ root });
    await provider.put(artifact);
    await fs.mkdir(join(root, 'directory'));
    await fs.writeFile(join(root, '.hidden'), 'x');
    await fs.writeFile(join(root, '.artifact.tmp-orphan'), 'x');
    await fs.symlink(join(root, artifact.name), join(root, 'linked.json'));
    expect(provider.capabilities).toEqual({ write: true, read: true, list: true });
    expect(await provider.list()).toEqual([artifact.name]);
    expect(await provider.read(artifact.name)).toEqual(Buffer.from(artifact.bytes));
    await expect(provider.read('linked.json')).rejects.toThrow(/symbolic link/);
  });

  it('propagates listing IO errors instead of reporting an empty artifact collection', async () => {
    const fsAdapter = { ...nodeArtifactFileSystem, readdir: async () => { throw new Error('denied'); } };
    const provider = new TestReportProvider({ root: '/unused', fs: fsAdapter });
    await expect(provider.list()).rejects.toThrow('denied');
  });

  it('lists legitimate names containing .tmp- while hiding internal temporary files', async () => {
    const root = await tempRoot('report-list-');
    const provider = new TestReportProvider({ root });
    await provider.put({ ...artifact, name: 'report.tmp-backup' });
    expect(await provider.list()).toEqual(['report.tmp-backup']);
  });

  it('registers evidence as an ArtifactSink and delegates put without changing bytes', async () => {
    const put = vi.fn<Parameters<ArtifactSink['put']>, ReturnType<ArtifactSink['put']>>(async artifact => ({ uri: 'mem://bundle', name: artifact.name }));
    const sink: ArtifactSink = new EvidenceBundleProvider({ id: 'storage', capabilities: { write: true, read: false, list: false }, put });
    const controller = new AbortController();
    const options = { signal: controller.signal };
    expect(sink.capabilities).toEqual({ write: true, read: false, list: false });
    expect(await sink.put(artifact, options)).toEqual({ uri: 'mem://bundle', name: artifact.name });
    expect(put).toHaveBeenCalledWith(artifact, options);
    put.mockRejectedValueOnce(new Error('storage failed'));
    await expect(sink.put(artifact)).rejects.toThrow('storage failed');
    controller.abort(new Error('cancel evidence'));
    await expect(sink.put(artifact, options)).rejects.toThrow('cancel evidence');
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('rejects evidence traversal before delegating to a sink', async () => {
    const put = vi.fn<Parameters<ArtifactSink['put']>, ReturnType<ArtifactSink['put']>>();
    const provider = new EvidenceBundleProvider({ id: 'storage', capabilities: { write: true, read: false, list: false }, put });
    await expect(provider.create({ name: '../escaped.json', records: [] })).rejects.toThrow(/unsafe/);
    expect(put).not.toHaveBeenCalled();
  });

  it('object storage and report platform advertise only implemented write capability', () => {
    const providers = [new ObjectStorageProvider({ endpoint: 'https://objects.example/bucket' }), new ReportPlatformProvider({ endpoint: 'https://reports.example/upload' })];
    for (const provider of providers) expect(provider.capabilities).toEqual({ write: true, read: false, list: false });
  });

  it('reports missing object storage configuration without any network operation', async () => {
    const provider = new ObjectStorageProvider({});
    expect((await provider.health()).status).toBe('unavailable');
    await expect(provider.put(artifact)).rejects.toThrow(/requires an endpoint/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('reports invalid endpoints and unavailable fetch without IO', async () => {
    const invalid = new ObjectStorageProvider({ endpoint: 'file:///unused' });
    expect((await invalid.health()).status).toBe('unavailable');
    vi.stubGlobal('fetch', undefined);
    const objectStorage = new ObjectStorageProvider({ endpoint: 'https://objects.example' });
    const report = new ReportPlatformProvider({ endpoint: 'https://reports.example' });
    expect((await objectStorage.health()).status).toBe('unavailable');
    expect((await report.health()).status).toBe('unavailable');
  });

  it('accepts a non-JSON object storage success acknowledgement and returns the canonical target', async () => {
    const { transport } = fakeTransport(() => new Response('<result>ok</result>'));
    const provider = new ObjectStorageProvider({ transport, resolveUrl: () => 'https://objects.example/report?signature=secret' });
    expect((await provider.put(artifact)).uri).toBe('https://objects.example/report');
  });

  it('propagates resolver failures without sending an upload', async () => {
    const transport = vi.fn(async () => new Response(''));
    const provider = new ObjectStorageProvider({ transport, resolveUrl: async () => { throw new Error('presign failed'); } });
    await expect(provider.put(artifact)).rejects.toThrow('presign failed');
    expect(transport).not.toHaveBeenCalled();
  });

  it('does not upload if cancellation happens while resolving a presigned URL', async () => {
    const controller = new AbortController();
    const transport = vi.fn(async () => new Response(''));
    const provider = new ObjectStorageProvider({ transport, resolveUrl: async () => {
      controller.abort(new Error('presign cancelled'));
      return 'https://objects.example/report';
    } });
    await expect(provider.put(artifact, { signal: controller.signal })).rejects.toThrow('presign cancelled');
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(['javascript:alert(1)', 'https://user:password@objects.example/report', 'https://'])('rejects invalid returned artifact URI %s', async uri => {
    const { transport } = fakeTransport(() => json({ uri }));
    await expect(new ObjectStorageProvider({ transport, endpoint: 'https://objects.example' }).put(artifact)).rejects.toThrow(/invalid artifact URI/);
    await expect(new ReportPlatformProvider({ transport, endpoint: 'https://reports.example' }).put(artifact)).rejects.toThrow(/valid artifact URI/);
  });

  it('strips signed query strings and fragments from reported references', async () => {
    const { transport } = fakeTransport(() => json({ uri: 'https://objects.example/report?signature=secret#secret' }));
    const objectStorage = new ObjectStorageProvider({ transport, endpoint: 'https://objects.example' });
    const report = new ReportPlatformProvider({ transport, endpoint: 'https://reports.example' });
    expect((await objectStorage.put(artifact)).uri).toBe('https://objects.example/report');
    expect((await report.put(artifact)).uri).toBe('https://objects.example/report');
  });

  it('rejects insecure report bearer transport before sending bytes', async () => {
    const transport = vi.fn(async () => new Response(''));
    const provider = new ReportPlatformProvider({ transport, endpoint: 'http://reports.example', token: 'secret' });
    expect((await provider.health()).status).toBe('unavailable');
    await expect(provider.put(artifact)).rejects.toThrow(/HTTPS/);
    expect(transport).not.toHaveBeenCalled();
  });
});
