import path from "node:path";
import type { WorkflowGraphGenerateRequest, WorkflowGraphFormat } from "../../shared/ipc-contract";

const templateIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateWorkflowGraphWorkspace(value: unknown): string {
  if (typeof value !== "string" || !value || !path.isAbsolute(value)) throw new Error("workflow graph workspace must be an absolute path");
  return value;
}

export function validateWorkflowGraphTemplateId(value: unknown): string {
  if (typeof value !== "string" || !templateIdPattern.test(value)) throw new Error("workflow graph templateId must be kebab-case");
  return value;
}

function validateWorkflowGraphFormat(value: unknown): WorkflowGraphFormat | undefined {
  if (value === undefined) return undefined;
  if (value !== "json" && value !== "archify-json") throw new Error("unsupported workflow graph format");
  return value;
}

export function parseWorkflowGraphGenerateRequest(value: unknown): WorkflowGraphGenerateRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid workflow graph generation request");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "workspace" && key !== "templateId" && key !== "format")) throw new Error("invalid workflow graph generation request");
  if (!Object.prototype.hasOwnProperty.call(input, "workspace") || !Object.prototype.hasOwnProperty.call(input, "templateId")) throw new Error("invalid workflow graph generation request");
  const request: WorkflowGraphGenerateRequest = {
    workspace: validateWorkflowGraphWorkspace(input.workspace),
    templateId: validateWorkflowGraphTemplateId(input.templateId),
  };
  const format = validateWorkflowGraphFormat(input.format);
  if (format !== undefined) request.format = format;
  return request;
}
