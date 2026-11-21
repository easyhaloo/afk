import { createDefaultPluginRuntime } from "@afk/runtime/plugin-sdk";
import { parseObject } from "../../shared/validation.js";
import { parseLearningWorkerTarget } from "../../shared/learning-contract.js";
import { projectLearningJob } from "../services/learning-service.js";

const controller = new AbortController();
process.once("disconnect", () => controller.abort());
if (!process.connected) controller.abort();

async function main() {
  const target = parseLearningWorkerTarget(JSON.parse(process.argv[2] ?? "null"));
  const { signal } = controller;
  signal.throwIfAborted();
  const runtime = await createDefaultPluginRuntime();
  let job;
  try {
    signal.throwIfAborted();
    const state = parseObject(await runtime.dispatchSystemAction("learning.worker.once", target, { signal }), "worker result");
    job = projectLearningJob(state.job);
    if (job.scope !== target.scope || job.jobId !== target.requestKey) throw new Error("learning_worker_invalid_result");
  } finally { await runtime.dispose(); }
  if (process.connected && !signal.aborted) {
    await new Promise<void>((resolve, reject) => process.send!({ status: "finished", job }, error => error ? reject(error) : resolve()));
  }
}

void main().catch(() => { process.exitCode = 1; }).finally(() => {
  if (process.connected) process.disconnect!();
});
