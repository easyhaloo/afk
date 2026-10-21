import { isAgentExecutionMode } from "@afk/core";
import { probeProcess } from "@afk/infrastructure";
import type { RuntimeHealthObservation, TaskRuntimePort } from "@afk/application";
import type { WorkItemRunRecord } from "../../shared/backlog-contract.js";

export function createExecutionRuntimeAdapter(options: {
  taskRuntime: TaskRuntimePort;
  readReceipt: (runId: string, workItemId: string) => Promise<WorkItemRunRecord | undefined>;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean | undefined;
}) {
  // The probe can be inconclusive, and the observation says so rather than
  // claiming the runner is alive or gone.
  const isPidAlive = options.isPidAlive ?? ((pid: number) => probeProcess(pid));
  // One reader owns the runtime records: the bucket layout, the file names,
  // the validation and the identity rule belong to the runtime, not to this
  // adapter. The backlog runtime service reads through the same port, so
  // the two views cannot disagree about a record.
  return {
    async read(runId: string, workItemId: string): Promise<RuntimeHealthObservation | undefined> {
      const observedAt = new Date(options.now?.() ?? Date.now()).toISOString();
      const entry = await options.taskRuntime.find(runId, { workItemId });
      const record = entry?.record;
      let observation: RuntimeHealthObservation | undefined = record === undefined ? undefined : {
        runId, observedAt,
        status: record.status,
        ...(typeof record.heartbeatAt === "string" ? { heartbeatAt: record.heartbeatAt } : {}),
        ...(typeof record.completedAt === "string" ? { completedAt: record.completedAt } : {}),
        ...(typeof record.agentProvider === "string" ? { provider: record.agentProvider } : {}),
        ...(typeof record.agentTransport === "string" ? { transport: record.agentTransport } : {}),
        ...(isAgentExecutionMode(record.executionMode) ? { executionMode: record.executionMode } : {}),
      };
      const receipt = await options.readReceipt(runId, workItemId);
      if (receipt?.id === runId && typeof receipt.pid === "number" && Number.isSafeInteger(receipt.pid) && receipt.pid > 0) {
        const alive = receipt.status === "completed" || receipt.status === "failed" ? false : isPidAlive(receipt.pid);
        observation = { ...observation, runId, observedAt, runnerPid: receipt.pid, runnerAlive: alive };
        if (alive === true && observation.status !== "running") {
          observation = { ...observation, status: "running", heartbeatAt: undefined, completedAt: undefined };
        }
      }
      return observation;
    },
  };
}
