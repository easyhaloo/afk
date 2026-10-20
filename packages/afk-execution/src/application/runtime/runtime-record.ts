/**
 * The runtime record — one shape for the Tasks monitor.
 *
 * The workflow runner and the QA runner each started their own runtime
 * record, and the twenty-odd fields were written out twice. A field added
 * to one and not the other would show up as a monitor that knows one phase
 * of a run and not the other. The shape now lives here; the two runners
 * only say what is different about their phase.
 *
 * This is the write model: a run that publishes a record knows the sandbox
 * it ran in, the mode it ran in and the agent it ran, so all three are
 * always written down. A reader may still meet an older record that does
 * not carry them, and it reads it without inventing them.
 */

import type { AgentProviderName, AgentRuntimeSelection } from '../../domain/agents/types.js';
import { runtimeFieldsFromSelection } from '../runtime/agent-metadata.js';
import type { TaskRuntimePhase, TaskRuntimeRecordInput, TaskRuntimeStatus } from './task-runtime.js';

export interface RuntimeRecordInput {
  runId: string;
  backlogId: string;
  workspace?: string;
  providerRef?: string;
  title?: string;
  phase: TaskRuntimePhase;
  status?: TaskRuntimeStatus;
  /** Set for a phase that owns an interactive session. */
  session?: string;
  branch?: string;
  progress: string;
  sandboxProvider: string;
  executionMode: 'interactive' | 'batch';
  agentProvider: AgentProviderName;
  runtime?: AgentRuntimeSelection;
  now?: string;
}

export function runtimeRecord(input: RuntimeRecordInput): TaskRuntimeRecordInput {
  const now = input.now ?? new Date().toISOString();
  return {
    runId: input.runId,
    backlogId: input.backlogId,
    ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
    ...(input.providerRef !== undefined ? { providerRef: input.providerRef } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
    phase: input.phase,
    status: input.status ?? 'running',
    sandboxProvider: input.sandboxProvider,
    executionMode: input.executionMode,
    agentProvider: input.agentProvider,
    ...runtimeFieldsFromSelection(input.agentProvider, input.runtime),
    ...(input.session !== undefined ? { session: input.session } : {}),
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
    startedAt: now,
    heartbeatAt: now,
    progress: input.progress,
  };
}
