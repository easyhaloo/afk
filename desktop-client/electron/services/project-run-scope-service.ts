import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ProjectRun } from "../../shared/ipc-contract";
import { exec } from "../adapters/process-executor";
import { createWorkItemRunStore } from "./work-item-run-store";

type Project = { platform: "github" | "gitlab"; projectKey: string; host: string };
type WorkspaceMetadata = { taskId: string; root: string; repositories: Array<{ project: { platform: string; projectKey: string; providerHost?: string } }> };

function projectFromRemote(remote: string): Project | null {
  const match = /^(?:https?:\/\/([^/]+)\/|[^@\s]+@([^:]+):)([^\s]+?)(?:\.git)?\/?$/.exec(remote);
  if (!match) return null;
  const host = (match[1] ?? match[2]).toLowerCase();
  const projectKey = match[3].replace(/\.git$/, "");
  if (!projectKey || projectKey.split("/").some(segment => !segment || segment === "." || segment === "..")) return null;
  return { platform: host === "github.com" ? "github" : "gitlab", projectKey, host };
}

async function metadataFor(root: string): Promise<WorkspaceMetadata | null> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(root, "workspace.json"), "utf8")) as WorkspaceMetadata;
    if (!value || value.root !== root || typeof value.taskId !== "string" || !Array.isArray(value.repositories)) return null;
    return value;
  } catch {
    return null;
  }
}

function matchesProject(metadata: WorkspaceMetadata, project: Project): boolean {
  const id = `${project.platform}:${project.projectKey}#`;
  if (metadata.taskId.startsWith(id)) return true;
  return metadata.repositories.some(({ project: repository }) => repository?.platform === project.platform
    && (repository.projectKey === project.projectKey || repository.projectKey === `${project.host}/${project.projectKey}`)
    && (!repository.providerHost || repository.providerHost === project.host));
}

export function createProjectRunScopeService(options: {
  baseDirectory?: string;
  remoteUrl?: (workspace: string) => Promise<string>;
} = {}) {
  const baseDirectory = path.resolve(options.baseDirectory ?? path.join(homedir(), ".loop-workspace"));
  const remoteUrl = options.remoteUrl ?? (async (workspace: string) => {
    const result = await exec("git", ["remote", "get-url", "origin"], workspace);
    return result.ok ? result.stdout : "";
  });
  const runStore = createWorkItemRunStore({ resolveWorkspace: workspace => workspace });

  async function workspaces(selected: string): Promise<string[]> {
    const root = path.resolve(selected);
    const remote = await remoteUrl(root);
    const selectedMetadata = await metadataFor(root);
    const project = projectFromRemote(remote);
    const result = [root];
    if (!project && !selectedMetadata) return result;
    const pending = [baseDirectory];
    let visited = 0;
    while (pending.length && visited < 10_000) {
      const directory = pending.pop()!;
      let entries;
      try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || ["repositories", "artifacts", "runtime", "logs", "diagnostics"].includes(entry.name)) continue;
        const candidate = path.join(directory, entry.name);
        const metadata = await metadataFor(candidate);
        if (metadata) {
          if (candidate !== root && (project ? matchesProject(metadata, project) : metadata.taskId === selectedMetadata?.taskId)) result.push(candidate);
        } else pending.push(candidate);
        if (++visited >= 10_000) break;
      }
    }
    return result;
  }

  async function runs(selected: string, scopedWorkspaces?: string[]): Promise<ProjectRun[]> {
    const roots = scopedWorkspaces ?? await workspaces(selected);
    const records = await Promise.all(roots.map(async root => {
      const metadata = await metadataFor(root);
      if (!metadata) return [];
      return (await runStore.load(root)).filter(run => run.workspacePath === root).map(run => ({
        id: run.id, workItemId: metadata.taskId, status: run.status, startedAt: run.startedAt,
        workspacePath: root, ...(run.completedAt ? { completedAt: run.completedAt } : {}),
      }));
    }));
    return records.flat().sort((left, right) => right.startedAt.localeCompare(left.startedAt)).slice(0, 100);
  }

  return { workspaces, runs };
}

export const projectRunScopeService = createProjectRunScopeService();
