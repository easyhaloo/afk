import { IPC_CHANNELS } from "../../../shared/ipc-contract.js";
import { normalizeTmuxSessionName } from "../../../shared/tmux-session.js";
import { exec } from "../../adapters/process-executor.js";
import { projectRunScopeService } from "../../services/project-run-scope-service.js";
import { resolveWorkspace } from "../../services/workspace-service.js";
import { registerHandlerMulti } from "../handler-registry.js";
import { validSession, workspaceArgument } from "../ipc-arguments.js";
import { resourceAdapter } from "../ipc-services.js";

/**
 * The channels that read and drive the tmux sessions of the current
 * workspace.
 */

export function registerTmuxHandlers() {
  registerHandlerMulti(IPC_CHANNELS.tmuxPane, [
    (v) => workspaceArgument(v, "tmuxPane"),
    (v) => { if (typeof v !== "string" || !validSession(v)) throw new Error("tmux 会话名称无效"); return v; },
  ], async ([workspace, name]) => {
    const root = resolveWorkspace(workspace);
    const resourceWorkspaces = await projectRunScopeService.workspaces(root);
    if (!resourceAdapter.isAfkTmuxSession(resourceWorkspaces, name, root) || !(await resourceAdapter.listAfkTmux(resourceWorkspaces)).some((item) => item.name === name && item.workspace === root)) throw new Error("tmux 会话不是当前 AFK 工作区登记的资源，或已不存在");
    const result = await exec("tmux", ["capture-pane", "-p", "-t", normalizeTmuxSessionName(name), "-S", "-160"]);
    if (!result.ok) throw new Error(result.stderr);
    return result.stdout;
  });
  registerHandlerMulti(IPC_CHANNELS.tmuxSend, [
    (v) => workspaceArgument(v, "tmuxSend"),
    (v) => { if (typeof v !== "string" || !validSession(v)) throw new Error("tmux 会话名称无效"); return v; },
    (v) => { if (typeof v !== "string" || !v.trim() || v.length > 4_000 || v.includes("\0")) throw new Error("接管输入为空或超过安全长度"); return v; },
  ], async ([workspace, name, line]) => {
    const root = resolveWorkspace(workspace);
    const resourceWorkspaces = await projectRunScopeService.workspaces(root);
    if (!resourceAdapter.isAfkTmuxSession(resourceWorkspaces, name, root) || !(await resourceAdapter.listAfkTmux(resourceWorkspaces)).some((item) => item.name === name && item.workspace === root)) throw new Error("tmux 会话不是当前 AFK 工作区登记的资源，或已不存在");
    const result = await exec("tmux", ["send-keys", "-t", normalizeTmuxSessionName(name), line, "Enter"]);
    if (!result.ok) throw new Error(result.stderr);
    return true;
  });
}
