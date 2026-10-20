import { IPC_CHANNELS } from "../../../shared/ipc-contract.js";
import { parseWorkItemInventoryOptions, parseWorkItemRunStartInput } from "../../../shared/backlog-contract.js";
import { parseExecutionQueryOptions, type ExecutionRunDetail } from "../../../shared/execution-contract.js";
import { registerHandler, registerHandlerMulti } from "../handler-registry.js";
import {
  backlogService,
  executionAttachService,
  tmuxAttachPty,
  workItemExecutionQueryService,
  workItemExecutionService,
  workItemInventoryService,
  workItemRunHistoryService,
} from "../ipc-services.js";

/**
 * The channels the work item's detail answers: the inventory, the runs, and
 * the terminal a person can take over.
 */

export function registerWorkItemHandlers() {
  registerHandlerMulti(IPC_CHANNELS.workItemsList, [
    (v) => parseWorkItemInventoryOptions(v),
    (v) => { if (v !== undefined && typeof v !== "boolean") throw new Error("刷新参数无效"); return v as boolean | undefined; },
  ], ([options, forceRefresh]) => workItemInventoryService.list(options, forceRefresh === true).then(inventory => workItemRunHistoryService.merge(inventory)));
  registerHandler(IPC_CHANNELS.workItemsStart, parseWorkItemRunStartInput, (input) => workItemExecutionService.start(input).then(result => { backlogService.invalidateListCache(); return result; }));
  registerHandler(IPC_CHANNELS.workItemsExecutions, parseExecutionQueryOptions, async (options) => {
    const page = await workItemExecutionQueryService.list(options);
    return { executions: page.executions, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  });
  registerHandlerMulti(IPC_CHANNELS.workItemsExecutionRunDetail, [
    (value) => { if (typeof value !== "string" || !value.trim()) throw new Error("运行 ID 无效"); return value; },
    (value) => { if (typeof value !== "string" || !value.trim()) throw new Error("工作项 ID 无效"); return value; },
  ], async ([runId, workItemId]) => {
    const detail: ExecutionRunDetail = await workItemExecutionQueryService.detail(runId, workItemId);
    return detail;
  });
  registerHandler(IPC_CHANNELS.workItemsResolveAttachTarget, (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("接管参数无效");
    const input = value as Record<string, unknown>;
    if (typeof input.runId !== "string" || !input.runId.trim()) throw new Error("运行 ID 无效");
    if (input.workItemId !== undefined && typeof input.workItemId !== "string") throw new Error("工作项 ID 无效");
    if (input.resourceId !== undefined && (typeof input.resourceId !== "string" || !input.resourceId.trim())) throw new Error("执行环境 ID 无效");
    return { runId: input.runId, resourceId: input.resourceId as string | undefined };
  }, (request) => executionAttachService.resolve(request.runId, request.resourceId));
  registerHandler(IPC_CHANNELS.workItemsAttach, (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("接管参数无效");
    const input = value as Record<string, unknown>;
    if (typeof input.runId !== "string" || !input.runId.trim()) throw new Error("运行 ID 无效");
    if (input.resourceId !== undefined && (typeof input.resourceId !== "string" || !input.resourceId.trim())) throw new Error("执行环境 ID 无效");
    const cols = input.cols === undefined ? 120 : input.cols;
    const rows = input.rows === undefined ? 32 : input.rows;
    if (typeof cols !== "number" || typeof rows !== "number" || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 500 || rows > 200) throw new Error("终端尺寸无效");
    return { runId: input.runId, resourceId: input.resourceId as string | undefined, cols, rows };
  }, async (input) => {
    const resolved = await executionAttachService.resolve(input.runId, input.resourceId);
    if (!resolved.available || !resolved.attachTarget) throw new Error("unavailable" in resolved ? resolved.unavailable.reason : "执行环境不可接管");
    const attachId = tmuxAttachPty.attach(resolved.attachTarget, input.cols, input.rows);
    return { attachId, attachTarget: resolved.attachTarget, resourceId: resolved.environment.resourceId };
  });
  registerHandlerMulti(IPC_CHANNELS.workItemsAttachInput, [
    (value) => { if (typeof value !== "string" || !value.trim()) throw new Error("接管会话 ID 无效"); return value; },
    (value) => { if (typeof value !== "string" || value.includes("\0") || value.length > 8_000) throw new Error("终端输入无效"); return value; },
  ], ([attachId, data]) => tmuxAttachPty.input(attachId, data));
  registerHandlerMulti(IPC_CHANNELS.workItemsAttachResize, [
    (value) => { if (typeof value !== "string" || !value.trim()) throw new Error("接管会话 ID 无效"); return value; },
    (value) => { if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 500) throw new Error("终端列数无效"); return value; },
    (value) => { if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 200) throw new Error("终端行数无效"); return value; },
  ], ([attachId, cols, rows]) => tmuxAttachPty.resize(attachId, cols, rows));
  registerHandler(IPC_CHANNELS.workItemsDetach, (value) => {
    if (typeof value !== "string" || !value.trim()) throw new Error("接管会话 ID 无效");
    return value;
  }, (attachId) => tmuxAttachPty.detach(attachId));
}
