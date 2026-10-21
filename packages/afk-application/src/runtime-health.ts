import { isAgentExecutionMode, type AgentExecutionMode } from '@afk/core';

export const RUNTIME_STALE_AFTER_MS = 5 * 60 * 1000;

export type RuntimeHealthObservationStatus = 'running' | 'completed' | 'blocked' | 'failed';

export type RuntimeHealthObservation = {
  runId: string;
  heartbeatAt?: string;
  completedAt?: string;
  status?: RuntimeHealthObservationStatus;
  provider?: string;
  transport?: string;
  executionMode?: AgentExecutionMode;
  runnerPid?: number;
  runnerAlive?: boolean;
  observedAt: string;
};

/**
 * The states a run's health can be in.
 *
 * The list is named so a reader can check a state against it rather
 * than writing the states down a second time.
 */
export const RUNTIME_HEALTH_STATES = ['live', 'stale', 'exited', 'unknown'] as const;

export type RuntimeHealthState = (typeof RUNTIME_HEALTH_STATES)[number];

export type RuntimeHealth = {
  state: RuntimeHealthState;
  observedAt: string;
  reason: string;
  heartbeatAt?: string;
  completedAt?: string;
  provider?: string;
  transport?: string;
  executionMode?: AgentExecutionMode;
  runnerPid?: number;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function echoString(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim() !== '' && !/[\x00-\x1f\x7f]/.test(value) ? value : undefined;
}

function echoExecutionMode(value: AgentExecutionMode | undefined): AgentExecutionMode | undefined {
  return isAgentExecutionMode(value) ? value : undefined;
}

export function projectRuntimeHealth(
  runId: string,
  observation: RuntimeHealthObservation | undefined,
  now: number = Date.now(),
): RuntimeHealth {
  const base: RuntimeHealth = {
    state: 'unknown',
    observedAt: new Date(isFiniteNumber(now) && !Number.isNaN(new Date(now).getTime()) ? now : 0).toISOString(),
    reason: '',
  };

  if (!isFiniteNumber(now) || Number.isNaN(new Date(now).getTime())) {
    return { ...base, reason: '健康判定时间无效，无法判定运行时状态。' };
  }
  if (typeof runId !== 'string' || runId.trim() === '') {
    return { ...base, reason: '缺少运行标识，无法判定运行时状态。' };
  }
  if (observation === undefined || observation === null || typeof observation !== 'object') {
    return { ...base, reason: `运行 ${runId} 缺少运行时观测记录，状态未知。` };
  }
  if (echoString(observation.runId) !== runId) {
    return { ...base, reason: `观测记录的运行标识与请求的 ${runId} 不匹配，状态未知。` };
  }

  const provider = echoString(observation.provider);
  const transport = echoString(observation.transport);
  const executionMode = echoExecutionMode(observation.executionMode);
  const runnerPid = Number.isSafeInteger(observation.runnerPid) && observation.runnerPid! > 0 ? observation.runnerPid : undefined;

  const withDetails = (health: RuntimeHealth): RuntimeHealth => ({
    ...health,
    ...(provider !== undefined && { provider }),
    ...(transport !== undefined && { transport }),
    ...(executionMode !== undefined && { executionMode }),
    ...(runnerPid !== undefined && { runnerPid }),
  });

  const observedAtMs = parseTimestamp(observation.observedAt);
  if (observedAtMs === undefined || observedAtMs > now) {
    return withDetails({ ...base, reason: `运行 ${runId} 的观测时间缺失、无效或来自未来，状态未知。` });
  }

  const heartbeatMs = parseTimestamp(observation.heartbeatAt);
  if (observation.heartbeatAt !== undefined && heartbeatMs === undefined) {
    return withDetails({ ...base, reason: `运行 ${runId} 的心跳时间无效，状态未知。` });
  }
  if (heartbeatMs !== undefined && heartbeatMs > now) {
    return withDetails({ ...base, reason: `运行 ${runId} 的心跳时间来自未来，状态未知。` });
  }

  const completedMs = parseTimestamp(observation.completedAt);
  if (observation.completedAt !== undefined && completedMs === undefined) {
    return withDetails({ ...base, reason: `运行 ${runId} 的完成时间无效，状态未知。` });
  }
  if (completedMs !== undefined && completedMs > now) {
    return withDetails({ ...base, reason: `运行 ${runId} 的完成时间来自未来，状态未知。` });
  }

  const status = observation.status;
  const statusValid = status === 'running' || status === 'completed' || status === 'blocked' || status === 'failed';

  if (statusValid && status !== 'running') {
    return withDetails({
      ...base,
      state: 'exited',
      reason: `运行 ${runId} 的 Agent 运行时已结束（${status}），任务结果仍以审计记录为准。`,
      ...(completedMs !== undefined && { completedAt: observation.completedAt }),
      ...(heartbeatMs !== undefined && { heartbeatAt: observation.heartbeatAt }),
    });
  }

  const pidUsable = runnerPid !== undefined;
  if (observation.runnerAlive === false && pidUsable) {
    return withDetails({
      ...base,
      state: 'exited',
      reason: `运行 ${runId} 的运行器进程已确认不存活，判定为已退出。`,
      ...(heartbeatMs !== undefined && { heartbeatAt: observation.heartbeatAt }),
    });
  }

  if (heartbeatMs !== undefined && status === 'running') {
    const ageMs = now - heartbeatMs;
    if (ageMs > RUNTIME_STALE_AFTER_MS) {
      return withDetails({
        ...base,
        state: 'stale',
        reason: `运行 ${runId} 的心跳已超过 ${RUNTIME_STALE_AFTER_MS} 毫秒未更新，判定为失联（stale）。`,
        heartbeatAt: observation.heartbeatAt,
      });
    }
    return withDetails({
      ...base,
      state: 'live',
      reason: `运行 ${runId} 的心跳在 ${RUNTIME_STALE_AFTER_MS} 毫秒内更新，运行正常。`,
      heartbeatAt: observation.heartbeatAt,
    });
  }

  if (observation.runnerAlive === true && pidUsable && now - observedAtMs <= RUNTIME_STALE_AFTER_MS) {
    return withDetails({
      ...base,
      state: 'live',
      reason: `运行 ${runId} 缺少心跳，但运行器进程确认存活，暂时判定为运行正常。`,
    });
  }

  return withDetails({
    ...base,
    state: 'unknown',
    reason: `运行 ${runId} 缺少有效心跳且无法确认运行器存活，状态未知。`,
  });
}
