import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createLearningWorker } from "../../electron/adapters/learning-worker-adapter.js";

it("returns the owned child's reply after normal exit", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "desktop-learning-worker-"));
  const entry = path.join(directory, "worker.mjs");
  const target = { scope: "github:acme/api", requestKey: "a".repeat(64) };
  try {
    await writeFile(entry, `process.send(JSON.parse(process.argv[2]), () => process.disconnect());`);
    const run = createLearningWorker(entry, launch => launch());
    await expect(run(target, new AbortController().signal)).resolves.toEqual(target);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("waits for cleanup in its owned child after cancellation disconnects IPC", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "desktop-learning-worker-"));
  const entry = path.join(directory, "worker.mjs");
  const cleaned = path.join(directory, "cleaned");
  const controller = new AbortController();
  try {
    await writeFile(entry, `import { writeFile } from "node:fs/promises";
      process.once("disconnect", async () => { await writeFile(${JSON.stringify(cleaned)}, "done"); });
      process.send(JSON.parse(process.argv[2]));`);
    let ready!: Promise<unknown[]>;
    const run = createLearningWorker(entry, launch => {
      const child = launch();
      ready = once(child, "message");
      return child;
    });
    const target = { scope: "github:acme/api", requestKey: "a".repeat(64) };
    const result = run(target, controller.signal);
    const cancelled = expect(result).rejects.toThrow(/abort/i);
    const [message] = await ready;
    expect(message).toEqual(target);
    controller.abort();
    await cancelled;
    expect(await readFile(cleaned, "utf8")).toBe("done");
  } finally {
    controller.abort();
    await rm(directory, { recursive: true, force: true });
  }
});
