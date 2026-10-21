import type { AgentTelemetryPort } from '@afk/application';
import {
  findCodexRollout,
  readAgentTelemetry,
  readAgentTools,
  readAgentTranscript,
} from './agent-telemetry.js';

/**
 * The harness transcripts, reached through the port.
 *
 * AFK only reads: the harness owns what happened in the run, and the
 * reader here is the one that knows how each harness writes it down.
 */
export const agentTelemetryPort: AgentTelemetryPort = {
  readUsage: options => readAgentTelemetry(options),
  readTranscript: options => readAgentTranscript(options),
  readTools: options => readAgentTools(options),
  findRollout: (threadId, rootDir) => findCodexRollout(threadId, rootDir),
};
