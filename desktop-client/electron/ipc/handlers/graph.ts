import { IPC_CHANNELS } from "../../../shared/ipc-contract.js";
import { parseWorkflowGraphGenerateRequest, validateWorkflowGraphTemplateId, validateWorkflowGraphWorkspace } from "../../security/graph-validation.js";
import { registerHandler, registerHandlerMulti } from "../handler-registry.js";
import { workflowGraphService } from "../ipc-services.js";

/**
 * The channels that draw the workflow graph.
 */

export function registerGraphHandlers() {
  registerHandlerMulti(IPC_CHANNELS.graphStatus, [
    (v) => validateWorkflowGraphWorkspace(v),
    (v) => validateWorkflowGraphTemplateId(v),
  ], ([workspace, templateId]) => workflowGraphService.status(workspace, templateId));
  registerHandler(IPC_CHANNELS.graphGenerate, parseWorkflowGraphGenerateRequest, (request) => workflowGraphService.generate(request));
}
