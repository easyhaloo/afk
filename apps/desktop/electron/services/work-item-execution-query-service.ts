import { projectRuntimeHealth, projectWorkflowInstance, queryExecutionHistory, replayRun, type RuntimeHealthObservation, type RunEventQueryPort } from "@afk/application";
import type { RunEvent } from "@afk/core";
import { EXECUTION_PHASES, parseExecutionQueryOptions, parseExecutionSummary, parseExecutionTimelineEntry, parseExecutionRunDetail, type ExecutionRunDetail, type ExecutionQueryOptions, type ExecutionSummary, type ExecutionTimelineEntry } from "../../shared/execution-contract.js";

type QueryPage = { executions: ExecutionSummary[]; nextCursor?: string };

function runPhase(value: unknown): ExecutionTimelineEntry["phase"] {
  return typeof value === "string" && (EXECUTION_PHASES as readonly string[]).includes(value) ? value as ExecutionTimelineEntry["phase"] : undefined;
}

function projectEvent(event: RunEvent): ExecutionTimelineEntry {
  const data = event.data as RunEvent["data"];
  const shared = {
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    kind: event.type,
    phase: runPhase("phase" in data ? data.phase : undefined),
    stepId: "stepId" in data && typeof data.stepId === "string" ? data.stepId : undefined,
  };
  switch (data.kind) {
    case "workflow.recorded":
      return { ...shared, reason: `${data.name} v${data.version}；${data.steps.map(step => `${step.id} · ${step.kind}${step.provider ? ` · ${step.provider}` : ""}${step.executionMode ? ` · ${step.executionMode}` : ""}${step.dependsOn.length ? ` · 依赖 ${step.dependsOn.join(", ")}` : ""}`).join("；")}` };
    case "workspace.prepared":
      return { ...shared, workspacePath: data.workspace, workspaceBranch: data.branch };
    case "change.created":
      return { ...shared, changeId: data.changeId, branch: data.targetBranch, changeUrl: data.url };
    case "change.published":
      return { ...shared, changeId: data.changeId, changeUrl: data.url };
    case "commit.recorded":
      return { ...shared, commitSha: data.commitSha, branch: data.branch };
    case "qa.failed":
      return { ...shared, outcome: "failed", failureSummary: data.summary ?? data.reason };
    case "failure.classified":
      return { ...shared, outcome: "failed", failureSummary: data.summary };
    case "step.completed":
      return { ...shared, outcome: data.outcome };
    case "effect.completed":
      return { ...shared, outcome: data.outcome, ...(data.outcome === "failed" && data.summary !== undefined ? { failureSummary: data.summary } : {}) };
    case "human_gate.opened":
      return { ...shared, reason: data.reason };
    case "decision.made":
      return { ...shared, reason: data.reason };
    case "run.finished":
      return { ...shared, outcome: data.outcome, ...(data.reason !== undefined ? { reason: data.reason } : {}) };
    default:
      return { ...shared };
  }
}

export function createWorkItemExecutionQueryService(events: RunEventQueryPort, runtime: { read?: (runId: string, workItemId: string) => Promise<RuntimeHealthObservation | undefined>; now?: () => number } = {}) {
  return {
    async list(options: ExecutionQueryOptions = {}): Promise<QueryPage> {
      const input = parseExecutionQueryOptions(options);
      const page = await queryExecutionHistory(input, events);
      return {
        executions: page.executions.map(parseExecutionSummary),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      };
    },
    async detail(runId: string, workItemId: string): Promise<ExecutionRunDetail> {
      if (typeof runId !== "string" || !runId.trim()) throw new Error("runId is required");
      if (typeof workItemId !== "string" || !workItemId.trim()) throw new Error("workItemId is required");
      const loaded = await replayRun(runId, events);
      const timeline = loaded.timeline;
      const first = timeline.events[0];
      if (!first || first.context.workItemId !== workItemId) {
        throw new Error(`no recorded events for run '${runId}' under work item '${workItemId}'`);
      }
      for (const event of timeline.events) {
        if (event.context.runId !== runId || event.context.workItemId !== workItemId) {
          throw new Error(`run '${runId}' contains events for work item '${event.context.workItemId}' instead of '${workItemId}'`);
        }
        if (event.data.kind === "run.requested" && (event.data.run.id !== runId || event.data.run.workItemId !== workItemId)) {
          throw new Error(`run '${runId}' was requested for work item '${event.data.run.workItemId}' instead of '${workItemId}'`);
        }
      }
      if (!timeline.integrity.valid) {
        throw new Error(`run '${runId}' event stream is not replayable: ${timeline.integrity.reason ?? "integrity_mismatch"}`);
      }
      if (loaded.explanation) {
        throw new Error(`run '${runId}' cannot be replayed: ${loaded.explanation}`);
      }
      if (!loaded.state?.run) {
        throw new Error(`run '${runId}' has no replayed run state`);
      }
      const entries = timeline.events.map(projectEvent).map(entry => parseExecutionTimelineEntry(entry));
      const workspace = timeline.events.find(event => event.data.kind === "workspace.prepared")?.data;
      const health = projectRuntimeHealth(runId, await runtime.read?.(runId, workItemId).catch(() => undefined), runtime.now?.() ?? Date.now());
      return parseExecutionRunDetail({
        runId,
        workItemId,
        status: loaded.state.run.status,
        ...(loaded.state.run.phase !== undefined ? { phase: loaded.state.run.phase } : {}),
        integrityValid: timeline.integrity.valid,
        health,
        workflow: projectWorkflowInstance(runId, workItemId, timeline.events),
        startedAt: first.occurredAt,
        updatedAt: timeline.events.at(-1)?.occurredAt,
        ...(workspace?.kind === "workspace.prepared" ? { workspacePath: workspace.workspace, workspaceBranch: workspace.branch } : {}),
        entries,
      });
    },
  };
}
