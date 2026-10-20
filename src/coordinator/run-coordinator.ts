import type { ObservationContext, RunEventData } from '@afk/core';
import type { Decision, Effect, RunAggregate, RunCommand } from '@afk/core';
import { decide } from '@afk/core';
import type { AuditWriter } from '@afk/application';

export interface EffectExecution {
  execute(effect: Effect, context: ObservationContext): Promise<{ summary?: string }>;
}

export interface CoordinatorDependencies {
  /** Appends audit events. The one writer, not the store. */
  audit: AuditWriter;
  effects: EffectExecution;
}

/**
 * Interprets pure domain effects without owning tracker, workspace, or agent
 * implementations. The existing runners remain effect adapters during dual-write.
 */
export class RunCoordinator {
  constructor(private readonly deps: CoordinatorDependencies) {}

  async dispatch(state: RunAggregate, context: ObservationContext, command: RunCommand): Promise<Decision> {
    const decision = decide(state, command);
    await this.append(context, {
      kind: 'decision.made',
      command: command.type,
      accepted: decision.accepted,
      reason: decision.reason,
    });
    if (!decision.accepted) return decision;

    for (const effect of decision.effects) await this.execute(effect, context);
    return decision;
  }

  private async execute(effect: Effect, context: ObservationContext): Promise<void> {
    const idempotencyKey = `${context.runId}:${effect.kind}:${effectKey(effect)}`;
    await this.append(context, { kind: 'effect.started', effectKind: effect.kind, idempotencyKey }, idempotencyKey);
    try {
      const result = await this.deps.effects.execute(effect, context);
      await this.append(context, {
        kind: 'effect.completed',
        effectKind: effect.kind,
        idempotencyKey,
        outcome: 'succeeded',
        summary: result.summary,
      }, idempotencyKey);
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      await this.append(context, { kind: 'effect.completed', effectKind: effect.kind, idempotencyKey, outcome: 'failed', summary }, idempotencyKey);
      throw error;
    }
  }

  private async append(context: ObservationContext, data: RunEventData, idempotencyKey?: string): Promise<void> {
    // Through the writer, so the event is stamped, logged, counted and traced
    // the way every other audit event is.
    await this.deps.audit.record(context, data, idempotencyKey ? { idempotencyKey } : {});
  }
}

function effectKey(effect: Effect): string {
  switch (effect.kind) {
    case 'start_run': return effect.runId;
    case 'start_step': return effect.stepId;
    case 'open_human_gate': return effect.gateId;
    case 'finish_run': return effect.outcome;
  }
}
