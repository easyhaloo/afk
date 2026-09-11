import { describe, expect, it } from "vitest";
import {
  parseWorkflowGraphGenerateRequest,
  validateWorkflowGraphTemplateId,
  validateWorkflowGraphWorkspace,
} from "../../electron/security/graph-validation";

describe("workflow graph IPC validation", () => {
  it("accepts absolute workspaces and kebab-case template IDs", () => {
    expect(validateWorkflowGraphWorkspace("/tmp/afk-project")).toBe("/tmp/afk-project");
    expect(validateWorkflowGraphTemplateId("sequential-review")).toBe("sequential-review");
  });

  it("rejects unsafe graph request values", () => {
    expect(() => validateWorkflowGraphWorkspace("relative/project")).toThrow("absolute");
    expect(() => validateWorkflowGraphTemplateId("../sequential-review")).toThrow("kebab-case");
    expect(() => parseWorkflowGraphGenerateRequest({ workspace: "/tmp/project", templateId: "review", format: "yaml" })).toThrow("unsupported");
    expect(() => parseWorkflowGraphGenerateRequest({ workspace: "/tmp/project", templateId: "review", extra: true })).toThrow("invalid");
  });

  it("normalizes a valid graph generation request", () => {
    expect(parseWorkflowGraphGenerateRequest({ workspace: "/tmp/project", templateId: "review" })).toEqual({
      workspace: "/tmp/project",
      templateId: "review",
    });
    expect(parseWorkflowGraphGenerateRequest({ workspace: "/tmp/project", templateId: "review", format: "archify-json" })).toEqual({
      workspace: "/tmp/project",
      templateId: "review",
      format: "archify-json",
    });
  });
});
