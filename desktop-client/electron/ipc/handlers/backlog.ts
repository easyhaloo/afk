import { IPC_CHANNELS } from "../../../shared/ipc-contract.js";
import { parseBacklogCreateInput, parseBacklogId, parseBacklogListOptions } from "../../../shared/backlog-contract.js";
import { registerHandlerMulti } from "../handler-registry.js";
import { backlogExecutionService, backlogRuntimeService, backlogService } from "../ipc-services.js";
import { workspaceArgument } from "../ipc-arguments.js";

/**
 * The channels the backlog answers: the list, the actions, and the tags.
 */

export function registerBacklogHandlers() {
  registerHandlerMulti(IPC_CHANNELS.backlogList, [
    (v) => workspaceArgument(v, "backlog.list"),
    (v) => parseBacklogListOptions(v),
  ], ([workspace, options]) => backlogService.list(workspace, options));
  registerHandlerMulti(IPC_CHANNELS.backlogShow, [
    (v) => workspaceArgument(v, "backlog.show"),
    (v) => { if (typeof v !== "string" || !v) throw new Error("backlog.show: id 必须是字符串"); return v; },
  ], ([workspace, id]) => backlogService.show(workspace, id));
  registerHandlerMulti(IPC_CHANNELS.backlogCreate, [
    (v) => workspaceArgument(v, "backlog.create"),
    parseBacklogCreateInput,
  ], ([workspace, input]) => backlogService.create(workspace, input));
  registerHandlerMulti(IPC_CHANNELS.backlogStop, [
    (v) => workspaceArgument(v, "backlog.stop"),
    parseBacklogId,
  ], ([workspace, backlogId]) => backlogExecutionService.stop(workspace, backlogId));
  registerHandlerMulti(IPC_CHANNELS.backlogRecover, [
    (v) => workspaceArgument(v, "backlog.recover"),
    parseBacklogId,
  ], ([workspace, backlogId]) => backlogExecutionService.recover(workspace, backlogId));
  registerHandlerMulti(IPC_CHANNELS.backlogConfirmMerge, [
    (v) => workspaceArgument(v, "backlog.confirmMerge"),
    parseBacklogId,
  ], ([workspace, backlogId]) => backlogExecutionService.confirmMerge(workspace, backlogId));
  registerHandlerMulti(IPC_CHANNELS.backlogRuns, [
    (v) => workspaceArgument(v, "backlog.runs"),
    (v) => { if (v !== undefined && (typeof v !== "string" || !v)) throw new Error("backlog.runs: backlogId 必须是字符串"); return v as string | undefined; },
  ], ([workspace, backlogId]) => backlogExecutionService.list(workspace, backlogId));
  registerHandlerMulti(IPC_CHANNELS.backlogSummary, [
    (v) => workspaceArgument(v, "backlog.summary"),
    (v) => { if (typeof v !== "string" || !v) throw new Error("backlog.summary: backlogId 必须是字符串"); return v; },
  ], ([workspace, backlogId]) => backlogRuntimeService.summary(workspace, backlogId));
  registerHandlerMulti(IPC_CHANNELS.backlogTagAdd, [
    (v) => workspaceArgument(v, "backlog.tag.add"),
    (v) => { if (typeof v !== "string" || !v) throw new Error("backlog.tag.add: id 必须是字符串"); return v; },
    (v) => { if (typeof v !== "string" || !v) throw new Error("backlog.tag.add: tag 必须是字符串"); return v; },
  ], ([workspace, id, tag]) => backlogService.addTag(workspace, id, tag));
  registerHandlerMulti(IPC_CHANNELS.backlogTagRemove, [
    (v) => workspaceArgument(v, "backlog.tag.remove"),
    (v) => { if (typeof v !== "string" || !v) throw new Error("backlog.tag.remove: id 必须是字符串"); return v; },
    (v) => { if (typeof v !== "string" || !v) throw new Error("backlog.tag.remove: tag 必须是字符串"); return v; },
  ], ([workspace, id, tag]) => backlogService.removeTag(workspace, id, tag));
}
