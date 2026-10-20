import { randomUUID as createRandomUUID } from "node:crypto";
import { isMissingFileError } from "@afk/application";
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  parseExecutionManifestDocument,
  type ExecutionManifest,
  type ExecutionManifestRepository,
} from "@afk/application";

const MANIFEST_FILE = "execution-manifest.json";

/**
 * The manifest is the contract between the desktop and the runner: the
 * desktop writes it, the runner reads it.  Both sides declare it and
 * parse it from the application package now, so there is one shape and
 * one grammar — a field added to one is added to the other by
 * construction, and a document the desktop accepts is a document the
 * runner can read.
 */
export type WorkItemExecutionManifest = ExecutionManifest;
export type WorkItemExecutionManifestRepository = ExecutionManifestRepository;

export type WorkItemExecutionManifestStoreFs = {
  mkdir: (directory: string, options: { recursive: boolean }) => Promise<unknown>;
  readFile: (file: string, encoding: "utf8") => Promise<string>;
  writeFile: (file: string, data: string, options: { encoding: "utf8"; mode: number }) => Promise<unknown>;
  rename: (source: string, target: string) => Promise<unknown>;
  unlink: (file: string) => Promise<unknown>;
};

export type WorkItemExecutionManifestStoreDeps = {
  fs?: WorkItemExecutionManifestStoreFs;
  randomUUID?: () => string;
};

const defaultFs: WorkItemExecutionManifestStoreFs = {
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
};

export function createWorkItemExecutionManifestStore(deps: WorkItemExecutionManifestStoreDeps = {}) {
  const fs = deps.fs ?? defaultFs;
  const randomUUID = deps.randomUUID ?? createRandomUUID;

  async function load(workspace: string): Promise<WorkItemExecutionManifest | null> {
    const target = workItemExecutionManifestPath(workspace);
    let raw: string;
    try {
      raw = await fs.readFile(target, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw withPath(`Failed to read execution manifest`, target, error);
    }
    try {
      return parseExecutionManifestDocument(JSON.parse(raw));
    } catch (error) {
      throw withPath(`Invalid execution manifest`, target, error);
    }
  }

  async function save(workspace: string, value: WorkItemExecutionManifest): Promise<void> {
    const target = workItemExecutionManifestPath(workspace);
    let temporary: string | undefined;
    try {
      const manifest = parseExecutionManifestDocument(value);
      temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, target);
    } catch (error) {
      if (temporary) await fs.unlink(temporary).catch(() => undefined);
      throw withPath("Failed to save execution manifest", target, error);
    }
  }

  return { load, save };
}

export function workItemExecutionManifestPath(workspace: string): string {
  return path.join(workspace, ".afk", MANIFEST_FILE);
}

function withPath(prefix: string, file: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`${prefix} at ${file}: ${detail}`, { cause: error });
}
