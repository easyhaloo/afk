import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { promises as afs } from 'fs';
import { writeSignal } from '../core/io/signal';
import { readLegacySignalResult, unrecognizedSignalResult } from './legacy-compat';

describe('LegacyCompat — readLegacySignalResult', () => {
  let wtPath: string;

  beforeEach(() => {
    wtPath = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-legacy-compat-'));
  });
  afterEach(async () => {
    await afs.rm(wtPath, { recursive: true, force: true });
  });

  it('returns null when signal file absent', async () => {
    const r = await readLegacySignalResult(wtPath, 'r1');
    expect(r).toBeNull();
  });

  it('maps goal_complete signal to completed ExecutionResult', async () => {
    await writeSignal({ type: 'goal_complete', timestamp: '2026-08-02T00:00:00.000Z', summary: 'done' }, wtPath);
    const r = await readLegacySignalResult(wtPath, 'r1');
    expect(r).not.toBeNull();
    expect(r!.status).toBe('completed');
    expect(r!.runId).toBe('r1');
    expect(r!.version).toBe(1);
    expect(r!.provider).toBe('local');
    expect((r!.structuredOutput as { type: string }).type).toBe('goal_complete');
  });

  it('maps ac_result signal to completed ExecutionResult', async () => {
    await writeSignal({ type: 'ac_result', timestamp: '2026-08-02T00:00:00.000Z', summary: 'AC verified' }, wtPath);
    const r = await readLegacySignalResult(wtPath, 'r1');
    expect(r!.status).toBe('completed');
    expect((r!.structuredOutput as { type: string }).type).toBe('ac_result');
  });

  it('maps handoff_ready signal to failed ExecutionResult', async () => {
    await writeSignal({ type: 'handoff_ready', timestamp: '2026-08-02T00:00:00.000Z', summary: 'partial' }, wtPath);
    const r = await readLegacySignalResult(wtPath, 'r1');
    expect(r!.status).toBe('failed');
    // structuredOutput preserved for downstream (handoff doc generation).
    expect((r!.structuredOutput as { type: string }).type).toBe('handoff_ready');
  });

  it('preserves structuredOutput verbatim for downstream code', async () => {
    const payload = { type: 'goal_complete', timestamp: '2026-08-02T00:00:00.000Z', summary: 'agent finished AC 1-3' };
    await writeSignal(payload as Parameters<typeof writeSignal>[0], wtPath);
    const r = await readLegacySignalResult(wtPath, 'r1');
    expect(r!.structuredOutput).toEqual(payload);
  });

  it('returns null when signal file is corrupt (JSON parse fails)', async () => {
    fs.writeFileSync(path.join(wtPath, '.afk-signal.json'), '{not json', 'utf-8');
    const r = await readLegacySignalResult(wtPath, 'r1');
    expect(r).toBeNull();
  });

  it('returns null when signal schema is invalid', async () => {
    fs.writeFileSync(
      path.join(wtPath, '.afk-signal.json'),
      JSON.stringify({ wrong: 'shape' }),
      'utf-8',
    );
    const r = await readLegacySignalResult(wtPath, 'r1');
    expect(r).toBeNull();
  });

  it('always returns version: 1', async () => {
    await writeSignal({ type: 'goal_complete', timestamp: '2026-08-02T00:00:00.000Z', summary: 'd' }, wtPath);
    const r = await readLegacySignalResult(wtPath, 'r1');
    expect(r!.version).toBe(1);
  });
});

describe('LegacyCompat — unrecognizedSignalResult', () => {
  it('produces a failed result with the unrecognized type in error.message', () => {
    const r = unrecognizedSignalResult('r1', 'mystery');
    expect(r.status).toBe('failed');
    expect(r.runId).toBe('r1');
    expect(r.error?.code).toBe('unrecognized_signal_type');
    expect(r.error?.message).toContain('mystery');
  });
});

describe('LegacyCompat — compat round-trip (acceptance: 旧 worktree 可以被兼容读取)', () => {
  let wtPath: string;

  beforeEach(() => {
    wtPath = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-legacy-roundtrip-'));
  });
  afterEach(async () => {
    await afs.rm(wtPath, { recursive: true, force: true });
  });

  it('simulates a pre-Phase-8 worktree and verifies the file is still readable', async () => {
    // Simulate an old agent that wrote the signal file before Phase 8.
    // The Phase-8+ runner, reading via readLegacySignalResult, must still
    // surface this as a valid ExecutionResult so the workflow can complete.
    const oldSignal = {
      type: 'goal_complete',
      timestamp: '2026-07-15T12:00:00.000Z',
      summary: 'old worktree from before Phase 8',
    };
    await writeSignal(oldSignal, wtPath);

    // A new runner instance reading via the legacy adapter:
    const r = await readLegacySignalResult(wtPath, 'resumed-run');
    expect(r).not.toBeNull();
    expect(r!.status).toBe('completed');
    // The original payload is intact — downstream consumers can still
    // post the summary to the issue / write a handoff doc.
    expect((r!.structuredOutput as { summary: string }).summary).toBe(oldSignal.summary);
  });
});