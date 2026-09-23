import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkItemExecutionManifestStore,
  type WorkItemExecutionManifest,
  type WorkItemExecutionManifestStoreFs,
} from "../../electron/services/work-item-execution-manifest-store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("work item execution manifest store", () => {
  it("round-trips the manifest through the fixed workspace .afk path", async () => {
    const workspace = await createWorkspace();
    const store = createWorkItemExecutionManifestStore();
    const manifest = createManifest();

    await expect(store.load(workspace)).resolves.toBeNull();
    await store.save(workspace, manifest);

    await expect(store.load(workspace)).resolves.toEqual(manifest);
    await expect(readFile(manifestPath(workspace), "utf8")).resolves.toBe(`${JSON.stringify(manifest, null, 2)}\n`);
  });

  it("reports malformed JSON and invalid schema with the manifest path", async () => {
    const workspace = await createWorkspace();
    const file = manifestPath(workspace);
    const store = createWorkItemExecutionManifestStore();
    await mkdir(path.dirname(file), { recursive: true });

    await writeFile(file, "not-json", "utf8");
    await expect(store.load(workspace)).rejects.toThrow(file);

    await writeFile(file, JSON.stringify({ ...createManifest(), schemaVersion: 2 }), "utf8");
    await expect(store.load(workspace)).rejects.toThrow(file);
  });

  it("reports save schema validation failures with the target path and original cause", async () => {
    const workspace = await createWorkspace();
    const target = manifestPath(workspace);
    const invalid = { ...createManifest(), schemaVersion: 2 } as unknown as WorkItemExecutionManifest;

    const error = await rejectedError(createWorkItemExecutionManifestStore().save(workspace, invalid));

    expect(error.message).toContain(target);
    expect(error.message).toContain("schemaVersion must be 1");
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toContain("schemaVersion must be 1");
  });

  it("reports mkdir failures with the target path and original cause", async () => {
    const workspace = await createWorkspace();
    const target = manifestPath(workspace);
    const failure = new Error("mkdir failed");
    const fs: WorkItemExecutionManifestStoreFs = {
      async mkdir() { throw failure; },
      readFile,
      writeFile,
      rename,
      unlink,
    };

    const error = await rejectedError(createWorkItemExecutionManifestStore({ fs }).save(workspace, createManifest()));

    expect(error.message).toContain(target);
    expect(error.message).toContain(failure.message);
    expect(error.cause).toBe(failure);
  });

  it.each([
    ["an invalid work item id", { workItemId: "../WI-1" }, /workItemId/i],
    ["an invalid provider backlog id", { providerBacklogId: "WI-1" }, /providerBacklogId/i],
    ["an empty repository set", { repositories: [] }, /repositories/i],
    ["an invalid top-level working branch", { workingBranch: "bad..branch" }, /workingBranch/i],
    ["checkout path traversal", { repositories: [{ ...createManifest().repositories[0], checkoutPath: "../api" }] }, /checkoutPath/i],
    ["an invalid base branch", { repositories: [{ ...createManifest().repositories[0], baseBranch: "bad..branch" }] }, /baseBranch/i],
  ])("rejects %s", async (_label, patch, expected) => {
    const workspace = await createWorkspace();
    const manifest = { ...createManifest(), ...patch } as WorkItemExecutionManifest;

    await expect(createWorkItemExecutionManifestStore().save(workspace, manifest)).rejects.toThrow(expected);
  });

  it.each([
    [
      "repository",
      [
        createManifest().repositories[0],
        { ...createManifest().repositories[0], name: "api-copy", checkoutPath: "repositories/api-copy", primary: false },
      ],
      /duplicate repository/i,
    ],
    [
      "checkout path",
      [
        createManifest().repositories[0],
        { ...createManifest().repositories[1], checkoutPath: "repositories\\api", primary: false },
      ],
      /duplicate checkoutPath/i,
    ],
  ])("rejects duplicate %s entries", async (_label, repositories, expected) => {
    const workspace = await createWorkspace();

    await expect(createWorkItemExecutionManifestStore().save(workspace, {
      ...createManifest(),
      repositories,
    })).rejects.toThrow(expected);
  });

  it.each([
    ["zero", createManifest().repositories.map(repository => ({ ...repository, primary: false }))],
    ["multiple", createManifest().repositories.map(repository => ({ ...repository, primary: true }))],
  ])("rejects %s primary repositories", async (_label, repositories) => {
    const workspace = await createWorkspace();

    await expect(createWorkItemExecutionManifestStore().save(workspace, {
      ...createManifest(),
      repositories,
    })).rejects.toThrow(/exactly one primary/i);
  });

  it("rejects repository working branches that differ from the manifest branch", async () => {
    const workspace = await createWorkspace();
    const manifest = createManifest();
    manifest.repositories[1] = { ...manifest.repositories[1], workingBranch: "afk/other-work-item" };

    await expect(createWorkItemExecutionManifestStore().save(workspace, manifest)).rejects.toThrow(/workingBranch.*match/i);
  });

  it("uses a unique temporary file for each concurrent save", async () => {
    const workspace = await createWorkspace();
    const temporaryFiles: string[] = [];
    let releaseWrites: (() => void) | undefined;
    const writesReady = new Promise<void>(resolve => { releaseWrites = resolve; });
    let pendingWrites = 0;
    const fs: WorkItemExecutionManifestStoreFs = {
      mkdir,
      readFile,
      rename,
      unlink,
      async writeFile(file, data, options) {
        temporaryFiles.push(file);
        pendingWrites += 1;
        if (pendingWrites === 2) releaseWrites?.();
        await writesReady;
        await writeFile(file, data, options);
      },
    };
    const ids = ["first", "second"];
    const store = createWorkItemExecutionManifestStore({ fs, randomUUID: () => ids.shift() ?? "unexpected" });
    const first = createManifest();
    const second = { ...createManifest(), workItemId: "WI-2", workingBranch: "afk/work-item-2", repositories: createManifest().repositories.map(repository => ({ ...repository, workingBranch: "afk/work-item-2" })) };

    await Promise.all([store.save(workspace, first), store.save(workspace, second)]);

    expect(new Set(temporaryFiles).size).toBe(2);
    await expect(store.load(workspace)).resolves.toSatisfy(value => value?.workItemId === "WI-1" || value?.workItemId === "WI-2");
    await expect(readdir(path.dirname(manifestPath(workspace)))).resolves.toEqual(["execution-manifest.json"]);
  });

  it.each(["write", "rename"] as const)("keeps the old target and cleans the temporary file when %s fails", async failure => {
    const workspace = await createWorkspace();
    const original = createManifest();
    const target = manifestPath(workspace);
    const operationFailure = new Error(`${failure} failed`);
    await createWorkItemExecutionManifestStore().save(workspace, original);
    const fs: WorkItemExecutionManifestStoreFs = {
      mkdir,
      readFile,
      unlink,
      async writeFile(file, data, options) {
        await writeFile(file, data, options);
        if (failure === "write") throw operationFailure;
      },
      async rename(from, to) {
        if (failure === "rename") throw operationFailure;
        await rename(from, to);
      },
    };
    const store = createWorkItemExecutionManifestStore({ fs, randomUUID: () => `${failure}-failure` });
    const replacement = { ...createManifest(), workItemId: "WI-2" };

    const error = await rejectedError(store.save(workspace, replacement));

    expect(error.message).toContain(target);
    expect(error.message).toContain(operationFailure.message);
    expect(error.cause).toBe(operationFailure);
    await expect(readFile(target, "utf8")).resolves.toBe(`${JSON.stringify(original, null, 2)}\n`);
    await expect(readdir(path.dirname(target))).resolves.toEqual(["execution-manifest.json"]);
  });
});

async function createWorkspace(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "afk-execution-manifest-store-"));
  directories.push(directory);
  return directory;
}

function manifestPath(workspace: string): string {
  return path.join(workspace, ".afk", "execution-manifest.json");
}

async function rejectedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`Expected Error rejection, received ${String(error)}`);
  }
  throw new Error("Expected promise to reject");
}

function createManifest(): WorkItemExecutionManifest {
  return {
    schemaVersion: 1,
    workItemId: "WI-1",
    providerBacklogId: "42",
    tracker: { platform: "github", projectKey: "acme/api", providerProjectId: "101" },
    workingBranch: "afk/work-item-1",
    repositories: [
      {
        platform: "github",
        projectKey: "acme/api",
        providerProjectId: "101",
        name: "api",
        checkoutPath: "repositories/api",
        baseBranch: "main",
        role: "backend",
        workingBranch: "afk/work-item-1",
        primary: true,
      },
      {
        platform: "gitlab",
        projectKey: "git.corp/acme/web",
        providerHost: "git.corp",
        name: "web",
        checkoutPath: "repositories/web",
        baseBranch: "release/2026.09",
        workingBranch: "afk/work-item-1",
        primary: false,
      },
    ],
  };
}
