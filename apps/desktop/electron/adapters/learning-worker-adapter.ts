import { fork, type ChildProcess } from "node:child_process";
import type { LearningWorkerTarget } from "../../shared/learning-contract.js";

export function createLearningWorker(entry: string, own: (launch: () => ChildProcess) => ChildProcess) {
  return (target: LearningWorkerTarget, signal: AbortSignal): Promise<unknown> => {
    signal.throwIfAborted();
    const child = own(() => fork(entry, [JSON.stringify(target)], {
      execPath: process.execPath,
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    }));
    return new Promise((resolve, reject) => {
      let reply: unknown;
      let failed = false;
      let exited = false;
      const cancel = () => {
        if (exited) finishCancellation();
        else if (child.connected) child.disconnect();
      };
      const finishCancellation = () => {
        signal.removeEventListener("abort", cancel);
        reject(signal.reason);
      };
      child.once("message", message => { reply = message; });
      child.on("error", () => { failed = true; });
      child.once("exit", () => {
        exited = true;
        if (signal.aborted) finishCancellation();
      });
      child.once("close", code => {
        signal.removeEventListener("abort", cancel);
        if (signal.aborted) reject(signal.reason);
        else if (failed || code !== 0 || reply === undefined) reject(new Error("learning_worker_failed"));
        else resolve(reply);
      });
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    });
  };
}
