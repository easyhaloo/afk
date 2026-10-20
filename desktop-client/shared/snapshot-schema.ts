/**
 * The snapshot contract, expressed as a runtime schema.
 *
 * `Snapshot` is the widest DTO the desktop ships. It is assembled from data
 * the program does not control — YAML config, the JSONL audit spine, `tmux`
 * and `docker` output, provider inventories — and then handed to the
 * renderer as if it were well formed. The TypeScript type alone cannot catch
 * a malformed or partial record, so this module keeps one schema for the
 * whole graph and lets the main process check a payload before it crosses
 * the process seam.
 *
 * The module lives in `shared/` because both sides of the seam read it: the
 * main process validates what it is about to hand over, and the renderer
 * validates what it received. It therefore imports no Node built-in.
 */
import { z } from "zod";
import { WORK_ITEM_AGENT_IDS } from "./backlog-contract.js";
import { AGENT_PROVIDER_IDS, type Snapshot } from "./ipc-contract.js";

const agentProviderIdSchema = z.enum(AGENT_PROVIDER_IDS);
const workItemAgentIdSchema = z.enum(WORK_ITEM_AGENT_IDS);

const cliCapabilitySchema = z.object({
  id: z.string(),
  label: z.string(),
  command: z.string(),
  description: z.string(),
  available: z.boolean(),
});

const canvasTemplateNodeSchema = z.object({
  id: z.string(),
  template: z.enum(["agent", "qa"]),
  label: z.string(),
  description: z.string(),
  prompt: z.string(),
  provider: agentProviderIdSchema.optional(),
  x: z.number(),
  y: z.number(),
});

const workflowTemplateStepSummarySchema = z.object({
  id: z.string(),
  role: z.string(),
  kind: z.enum(["agent", "system"]),
  provider: z.string().optional(),
  action: z.string().optional(),
  when: z.object({ step: z.string(), equals: z.string() }).optional(),
  dependsOn: z.array(z.string()),
});

const workflowTemplateSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  source: z.enum(["builtin", "project", "managed"]),
  steps: z.array(workflowTemplateStepSummarySchema),
  canvasNodes: z.array(canvasTemplateNodeSchema).optional(),
});

const workflowConfigSummarySchema = z.object({
  configPath: z.string(),
  source: z.enum(["project", "cli-defaults"]),
  agentDefault: z.string(),
  tmuxSession: z.string(),
  targetBranch: z.string(),
  baseBranch: z.string(),
  maxRetries: z.number(),
  hardTimeoutMs: z.number(),
  completionTimeoutMs: z.number(),
  contextThreshold: z.number(),
  goalBudget: z.number(),
  codex: z.object({
    transport: z.string(),
    auth: z.string(),
    provider: z.string(),
    profile: z.string().optional(),
    endpoint: z.string().optional(),
    authTokenEnv: z.string().optional(),
    startupTimeoutMs: z.number(),
  }),
  canvasNodes: z.array(canvasTemplateNodeSchema),
  templateName: z.string().optional(),
});

const workflowRunSummarySchema = z.object({
  id: z.string(),
  status: z.enum(["running", "completed", "blocked", "failed", "aborted", "timed_out", "context_high"]),
  startedAt: z.string(),
  goal: z.string(),
  provider: z.string(),
  transport: z.string().optional(),
  auth: z.string().optional(),
  modelProvider: z.string().optional(),
  worktreePath: z.string(),
  sessionId: z.string().optional(),
  branch: z.string().optional(),
  error: z.string().optional(),
});

const loopStatusSchema = z.object({
  state: z.enum(["running", "stopped"]),
  pid: z.number().optional(),
  execution: z.object({ active: z.number(), ids: z.array(z.string()) }),
  totals: z.object({ completed: z.number(), failed: z.number() }),
  startedAt: z.number().optional(),
  lastUpdateAt: z.number().optional(),
  lastError: z.record(z.string()),
});

const agentRuntimeSchema = z.object({
  id: workItemAgentIdSchema,
  label: z.string(),
  command: z.string(),
  available: z.boolean(),
  executable: z.string(),
  summary: z.string(),
  status: z.enum(["available", "missing", "error"]),
  installation: z.object({ source: z.string(), version: z.string(), checkedAt: z.string() }),
});

const runtimeEventSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  source: z.string(),
  /**
   * The status the raw event line recorded, if it recorded one. Not the
   * audited status — that is the run row's, and it is the authority.
   */
  recordedStatus: z.string().optional(),
  result: z.string(),
  nextStep: z.string(),
  raw: z.string(),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    totalTokens: z.number(),
  }).optional(),
});

const projectRunSchema = z.object({
  id: z.string(),
  workItemId: z.string(),
  status: z.enum(["starting", "running", "completed", "failed"]),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  workspacePath: z.string(),
});

/** The whole snapshot graph, in one schema. */
export const snapshotSchema = z.object({
  workspace: z.object({
    root: z.string(),
    afkDirectoryPresent: z.boolean(),
    eventCount: z.number(),
  }),
  afk: z.object({
    available: z.boolean(),
    executable: z.string(),
    summary: z.string(),
  }),
  capabilities: z.array(cliCapabilitySchema),
  workflow: workflowConfigSummarySchema,
  workflowTemplates: z.array(workflowTemplateSummarySchema),
  workflowRuns: z.array(workflowRunSummarySchema),
  loop: loopStatusSchema,
  agentRuntimes: z.array(agentRuntimeSchema),
  events: z.array(runtimeEventSchema),
  workItemRuns: z.array(projectRunSchema),
  containers: z.array(z.object({
    engine: z.string(),
    name: z.string(),
    image: z.string(),
    status: z.string(),
  })),
  sessions: z.array(z.object({
    name: z.string(),
    workspace: z.string(),
    windows: z.string(),
    attached: z.boolean(),
    runId: z.string().optional(),
    resourceId: z.string().optional(),
  })),
});

/**
 * The schema and the TypeScript contract are two expressions of one fact, so
 * they are locked together at compile time: a change to either side that the
 * other does not follow fails `tsc` instead of drifting quietly.
 */
type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const snapshotContractHolds: AssertEqual<z.infer<typeof snapshotSchema>, Snapshot> = true;
void snapshotContractHolds;

export class SnapshotContractError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`快照数据不符合契约：${issues.join("；")}`);
    this.name = "SnapshotContractError";
    this.issues = issues;
  }
}

function describeIssues(error: z.ZodError): string[] {
  return error.issues.map(issue => `${issue.path.join(".") || "(根)"}：${issue.message}`);
}

/**
 * Check a payload against the snapshot contract.
 *
 * Throws {@link SnapshotContractError} with the offending paths, so a caller
 * can report what was wrong instead of shipping a half-formed record.
 */
export function parseSnapshot(value: unknown): Snapshot {
  const result = snapshotSchema.safeParse(value);
  if (!result.success) throw new SnapshotContractError(describeIssues(result.error));
  return result.data;
}
