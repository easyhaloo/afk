import type { ResourceRegistryPort } from "@afk/application";
import type { AfkResourceRecord } from "@afk/core";
import path from "node:path";
import { exec as defaultExec, executable as defaultExecutable } from "./process-executor.js";
import { normalizeTmuxSessionName } from "../../shared/tmux-session.js";

export type ResourceAdapterDeps = {
  registry: ResourceRegistryPort;
  readResources?: (workspaces: readonly string[]) => AfkResourceRecord[];
  exec?: typeof defaultExec;
  executable?: typeof defaultExecutable;
};

/**
 * The registered resources of the runtime, read through its port.
 *
 * The registry owns the table and the rows in it; this asks it what is
 * there rather than writing the query out again here, where a change to
 * the table would leave this reading a column that is no longer there.
 * Where the registry keeps its table is the registry's business, so the
 * path is not this adapter's to choose.
 */
export function createResourceAdapter(deps: ResourceAdapterDeps) {
  const readResources = deps.readResources ?? ((workspaces: readonly string[]) => deps.registry.readActive(workspaces));
  const exec = deps.exec ?? defaultExec;
  const executable = deps.executable ?? defaultExecutable;

  function resources(workspaces: readonly string[]) {
    const allowed = new Set(workspaces.map(workspace => path.resolve(workspace)));
    return readResources(workspaces).filter(resource => allowed.has(path.resolve(resource.workspacePath)));
  }

  async function listAfkContainers(workspaces: readonly string[]) {
    const output: Array<{ engine: string; name: string; image: string; status: string }> = [];
    for (const resource of resources(workspaces).filter(item => item.kind === "container" || item.kind === "isolate-service")) {
      const engine = resource.engine;
      if (!engine || !(await executable(engine))) continue;
      const identifier = resource.externalId || resource.name;
      const result = await exec(engine, ["inspect", "--format", "{{.State.Status}}\t{{.Name}}\t{{.Config.Image}}", identifier]);
      if (!result.ok) continue;
      const [status, rawName, image] = result.stdout.split("\t");
      output.push({ engine, name: (rawName || resource.name).replace(/^\//, ""), image: image || resource.detail || "—", status: status || "unknown" });
    }
    return output;
  }

  async function listAfkTmux(workspaces: readonly string[]) {
    if (!(await executable("tmux"))) return [] as Array<{ workspace: string; name: string; windows: string; attached: boolean; runId?: string; resourceId?: string }>;
    const output: Array<{ workspace: string; name: string; windows: string; attached: boolean; runId?: string; resourceId?: string }> = [];
    for (const resource of resources(workspaces).filter(item => item.kind === "tmux")) {
      const target = normalizeTmuxSessionName(resource.name);
      const exists = await exec("tmux", ["has-session", "-t", target]);
      if (!exists.ok) continue;
      const result = await exec("tmux", ["display-message", "-p", "-t", target, "#{session_windows}\t#{session_attached}"]);
      if (!result.ok) continue;
      const [windows, attached] = result.stdout.split("\t");
      output.push({ workspace: resource.workspacePath, name: resource.name, windows: windows || "0", attached: attached === "1", resourceId: resource.id, ...(resource.runId ? { runId: resource.runId } : {}) });
    }
    return output;
  }

  function isAfkTmuxSession(workspaces: readonly string[], name: string, ownerWorkspace?: string) {
    const owner = ownerWorkspace === undefined ? undefined : path.resolve(ownerWorkspace);
    return resources(workspaces).some(resource => resource.kind === "tmux"
      && resource.name === name
      && (owner === undefined || path.resolve(resource.workspacePath) === owner));
  }

  /** Run-scoped resource reader for the ADR-0019 exact attach target path. */
  function listRunResources(runId: string): AfkResourceRecord[] {
    return deps.registry.readRun(runId);
  }

  return { listAfkContainers, listAfkTmux, isAfkTmuxSession, listRunResources };
}

export type ResourceAdapter = ReturnType<typeof createResourceAdapter>;
