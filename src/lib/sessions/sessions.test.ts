import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { FileSessionStore } from './file-store';
import { HandoffSessionStore } from './handoff-store';
import { SessionStoreChain, SessionCorruptError, SessionNotFoundError } from './types';
import { RunStateWriter } from './run-state';
import type { SessionSnapshot } from '../agents/types';

function makeSnapshot(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: 'sess-1',
    generation: 1,
    checkpoint: null,
    summary: 'agent finished AC 1-3',
    usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
    capturedAt: '2026-08-02T10:00:00.000Z',
    ...over,
  };
}

describe('FileSessionStore', () => {
  let wtPath: string;
  beforeEach(() => {
    wtPath = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-file-store-'));
  });
  afterEach(() => {
    fs.rmSync(wtPath, { recursive: true, force: true });
  });

  it('round-trips a snapshot with checksum', async () => {
    const store = new FileSessionStore(wtPath);
    const snap = makeSnapshot();
    const save = await store.save({ runId: 'issue-42-gen-1', provider: 'claude-code', snapshot: snap });

    expect(save.path).toMatch(/issue-42-gen-1\.json$/);
    expect(save.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(save.provider).toBe('claude-code');

    const loaded = await store.load({ runId: 'issue-42-gen-1' });
    expect(loaded.sessionId).toBe(snap.sessionId);
    expect(loaded.summary).toBe(snap.summary);
    expect(loaded.generation).toBe(1);
  });

  it('throws SessionNotFoundError on missing file', async () => {
    const store = new FileSessionStore(wtPath);
    await expect(store.load({ runId: 'issue-42-gen-1' })).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('throws SessionCorruptError on checksum mismatch (tampered snapshot)', async () => {
    const store = new FileSessionStore(wtPath);
    await store.save({ runId: 'issue-42-gen-1', provider: 'claude-code', snapshot: makeSnapshot() });

    // Tamper with the JSON file content but leave the sidecar alone.
    const filePath = path.join(wtPath, '.afk', 'sessions', 'issue-42-gen-1.json');
    const raw = fs.readFileSync(filePath, 'utf-8');
    const tampered = raw.replace('agent finished AC 1-3', 'TAMPERED');
    fs.writeFileSync(filePath, tampered, 'utf-8');

    await expect(store.load({ runId: 'issue-42-gen-1' })).rejects.toBeInstanceOf(SessionCorruptError);
  });

  it('throws SessionCorruptError on invalid JSON', async () => {
    const store = new FileSessionStore(wtPath);
    await store.save({ runId: 'issue-42-gen-1', provider: 'claude-code', snapshot: makeSnapshot() });

    const filePath = path.join(wtPath, '.afk', 'sessions', 'issue-42-gen-1.json');
    fs.writeFileSync(filePath, '{not json', 'utf-8');

    await expect(store.load({ runId: 'issue-42-gen-1' })).rejects.toBeInstanceOf(SessionCorruptError);
  });

  it('list returns saved snapshots, most recent first', async () => {
    const store = new FileSessionStore(wtPath);
    await store.save({ runId: 'issue-42-gen-1', provider: 'claude-code', snapshot: makeSnapshot({ capturedAt: '2026-08-02T10:00:00.000Z' }) });
    await store.save({ runId: 'issue-42-gen-2', provider: 'claude-code', snapshot: makeSnapshot({ capturedAt: '2026-08-02T11:00:00.000Z' }) });
    await store.save({ runId: 'issue-43-gen-1', provider: 'claude-code', snapshot: makeSnapshot({ capturedAt: '2026-08-02T12:00:00.000Z' }) });

    const all = await store.list();
    expect(all.map(e => e.runId)).toEqual(['issue-43-gen-1', 'issue-42-gen-2', 'issue-42-gen-1']);

    const only42 = await store.list({ provider: 'claude-code', limit: 2 });
    expect(only42.length).toBe(2);
  });

  it('supportsProvider is universal', () => {
    const store = new FileSessionStore(wtPath);
    expect(store.supportsProvider('claude-code')).toBe(true);
    expect(store.supportsProvider('unknown')).toBe(true);
  });
});

describe('HandoffSessionStore', () => {
  let wtPath: string;
  beforeEach(() => {
    wtPath = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-handoff-store-'));
    fs.mkdirSync(path.join(wtPath, '.afk', 'handoff'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(wtPath, { recursive: true, force: true });
  });

  it('load() reads existing handoff-{iid}-{gen}.md as SessionSnapshot', async () => {
    fs.writeFileSync(
      path.join(wtPath, '.afk', 'handoff', 'handoff-42-1.md'),
      '# Handoff 42 round 1\n\nsummary text',
      'utf-8',
    );
    const store = new HandoffSessionStore(wtPath);
    const snap = await store.load({ runId: 'issue-42-gen-1' });
    expect(snap.generation).toBe(1);
    expect(snap.checkpoint).toBeNull();
    expect(snap.summary).toContain('summary text');
  });

  it('load() terminal runId maps to handoff-{iid}-terminal.md', async () => {
    fs.writeFileSync(
      path.join(wtPath, '.afk', 'handoff', 'handoff-42-terminal.md'),
      'terminal doc',
      'utf-8',
    );
    const store = new HandoffSessionStore(wtPath);
    const snap = await store.load({ runId: 'issue-42-terminal' });
    expect(snap.summary).toContain('terminal doc');
    expect(snap.generation).toBe(0);
  });

  it('load() throws SessionNotFoundError when doc absent', async () => {
    const store = new HandoffSessionStore(wtPath);
    await expect(store.load({ runId: 'issue-99-gen-1' })).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('save() throws (read-only store)', async () => {
    const store = new HandoffSessionStore(wtPath);
    await expect(store.save({
      runId: 'issue-42-gen-1',
      provider: 'claude-code',
      snapshot: makeSnapshot(),
    })).rejects.toThrow(/read-only/);
  });

  it('list() enumerates handoff docs', async () => {
    fs.writeFileSync(path.join(wtPath, '.afk', 'handoff', 'handoff-42-1.md'), '#', 'utf-8');
    fs.writeFileSync(path.join(wtPath, '.afk', 'handoff', 'handoff-42-2.md'), '#', 'utf-8');
    fs.writeFileSync(path.join(wtPath, '.afk', 'handoff', 'handoff-42-terminal.md'), '#', 'utf-8');
    const store = new HandoffSessionStore(wtPath);
    const entries = await store.list();
    expect(entries.map(e => e.runId)).toContain('issue-42-gen-1');
    expect(entries.map(e => e.runId)).toContain('issue-42-gen-2');
    expect(entries.map(e => e.runId)).toContain('issue-42-terminal');
  });
});

describe('SessionStoreChain', () => {
  let wtPath: string;
  beforeEach(() => {
    wtPath = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-chain-'));
  });
  afterEach(() => {
    fs.rmSync(wtPath, { recursive: true, force: true });
  });

  it('loadFirst returns first store with a hit', async () => {
    fs.mkdirSync(path.join(wtPath, '.afk', 'handoff'), { recursive: true });
    fs.writeFileSync(path.join(wtPath, '.afk', 'handoff', 'handoff-42-1.md'), 'fallback doc', 'utf-8');

    const chain = new SessionStoreChain([
      new FileSessionStore(wtPath),
      new HandoffSessionStore(wtPath),
    ]);
    // No file snapshot saved; falls through to handoff-md store.
    const r = await chain.loadFirst({ runId: 'issue-42-gen-1' });
    expect(r?.storeName).toBe('handoff-md');
    expect(r?.snapshot.summary).toContain('fallback doc');
  });

  it('loadFirst returns null when every store misses', async () => {
    const chain = new SessionStoreChain([
      new FileSessionStore(wtPath),
      new HandoffSessionStore(wtPath),
    ]);
    const r = await chain.loadFirst({ runId: 'issue-99-gen-99' });
    expect(r).toBeNull();
  });

  it('loadFirst skips corrupt file store and falls back to handoff', async () => {
    fs.mkdirSync(path.join(wtPath, '.afk', 'sessions'), { recursive: true });
    // Write a file that LOOKS like a session JSON so FileSessionStore tries it
    // and discovers corruption on load.
    fs.writeFileSync(
      path.join(wtPath, '.afk', 'sessions', 'issue-42-gen-1.json'),
      '{not json',
      'utf-8',
    );
    fs.mkdirSync(path.join(wtPath, '.afk', 'handoff'), { recursive: true });
    fs.writeFileSync(path.join(wtPath, '.afk', 'handoff', 'handoff-42-1.md'), 'safe fallback', 'utf-8');

    const chain = new SessionStoreChain([
      new FileSessionStore(wtPath),
      new HandoffSessionStore(wtPath),
    ]);
    const r = await chain.loadFirst({ runId: 'issue-42-gen-1' });
    expect(r?.storeName).toBe('handoff-md');
    expect(r?.snapshot.summary).toContain('safe fallback');
  });

  it('saveFirst writes to first supporting store', async () => {
    const chain = new SessionStoreChain([
      new FileSessionStore(wtPath),
      new HandoffSessionStore(wtPath),
    ]);
    const result = await chain.saveFirst({
      runId: 'issue-42-gen-1',
      provider: 'claude-code',
      snapshot: makeSnapshot(),
    });
    expect(result.path).toContain('issue-42-gen-1.json');
  });
});

describe('RunStateWriter', () => {
  let wtPath: string;
  beforeEach(() => {
    wtPath = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-runstate-'));
  });
  afterEach(() => {
    fs.rmSync(wtPath, { recursive: true, force: true });
  });

  it('init creates the run directory', async () => {
    const w = new RunStateWriter(wtPath, 'issue-42-gen-1');
    await w.init();
    expect(fs.existsSync(path.join(wtPath, '.afk', 'runs', 'issue-42-gen-1'))).toBe(true);
  });

  it('writeRequest + writeResult + writeOutput persist files', async () => {
    const w = new RunStateWriter(wtPath, 'issue-42-gen-1');
    await w.init();
    await w.writeRequest({
      runId: 'issue-42-gen-1',
      iid: 42,
      generation: 1,
      provider: 'claude-code',
      agentTransport: 'app-server',
      agentAuth: 'chatgpt',
      agentModelProvider: 'openai',
      agentThreadId: 'thread-42',
      worktreePath: wtPath,
      goalText: 'do something',
      signalType: 'goal_complete',
      startedAt: new Date().toISOString(),
    });
    await w.writeResult({
      version: 1,
      runId: 'issue-42-gen-1',
      status: 'completed',
      provider: 'claude-code',
      commits: [],
    });
    await w.writeOutput('last line of pane capture');

    const dir = path.join(wtPath, '.afk', 'runs', 'issue-42-gen-1');
    expect(fs.existsSync(path.join(dir, 'request.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'request.json'), 'utf8'))).toMatchObject({
      agentTransport: 'app-server', agentAuth: 'chatgpt', agentModelProvider: 'openai', agentThreadId: 'thread-42',
    });
    expect(fs.existsSync(path.join(dir, 'result.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'result.json.sha256'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'output.log'))).toBe(true);
  });

  it('appendEvent writes JSONL lines', async () => {
    const w = new RunStateWriter(wtPath, 'issue-42-gen-1');
    await w.init();
    await w.appendEvent({ type: 'text', text: 'first' });
    await w.appendEvent({ type: 'text', text: 'second' });
    const content = fs.readFileSync(
      path.join(wtPath, '.afk', 'runs', 'issue-42-gen-1', 'events.jsonl'),
      'utf-8',
    );
    const lines = content.split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).text).toBe('first');
    expect(JSON.parse(lines[1]).text).toBe('second');
  });

  it('does not throw when underlying filesystem errors', async () => {
    const w = new RunStateWriter('/nonexistent/path/that/cannot/exist', 'issue-42-gen-1');
    // All methods must be best-effort — never throw.
    await expect(w.init()).resolves.toBeUndefined();
    await expect(w.writeRequest({
      runId: 'x', iid: 1, generation: 1, provider: 'p', worktreePath: 'x',
      goalText: 'g', signalType: 'goal_complete', startedAt: 'now',
    })).resolves.toBeUndefined();
  });
});
