import { replay } from '../core/reducer';
import type { RunAggregate } from '../core/model';
import type { RunEvent } from '../core/events';
import type { EventStorePort } from '../core/ports';

export interface RunTimeline {
  runId: string;
  events: readonly RunEvent[];
  integrity: Awaited<ReturnType<EventStorePort['verify']>>;
}

export class RunQueryService {
  constructor(private readonly events: EventStorePort) {}

  async runs(): Promise<readonly string[]> {
    return this.events.listRuns();
  }

  async timeline(runId: string): Promise<RunTimeline> {
    const events: RunEvent[] = [];
    for await (const event of this.events.read(runId)) events.push(event);
    return { runId, events, integrity: await this.events.verify(runId) };
  }

  async replay(runId: string): Promise<{ timeline: RunTimeline; state?: RunAggregate; explanation?: string }> {
    const timeline = await this.timeline(runId);
    if (!timeline.integrity.valid) return { timeline, explanation: `cannot replay invalid event stream: ${timeline.integrity.reason ?? 'unknown'}` };
    try {
      return { timeline, state: replay(timeline.events) };
    } catch (error) {
      return { timeline, explanation: error instanceof Error ? error.message : String(error) };
    }
  }

  async explain(runId: string): Promise<string> {
    const result = await this.replay(runId);
    if (result.explanation) return result.explanation;
    if (!result.state?.run) return 'no events recorded for this run';
    if (result.state.terminal) return `run finished with status '${result.state.run.status}'`;
    if (result.state.humanGateId) return `run awaits human gate '${result.state.humanGateId}'`;
    if (result.state.activeStep) return `run executes step '${result.state.activeStep}'`;
    return `run is '${result.state.run.status}' without an active step`;
  }
}
