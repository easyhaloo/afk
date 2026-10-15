import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { RuntimeHealthObservation } from "@afk/application";
import type { WorkItemRunRecord } from "../../shared/backlog-contract.js";

export function createExecutionRuntimeAdapter(options: {
  runtimeRoot?: string;
  readReceipt: (runId: string, workItemId: string) => Promise<WorkItemRunRecord | undefined>;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean | undefined;
}) {
  const root = options.runtimeRoot ?? path.join(homedir(), ".afk", "runtime", "tasks");
  const isPidAlive = options.isPidAlive ?? ((pid: number) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : undefined; }
  });
  return {
    async read(runId: string, workItemId: string): Promise<RuntimeHealthObservation | undefined> {
      const observedAt = new Date(options.now?.() ?? Date.now()).toISOString();
      let observation: RuntimeHealthObservation | undefined;
      for (const bucket of ["active", "archive"]) {
        try {
          const value = JSON.parse(await readFile(path.join(root, bucket, `${Buffer.from(runId).toString("base64url")}.json`), "utf8"));
          if (value.runId !== runId || (value.providerRef !== undefined && value.providerRef !== workItemId)) continue;
          observation = {
            runId, observedAt,
            ...(["running", "completed", "blocked", "failed"].includes(value.status) ? { status: value.status } : {}),
            ...(typeof value.heartbeatAt === "string" ? { heartbeatAt: value.heartbeatAt } : {}),
            ...(typeof value.completedAt === "string" ? { completedAt: value.completedAt } : {}),
            ...(typeof value.agentProvider === "string" ? { provider: value.agentProvider } : {}),
            ...(typeof value.agentTransport === "string" ? { transport: value.agentTransport } : {}),
            ...(value.executionMode === "interactive" || value.executionMode === "batch" ? { executionMode: value.executionMode } : {}),
          };
          break;
        } catch (error) {
          if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
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
