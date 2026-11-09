import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import { buildEvidencePack, loadEvidencePack, redactEvidenceText, saveEvidencePack, validateEvidencePack, type EvidenceSourceInput } from './evidence.js';
import { buildAnalysisPrompt } from './analysis.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture(content: string, format: EvidenceSourceInput['format'] = 'jsonl') {
  const root = await fs.mkdtemp(join(tmpdir(), 'afk-learning-evidence-'));
  roots.push(root);
  const path = join(root, `session.${format}`);
  await fs.writeFile(path, content);
  return { id: 'session-1', kind: 'session', path, allowedRoot: root, format } satisfies EvidenceSourceInput;
}
const message = (content: string) => JSON.stringify({ type: 'user', timestamp: '2026-11-09T00:00:00Z', message: { content } });

describe('bounded immutable evidence', () => {
  it('removes accounts, email, IP addresses and forward slash Windows paths from both pack and prompt', async () => {
    const sensitive = 'username=alice@example.com host=10.23.45.67 cwd=C:/Users/alice/project';
    const source = await fixture(message(sensitive));
    const pack = await buildEvidencePack({ sources: [source] });
    const prompt = buildAnalysisPrompt(pack, { version: 1, scope: 'github:acme/api', sourceId: source.id, evidenceDigest: pack.digest, analyzerVersion: '1', reason: 'import' });
    for (const value of [JSON.stringify(pack), prompt]) {
      for (const original of ['alice@example.com', '10.23.45.67', 'C:/Users/alice/project']) expect(value).not.toContain(original);
    }
    expect(redactEvidenceText('username=alice login=bob account=carol')).not.toMatch(/alice|bob|carol/);
    expect(redactEvidenceText('contact alice@example.com')).not.toContain('alice@example.com');
    expect(redactEvidenceText(sensitive)).toBe(redactEvidenceText(redactEvidenceText(sensitive)));
  });

  it.each(['2001:db8:85a3::8a2e:370:7334', '[2001:db8::1]:443', '::1', '::ffff:10.23.45.67', 'fe80::1%en0'])('removes IPv6 addresses without damaging relative API routes: %s', address => {
    const output = redactEvidenceText(`host=${address} route=api/v1/orders route=v2/users/{id} GET /api/v1/orders`);
    expect(output).not.toContain(address);
    expect(output).toContain('api/v1/orders');
    expect(output).toContain('v2/users/{id}');
    expect(output).toContain('GET /api/v1/orders');
    expect(redactEvidenceText(output)).toBe(output);
    expect(redactEvidenceText('version=1.2.3 invalid=999.999.999.999')).toBe('version=1.2.3 invalid=999.999.999.999');
  });

  it.each(['host:2001:db8::1', 'remote_addr:fe80::1%en0'])('removes IPv6 immediately following a field label: %s', input => {
    expect(redactEvidenceText(input)).toBe(input.slice(0, input.indexOf(':') + 1) + '[redacted:ip]');
  });

  it('removes structured account fields without erasing business names and API routes', async () => {
    const source = await fixture(JSON.stringify({ role: 'user', content: [{ type: 'tool_result', content: {
      username: 'alice', account_id: 'employee-42', email: 'bob@example.com', host: '10.23.45.67', cwd: 'C:/Users/alice/project',
      product_name: 'checkout', route: 'api/v1/orders',
    } }] }));
    const pack = await buildEvidencePack({ sources: [source] });
    const output = JSON.stringify(pack);
    for (const original of ['alice', 'employee-42', 'bob@example.com', '10.23.45.67', 'C:/Users']) expect(output).not.toContain(original);
    expect(output).toContain('checkout');
    expect(output).toContain('api/v1/orders');
  });

  it('normalizes Claude messages, keeps positions and digests, freezes all nested values', async () => {
    const source = await fixture(`${JSON.stringify({ type: 'system', cwd: '/private/repository' })}\n\n${message('confirmed rule')}\n`);
    const pack = await buildEvidencePack({ sources: [{ ...source, provider: 'claude-code' }] });
    expect(pack.completeness).toBe('complete');
    expect(pack.entries).toHaveLength(1);
    expect(pack.entries[0].position).toEqual({ sourceId: 'session-1', messageIndex: 1, line: 3, timestamp: '2026-11-09T00:00:00Z' });
    expect(pack.sources[0].sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(pack.entries[0].ref.locator).toBe('source:session-1/messages/1');
    expect(Object.isFrozen(pack.entries[0].ref)).toBe(true);
    expect(Object.isFrozen(pack.sources)).toBe(true);
    expect(JSON.stringify(pack)).not.toContain(source.allowedRoot);
    expect(validateEvidencePack(JSON.parse(JSON.stringify(pack)))).toEqual(pack);
  });

  it('marks malformed JSONL and missing sources partial without inventing evidence', async () => {
    const source = await fixture(`${message('survives')}\n{"type":`);
    const pack = await buildEvidencePack({ sources: [source, { ...source, id: 'missing', path: join(source.allowedRoot, 'missing.jsonl') }] });
    expect(pack.completeness).toBe('partial');
    expect(pack.entries).toHaveLength(1);
    expect(pack.entries[0].ref.completeness).toBe('partial');
    expect(pack.warnings).toEqual(expect.arrayContaining(['session-1:malformed-jsonl', 'missing:missing']));
  });

  it('redacts credentials, private keys, signed URLs and private paths before hashing', async () => {
    const source = await fixture(message('password="hunter2"\nclient_secret=supersecret\nAuthorization: Basic dXNlcjpwYXNz\nhttps://user:pass@host/download?X-Amz-Signature=abc&access_token=xyz\n-----BEGIN PRIVATE KEY-----\nkeymaterial\n-----END PRIVATE KEY-----\n/private/repository/file.ts C:\\Users\\private\\file.ts'));
    const pack = await buildEvidencePack({ sources: [source] });
    const serialized = JSON.stringify(pack);
    for (const secret of ['hunter2', 'supersecret', 'dXNlcjpwYXNz', 'user:pass', 'abc', 'xyz', 'keymaterial', '/private/repository', 'C:\\\\Users']) expect(serialized).not.toContain(secret);
    expect(serialized).toContain('[redacted');
  });

  it.each([
    'password="hunter2"', 'client_secret=supersecret', 'Authorization: Basic dXNlcjpwYXNz',
    'https://host/download?access_token=xyz', '-----BEGIN PRIVATE KEY-----\nkeymaterial\n-----END PRIVATE KEY-----',
    '/private/repository/file.ts', 'C:\\Users\\private\\file.ts',
  ])('redacts each credential form independently and idempotently: %s', async secret => {
    const pack = await buildEvidencePack({ sources: [await fixture(message(secret))] });
    expect(pack.entries[0].content).toContain('[redacted');
    expect(validateEvidencePack(pack)).toEqual(pack);
  });

  it('keeps missing authorized roots partial and rejects unsafe limits and source identities', async () => {
    const source = await fixture(message('ok'));
    const pack = await buildEvidencePack({ sources: [{ ...source, allowedRoot: join(source.allowedRoot, 'gone'), path: join(source.allowedRoot, 'gone', 'session.jsonl') }] });
    expect(pack.completeness).toBe('partial');
    await expect(buildEvidencePack({ sources: [source], maxBytes: 1024 * 1024 })).rejects.toThrow();
    await expect(buildEvidencePack({ sources: [{ ...source, id: `sk-${'a'.repeat(32)}` }] })).rejects.toThrow();
    await expect(buildEvidencePack({ sources: [{ ...source, kind: 'audit' }] })).rejects.toThrow(/runId/);
  });

  it('requires explicit message shards for oversized sources, never truncates a pack', async () => {
    const source = await fixture(Array.from({ length: 4 }, () => message('a'.repeat(2400))).join('\n'));
    await expect(buildEvidencePack({ sources: [source], maxBytes: 6000 })).rejects.toThrow(/range|shard/i);
    const pack = await buildEvidencePack({ sources: [{ ...source, range: { start: 2, end: 2 } }], maxBytes: 6000 });
    expect(pack.entries).toHaveLength(1);
    expect(pack.entries[0].position.messageIndex).toBe(2);
    expect(pack.completeness).toBe('partial');
    expect(Buffer.byteLength(JSON.stringify(pack))).toBeLessThanOrEqual(6000);
    await expect(buildEvidencePack({ sources: [{ ...source, range: { start: 1, end: 4 } }], maxBytes: 6000 })).rejects.toThrow(/limit|large/i);
    await expect(buildEvidencePack({ sources: [{ ...source, range: { start: 0, end: 1 } }] })).rejects.toThrow();
  });

  it('blocks sources above the Wiki reader hard limit even when an explicit range is supplied', async () => {
    const source = await fixture('');
    await fs.truncate(source.path, 64 * 1024 * 1024 + 1);
    await expect(buildEvidencePack({ sources: [{ ...source, range: { start: 1, end: 1 } }] })).rejects.toThrow(/safety limit/i);
  });

  it('rejects path traversal, sibling prefixes and symlinks even with a source ID', async () => {
    const source = await fixture(message('ok'));
    const outside = await fixture(message('private'));
    await expect(buildEvidencePack({ sources: [{ ...source, path: outside.path }] })).rejects.toThrow(/path|root/i);
    await fs.symlink(outside.path, join(source.allowedRoot, 'link.jsonl'));
    await expect(buildEvidencePack({ sources: [{ ...source, path: join(source.allowedRoot, 'link.jsonl') }] })).rejects.toThrow(/path|symbolic/i);
    await expect(buildEvidencePack({ sources: [{ ...source, path: join(source.allowedRoot, '..', 'outside.jsonl') }] })).rejects.toThrow(/path|root/i);
  });

  it('detects replaced source files and reuses saved snapshots after deletion', async () => {
    const source = await fixture(message('original'));
    const pack = await buildEvidencePack({ sources: [source] });
    const directory = join(source.allowedRoot, 'snapshots');
    await saveEvidencePack(directory, pack);
    await fs.writeFile(source.path, message('replacement'));
    await expect(buildEvidencePack({ sources: [{ ...source, expectedDigest: pack.sources[0].sourceDigest }] })).rejects.toThrow(/replaced|digest/i);
    await fs.unlink(source.path);
    expect(await loadEvidencePack(directory, pack.digest)).toEqual(pack);
    const tampered = JSON.parse(await fs.readFile(join(directory, `${pack.digest}.json`), 'utf8'));
    tampered.entries[0].content = 'modified';
    await fs.writeFile(join(directory, `${pack.digest}.json`), JSON.stringify(tampered));
    await expect(loadEvidencePack(directory, pack.digest)).rejects.toThrow(/digest/i);
    await expect(loadEvidencePack(directory, '../escape')).rejects.toThrow();
  });

  it('rejects replacement during a read instead of trusting the previously opened inode', async () => {
    const source = await fixture(message('original'));
    const replacement = join(source.allowedRoot, 'replacement.jsonl');
    await fs.writeFile(replacement, message('replacement'));
    const lstat = fs.lstat.bind(fs);
    let checks = 0;
    vi.spyOn(fs, 'lstat').mockImplementation(async path => {
      if (path === source.path && checks++ === 1) await fs.rename(replacement, source.path);
      return lstat(path);
    });
    await expect(buildEvidencePack({ sources: [source] })).rejects.toThrow(/replaced/i);
  });

  it('keeps tool results as untrusted evidence and redacts nested credential fields', async () => {
    const source = await fixture([
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":"run"}', call_id: 'c1' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'client_secret=hidden' } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: { api_key: { value: 'nested-secret' }, input_tokens: 1234 } }] } }),
    ].join('\n'));
    const pack = await buildEvidencePack({ sources: [source] });
    expect(pack.entries).toHaveLength(3);
    expect(pack.entries[1].ref.kind).toBe('tool-result');
    expect(pack.entries[1].content).toContain('untrusted');
    expect(JSON.stringify(pack)).not.toContain('nested-secret');
    expect(JSON.stringify(pack)).not.toContain('hidden');
    expect(JSON.stringify(pack)).toContain('1234');
  });

  it('binds message ranges and completeness into the pack digest', async () => {
    const source = await fixture(`${message('same')}\n${message('same')}`);
    const first = await buildEvidencePack({ sources: [{ ...source, range: { start: 1, end: 1 } }] });
    const second = await buildEvidencePack({ sources: [{ ...source, range: { start: 2, end: 2 } }] });
    expect(first.digest).not.toBe(second.digest);
    const altered = JSON.parse(JSON.stringify(first));
    altered.completeness = 'complete';
    expect(() => validateEvidencePack(altered)).toThrow();
  });

  it.each(['codex', 'json', 'mapping', 'opencode', 'text'])('normalizes explicitly imported %s exports', async kind => {
    const content = kind === 'codex' ? JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'rule' }] } })
      : kind === 'json' ? JSON.stringify({ messages: [{ role: 'assistant', content: 'rule' }] })
      : kind === 'mapping' ? JSON.stringify({ mapping: { first: { message: { author: { role: 'assistant' }, content: { parts: ['rule'] } } } } })
      : kind === 'opencode' ? JSON.stringify({ messages: [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'rule' }] }] }) : 'rule';
    const source = await fixture(content, kind === 'text' ? 'text' : kind === 'codex' ? 'jsonl' : 'json');
    const pack = await buildEvidencePack({ sources: [source] });
    expect(pack.entries).toHaveLength(1);
    expect(pack.entries[0].content).toContain('rule');
  });

  it('verifies managed audit sequence using the existing event store', async () => {
    const source = await fixture('');
    const store = new JsonlEventStore({ root: source.allowedRoot });
    await store.append([{ id: 'e1', schemaVersion: 1, type: 'agent.session_recorded', sequence: 0, occurredAt: '2026-11-09T00:00:00Z', context: { runId: 'run-1', traceId: 't', workItemId: 'w', profileId: 'p', attempt: 1, actor: { kind: 'system', id: 'test' } }, correlationId: 'run-1', data: { kind: 'agent.session_recorded', sessionId: 's1' } }]);
    const audit = { ...source, id: 'audit-1', kind: 'audit' as const, runId: 'run-1', path: join(source.allowedRoot, `${Buffer.from('run-1').toString('base64url')}.jsonl`) };
    const complete = await buildEvidencePack({ sources: [audit] });
    expect(complete.completeness).toBe('complete');
    expect(complete.entries[0].position.auditSequence).toBe(1);
    const original = await fs.readFile(audit.path, 'utf8');
    await fs.writeFile(audit.path, original.replace('s1', 's2'));
    const corrupt = await buildEvidencePack({ sources: [audit] });
    expect(corrupt.completeness).toBe('partial');
    expect(corrupt.warnings).toContain('audit-1:invalid-audit');
  });
});
