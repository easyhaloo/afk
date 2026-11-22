import { assertExactKeys, parseObject, parseRequiredString } from "./validation.js";
import { isWorkItemProjectKey } from "@afk/core";
import { parseWorkItemId } from "./backlog-contract.js";

export type DesktopExperience = {
  id: string;
  scope: string;
  status: "candidate" | "verified" | "revoked";
  trigger: string;
  rootCause: string;
  action: string;
  evidence: string[];
  source: { runId: string; workItemId: string };
  expiresAt: string;
  occurrences: number;
  verifiedEvidence?: { runId: string; evidence: string[]; verifiedAt: string };
};

export type ExperienceQuery = { scope: string; prompt?: string };
export type ExperienceSelection = { scope: string; id: string };
export type ExperienceVerifyInput = ExperienceSelection & { runId: string; action: string };
export type ExperienceOutcomeQuery = { scope: string; runId: string; workItemId: string; limit?: number };
export type DesktopExperienceOutcome = {
  experienceId: string;
  selectionId: string;
  runId: string;
  workItemId: string;
  event: { sequence: number; type: "run.finished" | "qa.failed" | "failure.classified" | "human_gate.opened"; outcome: "succeeded" | "failed" | "cancelled" | "awaiting_merge"; occurredAt: string };
  recurrence: boolean;
  benefit: "unknown";
  recordedAt: string;
  publication?: { key: string; candidateId: string; validatedVersion: number };
};
export type DesktopExperienceApi = {
  projects(): Promise<string[]>;
  list(input: ExperienceQuery): Promise<DesktopExperience[]>;
  outcomes(input: ExperienceOutcomeQuery): Promise<DesktopExperienceOutcome[]>;
  verify(input: ExperienceVerifyInput): Promise<DesktopExperience>;
  revoke(input: ExperienceSelection): Promise<DesktopExperience>;
};

function text(value: unknown, label: string, max: number): string {
  const result = parseRequiredString(value, label).trim();
  if (result.length > max) throw new Error(`${label} 过长`);
  return result;
}

export function parseExperienceScope(value: unknown): string {
  const scope = text(value, "项目范围", 512);
  if (!/^(github|gitlab):/.test(scope) || !isWorkItemProjectKey(scope.slice(scope.indexOf(":") + 1))) throw new Error("请选择合法项目范围");
  return scope;
}

export function parseExperienceQuery(value: unknown): ExperienceQuery {
  const input = parseObject(value, "经验查询");
  assertExactKeys(input, ["scope", "prompt"], "经验查询");
  return { scope: parseExperienceScope(input.scope), ...(input.prompt === undefined ? {} : { prompt: text(input.prompt, "召回内容", 2000) }) };
}

export function parseExperienceOutcomeQuery(value: unknown): ExperienceOutcomeQuery & { limit: number } {
  const input = parseObject(value, "经验结果查询");
  assertExactKeys(input, ["scope", "runId", "workItemId", "limit"], "经验结果查询");
  const scope = parseExperienceScope(input.scope);
  const runId = text(input.runId, "运行 ID", 512);
  const workItemId = parseWorkItemId(input.workItemId);
  if (workItemId.slice(0, workItemId.lastIndexOf("#")) !== scope) throw new Error("工作项必须属于所选项目");
  const limit = input.limit === undefined ? 20 : input.limit;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0 || limit > 100) throw new Error("结果数量必须是 0 到 100 的安全整数");
  return { scope, runId, workItemId, limit };
}

export function parseExperienceSelection(value: unknown): ExperienceSelection {
  const input = parseObject(value, "经验选择");
  assertExactKeys(input, ["scope", "id"], "经验选择");
  const id = text(input.id, "经验 ID", 36);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new Error("经验 ID 无效");
  return { scope: parseExperienceScope(input.scope), id };
}

export function parseExperienceVerify(value: unknown): ExperienceVerifyInput {
  const input = parseObject(value, "经验验证");
  assertExactKeys(input, ["scope", "id", "runId", "action"], "经验验证");
  return { ...parseExperienceSelection({ scope: input.scope, id: input.id }), runId: text(input.runId, "独立验证运行", 512), action: text(input.action, "已验证修正", 4096) };
}

export function parseNoInput(value: unknown): undefined {
  if (value !== undefined) throw new Error("此操作不接受参数");
  return undefined;
}
