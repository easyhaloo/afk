import { describe, expect, it } from 'vitest';

import {
  RUNTIME_STALE_AFTER_MS,
  projectRuntimeHealth,
  type RuntimeHealthObservation,
} from './runtime-health.js';

const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const FRESH_HEARTBEAT = '2026-10-15T11:58:00.000Z';
const EXPIRED_HEARTBEAT = '2026-10-15T11:50:00.000Z';

function observation(overrides: Partial<RuntimeHealthObservation> = {}): RuntimeHealthObservation {
  return {
    runId: 'run-1',
    heartbeatAt: FRESH_HEARTBEAT,
    status: 'running',
    observedAt: '2026-10-15T12:00:00.000Z',
    ...overrides,
  };
}

describe('RUNTIME_STALE_AFTER_MS', () => {
  it('is the shared five minute policy', () => {
    expect(RUNTIME_STALE_AFTER_MS).toBe(5 * 60 * 1000);
  });
});

describe('projectRuntimeHealth — live', () => {
  it('reports live for a fresh running heartbeat', () => {
    const health = projectRuntimeHealth('run-1', observation(), NOW);
    expect(health.state).toBe('live');
    expect(health.heartbeatAt).toBe(FRESH_HEARTBEAT);
    expect(health.reason).toContain('运行 run-1');
    expect(health.observedAt).toBe('2026-10-15T12:00:00.000Z');
  });

  it('reports live exactly at the freshness boundary', () => {
    const boundary = Date.parse(FRESH_HEARTBEAT) + RUNTIME_STALE_AFTER_MS;
    const health = projectRuntimeHealth('run-1', observation(), boundary);
    expect(health.state).toBe('live');
  });

  it('keeps provider metadata in the projection', () => {
    const health = projectRuntimeHealth(
      'run-1',
      observation({ provider: 'claude', transport: 'tmux', executionMode: 'batch', runnerPid: 4242 }),
      NOW,
    );
    expect(health.state).toBe('live');
    expect(health.provider).toBe('claude');
    expect(health.transport).toBe('tmux');
    expect(health.executionMode).toBe('batch');
    expect(health.runnerPid).toBe(4242);
  });

  it('supports live from runnerAlive when heartbeat is missing', () => {
    const health = projectRuntimeHealth('run-1', observation({ heartbeatAt: undefined, runnerAlive: true, runnerPid: 100 }), NOW);
    expect(health.state).toBe('live');
    expect(health.reason).toContain('存活');
  });
});

describe('projectRuntimeHealth — stale', () => {
  it('reports stale for an expired running heartbeat', () => {
    const health = projectRuntimeHealth('run-1', observation({ heartbeatAt: EXPIRED_HEARTBEAT }), NOW);
    expect(health.state).toBe('stale');
    expect(health.heartbeatAt).toBe(EXPIRED_HEARTBEAT);
    expect(health.reason).toContain('失联');
  });

  it('never reports failed for an expired heartbeat', () => {
    const health = projectRuntimeHealth('run-1', observation({ heartbeatAt: EXPIRED_HEARTBEAT }), NOW);
    expect(health.state).not.toBe('exited');
  });

  it('keeps a stale heartbeat stale even when the probe confirms the runner alive', () => {
    const health = projectRuntimeHealth(
      'run-1',
      observation({ heartbeatAt: EXPIRED_HEARTBEAT, runnerAlive: true, runnerPid: 500 }),
      NOW,
    );
    expect(health.state).toBe('stale');
  });
});

describe('projectRuntimeHealth — exited', () => {
  it('reports exited for terminal runtime statuses', () => {
    for (const status of ['completed', 'blocked', 'failed'] as const) {
      const health = projectRuntimeHealth(
        'run-1',
        observation({ status, completedAt: '2026-10-15T11:55:00.000Z', heartbeatAt: undefined }),
        NOW,
      );
      expect(health.state).toBe('exited');
      expect(health.completedAt).toBe('2026-10-15T11:55:00.000Z');
    }
  });

  it('treats terminal runtime status as lifecycle evidence only, echoing status text without business judgement', () => {
    const health = projectRuntimeHealth('run-1', observation({ status: 'failed', completedAt: '2026-10-15T11:55:00.000Z' }), NOW);
    expect(health.state).toBe('exited');
    expect(health.reason).toContain('任务结果仍以审计记录为准');
  });

  it('reports exited when runnerAlive is false with a valid positive PID', () => {
    const health = projectRuntimeHealth(
      'run-1',
      observation({ heartbeatAt: FRESH_HEARTBEAT, runnerAlive: false, runnerPid: 999 }),
      NOW,
    );
    expect(health.state).toBe('exited');
  });

  it('does not accept a dead-process probe without a PID as exit evidence', () => {
    const health = projectRuntimeHealth('run-1', observation({ heartbeatAt: FRESH_HEARTBEAT, runnerAlive: false }), NOW);
    expect(health.state).toBe('live');
  });
});

describe('projectRuntimeHealth — unknown', () => {
  it('reports unknown when the observation is missing', () => {
    const health = projectRuntimeHealth('run-1', undefined, NOW);
    expect(health.state).toBe('unknown');
    expect(health.reason).toContain('run-1');
  });

  it('reports unknown when runId is empty', () => {
    const health = projectRuntimeHealth('', observation(), NOW);
    expect(health.state).toBe('unknown');
  });

  it('reports unknown on identity mismatch', () => {
    const health = projectRuntimeHealth('run-2', observation({ runId: 'run-1' }), NOW);
    expect(health.state).toBe('unknown');
    expect(health.reason).toContain('run-2');
    expect(health.provider).toBeUndefined();
    expect(health.runnerPid).toBeUndefined();
  });

  it('reports unknown for a future heartbeat', () => {
    const health = projectRuntimeHealth('run-1', observation({ heartbeatAt: '2026-10-15T12:01:00.000Z' }), NOW);
    expect(health.state).toBe('unknown');
  });

  it('reports unknown for an invalid heartbeat', () => {
    const health = projectRuntimeHealth('run-1', observation({ heartbeatAt: 'not-a-date' }), NOW);
    expect(health.state).toBe('unknown');
  });

  it('reports unknown for a future completedAt', () => {
    const health = projectRuntimeHealth(
      'run-1',
      observation({ heartbeatAt: undefined, completedAt: '2026-10-15T12:30:00.000Z' }),
      NOW,
    );
    expect(health.state).toBe('unknown');
  });

  it('reports unknown for an invalid observedAt', () => {
    const health = projectRuntimeHealth('run-1', observation({ observedAt: 'garbage' }), NOW);
    expect(health.state).toBe('unknown');
  });

  it('reports unknown for a future observedAt', () => {
    const health = projectRuntimeHealth('run-1', observation({ observedAt: '2026-10-15T12:30:00.000Z' }), NOW);
    expect(health.state).toBe('unknown');
  });

  it('reports unknown when heartbeat is missing and runnerAlive is absent', () => {
    const health = projectRuntimeHealth('run-1', observation({ heartbeatAt: undefined }), NOW);
    expect(health.state).toBe('unknown');
  });

  it('reports unknown for an invalid non-positive runnerPid with no other evidence', () => {
    const health = projectRuntimeHealth('run-1', observation({ heartbeatAt: undefined, runnerAlive: true, runnerPid: -1 }), NOW);
    expect(health.state).toBe('unknown');
    expect(health.runnerPid).toBeUndefined();
  });
});

describe('projectRuntimeHealth — hygiene', () => {
  it('does not throw or echo invalid times and fractional process identities', () => {
    expect(projectRuntimeHealth('run-1', undefined, Number.NaN)).toMatchObject({ state: 'unknown', observedAt: '1970-01-01T00:00:00.000Z' });
    expect(projectRuntimeHealth('run-1', observation({ heartbeatAt: undefined, runnerAlive: true, runnerPid: 1.5 }), NOW).state).toBe('unknown');
  });
  it('always emits an ISO observedAt', () => {
    const health = projectRuntimeHealth('run-1', undefined, NOW);
    expect(health.observedAt).toBe('2026-10-15T12:00:00.000Z');
  });

  it('does not copy invalid strings into the output', () => {
    const health = projectRuntimeHealth(
      'run-1',
      observation({
        heartbeatAt: 'garbage',
        provider: '   ',
        transport: '',
        executionMode: 'bogus' as unknown as RuntimeHealthObservation['executionMode'],
      }),
      NOW,
    );
    expect(health.provider).toBeUndefined();
    expect(health.transport).toBeUndefined();
    expect(health.executionMode).toBeUndefined();
  });

  it('ignores invalid runnerPid values', () => {
    const health = projectRuntimeHealth('run-1', observation({ runnerPid: 0, runnerAlive: true }), NOW);
    expect(health.runnerPid).toBeUndefined();
  });

  it('does not mutate the observation input', () => {
    const input = observation({ status: 'running' });
    const snapshot = { ...input };
    projectRuntimeHealth('run-1', input, NOW);
    expect(input).toEqual(snapshot);
  });
});
