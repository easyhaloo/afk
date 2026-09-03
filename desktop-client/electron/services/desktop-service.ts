/** AFK Control security: only the main process runs a fixed, non-user-configurable diagnostics whitelist. */
import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import { exec, executable, firstLine } from "../adapters/process-executor";
import { listAfkContainers, listAfkTmux } from "../adapters/resource-adapter";
import { configNumber, configString, parseConfig, type ConfigObject } from "../workflow/config-parser";
import { detectAgentRuntimes } from "./runtime-service";
import { readEvents, resolveWorkspace } from "./workspace-service";

type CliCapability = {
  id: string;
  label: string;
  command: string;
  description: string;
  available: boolean;
};

type CanvasTemplateNode = { id: string; template: "agent" | "qa"; label: string; description: string; prompt: string; provider?: string; x: number; y: number };

type WorkflowTemplateStepSummary = { id: string; role: string; kind: "agent" | "system"; provider?: string; action?: string; when?: { step: string; equals: string }; dependsOn: string[] };
type WorkflowTemplateSummary = { id: string; name: string; description: string; source: "builtin" | "project" | "managed"; steps: WorkflowTemplateStepSummary[] };

type WorkflowConfigSummary = {
  configPath: string;
  source: "project" | "cli-defaults";
  agentDefault: string;
  tmuxSession: string;
  targetBranch: string;
  baseBranch: string;
  maxRetries: number;
  hardTimeoutMs: number;
  completionTimeoutMs: number;
  contextThreshold: number;
  goalBudget: number;
  codex: { transport: string; auth: string; provider: string; profile?: string; endpoint?: string; authTokenEnv?: string; startupTimeoutMs: number };
  canvasNodes: CanvasTemplateNode[];
  templateName?: string;
};

type WorkflowRunSummary = {
  id: string;
  status: "running" | "completed" | "blocked" | "failed" | "aborted" | "timed_out" | "context_high";
  startedAt: string;
  goal: string;
  provider: string;
  transport?: string;
  auth?: string;
  modelProvider?: string;
  worktreePath: string;
  sessionId?: string;
  branch?: string;
  error?: string;
};

type LoopStatus = {
  state: "running" | "stopped";
  pid?: number;
  implement: { active: number; ids: string[] };
  qa: { active: number | null; queue: string[] };
  totals: { completed: number; failed: number };
  startedAt?: number;
  lastUpdateAt?: number;
  lastError?: string;
};

const AFK_CAPABILITY_DEFINITIONS: Omit<CliCapability, "available">[] = [
  { id: "run", label: "单次工作流", command: "afk run", description: "领取并执行一个 backlog 项目" },
  { id: "loop", label: "持续循环", command: "afk loop", description: "轮询、实现、QA 与完成的守护工作流" },
  { id: "qa", label: "质量验证", command: "afk qa", description: "运行 AFK 质量检查与验证流程" },
  { id: "board", label: "任务看板", command: "afk board", description: "读取和维护工作项状态" },
  { id: "isolate", label: "隔离环境", command: "afk isolate", description: "管理 worktree 的 Compose 隔离服务" },
  { id: "tmux", label: "终端会话", command: "afk tmux", description: "管理 AFK 工作流的 tmux 会话" },
  { id: "debug", label: "调试循环", command: "afk debug", description: "复现、诊断、修复与验证问题" },
  { id: "signal", label: "完成信号", command: "afk signal", description: "写入与读取工作流完成信号" },
];


function validSession(value: string) {
  return /^[A-Za-z0-9_.:-]{1,100}$/.test(value);
}



async function readWorkflowConfig(root: string): Promise<WorkflowConfigSummary> {
  const configPath = path.join(root, ".afk", "config.yml");
  const raw = await fs.readFile(configPath, "utf8").catch(() => "");
  const values = parseConfig(raw);
  return {
    configPath,
    source: raw ? "project" : "cli-defaults",
    agentDefault: configString(values, "agentDefault", process.env.AFK_AGENT_DEFAULT || "claude-code"),
    tmuxSession: configString(values, "tmuxSession", process.env.AFK_TMUX_SESSION || "afk"),
    targetBranch: configString(values, "targetBranch", process.env.AFK_TARGET_BRANCH || "main"),
    baseBranch: configString(values, "trackerTargetBranch", process.env.AFK_TRACKER_TARGET_BRANCH || process.env.AFK_TARGET_BRANCH || "main"),
    maxRetries: configNumber(values, "maxRetries", Number(process.env.AFK_MAX_RETRIES) || 2),
    hardTimeoutMs: configNumber(values, "workflowHardTimeout", Number(process.env.AFK_WORKFLOW_HARD_TIMEOUT) || 7_200_000),
    completionTimeoutMs: configNumber(values, "completionTimeout", Number(process.env.AFK_COMPLETION_TIMEOUT) || 7_200_000),
    contextThreshold: configNumber(values, "contextThreshold", Number(process.env.AFK_CONTEXT_THRESHOLD) || 100_000),
    goalBudget: configNumber(values, "goalBudget", 10_000_000),
    codex: {
      transport: configString(values, "agents.codex.transport", process.env.AFK_CODEX_TRANSPORT || "auto"),
      auth: configString(values, "agents.codex.auth", process.env.AFK_CODEX_AUTH || "auto"),
      provider: configString(values, "agents.codex.provider", process.env.AFK_CODEX_PROVIDER || "auto"),
      profile: configString(values, "agents.codex.profile", process.env.AFK_CODEX_PROFILE || "" ) || undefined,
      endpoint: configString(values, "agents.codex.appServer.endpoint", process.env.AFK_CODEX_APP_SERVER || "") || undefined,
      authTokenEnv: configString(values, "agents.codex.appServer.authTokenEnv", process.env.AFK_CODEX_APP_SERVER_AUTH_ENV || "") || undefined,
      startupTimeoutMs: configNumber(values, "agents.codex.appServer.startupTimeoutMs", Number(process.env.AFK_CODEX_APP_SERVER_STARTUP_TIMEOUT) || 30_000),
    },
    templateName: configString(values, "template", "") || undefined,
    canvasNodes: raw ? await readCanvasNodes(root, raw, configString(values, "template", "") || undefined) : [],
  };
}



const BUILTIN_WORKFLOW_TEMPLATES: WorkflowTemplateSummary[] = [
  { id: "issue-implementation", name: "Issue 实现", description: "实现需求、验证 AC、发布变更并进入 QA。", source: "builtin", steps: [{ id: "implement", role: "implementer", kind: "agent", dependsOn: [] }, { id: "verify-ac", role: "verifier", kind: "agent", dependsOn: ["implement"] }, { id: "publish", role: "system", kind: "system", action: "publish-change", dependsOn: ["verify-ac"] }, { id: "queue-qa", role: "system", kind: "system", action: "queue-qa", dependsOn: ["publish"] }] },
  { id: "pre-merge-qa-verification", name: "合并前 QA", description: "在 QA 工作树中验证验收条件与集成测试。", source: "builtin", steps: [{ id: "verify-ac", role: "verifier", kind: "agent", dependsOn: [] }] },
  { id: "simple-loop", name: "简单循环", description: "单一 Agent 持续执行，直到任务完成。", source: "builtin", steps: [{ id: "run", role: "agent", kind: "agent", dependsOn: [] }] },
  { id: "sequential-review", name: "顺序审查", description: "实现、审查，并在失败时修复。", source: "builtin", steps: [{ id: "implement", role: "implementer", kind: "agent", dependsOn: [] }, { id: "review", role: "reviewer", kind: "agent", dependsOn: ["implement"] }, { id: "fix", role: "implementer", kind: "agent", when: { step: "review", equals: "failed" }, dependsOn: ["review"] }] },
  { id: "parallel-planner", name: "并行规划", description: "多个规划 Agent 并行分析同一事项。", source: "builtin", steps: [{ id: "plan-frontend", role: "planner", kind: "agent", dependsOn: [] }, { id: "plan-backend", role: "planner", kind: "agent", dependsOn: [] }, { id: "plan-infra", role: "planner", kind: "agent", dependsOn: [] }] },
  { id: "planner-with-review", name: "规划与审查", description: "并行规划后汇总审查，失败时安排修复。", source: "builtin", steps: [{ id: "plan-frontend", role: "planner", kind: "agent", dependsOn: [] }, { id: "plan-backend", role: "planner", kind: "agent", dependsOn: [] }, { id: "review", role: "reviewer", kind: "agent", dependsOn: ["plan-frontend", "plan-backend"] }, { id: "fix", role: "implementer", kind: "agent", dependsOn: ["review"] }] },
];

function templateStepSummary(value: unknown): WorkflowTemplateStepSummary | null {
  const step = asConfigObject(value);
  const id = typeof step.id === "string" ? step.id : "";
  if (!id) return null;
  const when = asConfigObject(step.when);
  return { id, role: typeof step.role === "string" ? step.role : "system", kind: step.kind === "system" ? "system" : "agent", provider: typeof step.provider === "string" ? step.provider : undefined, action: typeof step.action === "string" ? step.action : undefined, when: typeof when.step === "string" && typeof when.equals === "string" ? { step: when.step, equals: when.equals } : undefined, dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.filter((item): item is string => typeof item === "string") : [] };
}

async function readWorkflowTemplates(root: string): Promise<WorkflowTemplateSummary[]> {
  const directory = path.join(root, ".afk", "workflows");
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[]);
  const projectTemplates: WorkflowTemplateSummary[] = [];
  for (const entry of entries.filter(item => item.isFile() && /\.ya?ml$/i.test(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const document = asConfigObject(loadYaml(await fs.readFile(path.join(directory, entry.name), "utf8")));
      const id = typeof document.name === "string" ? document.name : path.basename(entry.name).replace(/\.ya?ml$/i, "");
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) continue;
      const steps = Array.isArray(document.steps) ? document.steps.map(templateStepSummary).filter((item): item is WorkflowTemplateStepSummary => item !== null) : [];
      if (!steps.length) continue;
      projectTemplates.push({ id, name: id === "afk-control-workflow" ? "自定义工作流" : id, description: typeof document.description === "string" ? document.description : "项目级 AFK 工作流模板", source: id === "afk-control-workflow" ? "managed" : "project", steps });
    } catch { /* A malformed project template stays outside the selectable list. */ }
  }
  const merged = new Map(BUILTIN_WORKFLOW_TEMPLATES.map(item => [item.id, item]));
  projectTemplates.forEach(item => merged.set(item.id, item));
  return [...merged.values()];
}


type WorkflowConfigPatch = {
  agentDefault: string;
  tmuxSession: string;
  targetBranch: string;
  baseBranch: string;
  maxRetries: number;
  hardTimeoutMs: number;
  completionTimeoutMs: number;
  contextThreshold: number;
  goalBudget: number;
  codex: { transport: string; auth: string; provider: string; profile?: string; endpoint?: string; authTokenEnv?: string; startupTimeoutMs: number };
  canvasNodes: CanvasTemplateNode[];
  templateName?: string;
};

const EDITABLE_AGENT_PROVIDERS = new Set(["claude-code", "codex", "cursor", "pi", "opencode", "copilot"]);
const EDITABLE_CODEX_TRANSPORTS = new Set(["auto", "exec", "app-server"]);
const EDITABLE_CODEX_AUTHS = new Set(["auto", "chatgpt", "api"]);

function asConfigObject(value: unknown): ConfigObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ConfigObject : {};
}

function textField(value: unknown, field: string, maxLength = 160): string {
  if (typeof value !== "string") throw new Error(field + " 必须是文本");
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f]/.test(normalized)) throw new Error(field + " 格式无效");
  return normalized;
}

function optionalTextField(value: unknown, field: string, maxLength = 320): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return textField(value, field, maxLength);
}

function positiveInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(field + " 必须在 " + min + " 到 " + max + " 之间");
  return value;
}

function branchField(value: unknown, field: string): string {
  const branch = textField(value, field, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes("..") || branch.endsWith("/")) throw new Error(field + " 不是有效 Git 分支名");
  return branch;
}

function endpointField(value: unknown): string | undefined {
  const endpoint = optionalTextField(value, "Codex App Server 地址", 320);
  if (!endpoint) return undefined;
  if (endpoint === "stdio://") return endpoint;
  try {
    const parsed = new URL(endpoint);
    if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) throw new Error("unsupported protocol");
    return endpoint;
  } catch { throw new Error("Codex App Server 地址必须是 http(s)、ws(s) 或 stdio:// 地址"); }
}

function cleanWorkflowPatch(value: unknown): WorkflowConfigPatch {
  const patch = asConfigObject(value);
  const codex = asConfigObject(patch.codex);
  const agentDefault = textField(patch.agentDefault, "默认 Agent", 40);
  if (!EDITABLE_AGENT_PROVIDERS.has(agentDefault)) throw new Error("默认 Agent 不受当前 AFK CLI 支持");
  const tmuxSession = textField(patch.tmuxSession, "tmux 会话", 100);
  if (!validSession(tmuxSession)) throw new Error("tmux 会话只能包含字母、数字、点、下划线、连字符或冒号");
  const transport = textField(codex.transport, "Codex 传输", 24);
  if (!EDITABLE_CODEX_TRANSPORTS.has(transport)) throw new Error("Codex 传输值无效");
  const auth = textField(codex.auth, "Codex 鉴权", 24);
  if (!EDITABLE_CODEX_AUTHS.has(auth)) throw new Error("Codex 鉴权值无效");
  const authTokenEnv = optionalTextField(codex.authTokenEnv, "Token 环境变量", 100);
  if (authTokenEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(authTokenEnv)) throw new Error("Token 环境变量名称无效");
  return {
    agentDefault,
    tmuxSession,
    targetBranch: branchField(patch.targetBranch, "目标分支"),
    baseBranch: branchField(patch.baseBranch, "基准分支"),
    maxRetries: positiveInteger(patch.maxRetries, "最大重试", 0, 20),
    hardTimeoutMs: positiveInteger(patch.hardTimeoutMs, "工作流超时", 1_000, 86_400_000),
    completionTimeoutMs: positiveInteger(patch.completionTimeoutMs, "完成等待", 1_000, 86_400_000),
    contextThreshold: positiveInteger(patch.contextThreshold, "上下文阈值", 1_000, 10_000_000),
    goalBudget: positiveInteger(patch.goalBudget, "目标令牌预算", 1_000, 100_000_000),
    codex: {
      transport,
      auth,
      provider: textField(codex.provider, "Codex 模型提供方", 120),
      profile: optionalTextField(codex.profile, "Codex Profile", 120),
      endpoint: endpointField(codex.endpoint),
      authTokenEnv,
      startupTimeoutMs: positiveInteger(codex.startupTimeoutMs, "Codex 启动超时", 1_000, 300_000),
    },
    canvasNodes: cleanCanvasNodes(patch.canvasNodes),
    templateName: templateNameField(patch.templateName),
  };
}

function cleanCanvasNodes(value: unknown): CanvasTemplateNode[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 12) throw new Error("画布节点必须是最多 12 个模板节点的列表");
  const ids = new Set<string>();
  return value.map((item, index) => {
    const node = asConfigObject(item);
    const id = textField(node.id, "画布节点 ID", 80);
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id) || ids.has(id)) throw new Error("画布节点 ID 无效或重复");
    ids.add(id);
    const template = textField(node.template, "画布节点类型", 20);
    if (template !== "agent" && template !== "qa") throw new Error("画布节点类型仅支持 agent 或 qa");
    const description = optionalTextField(node.description, "画布节点说明", 180) || (template === "qa" ? "验证验收条件与集成质量" : "实现当前工作项并提交执行摘要");
    const prompt = optionalTextField(node.prompt, "画布节点执行指令", 1_600) || (template === "qa" ? "Verify the implemented backlog change against its acceptance criteria. Report concise PASS or FAIL evidence before completion." : "Implement the assigned backlog item in the current AFK worktree. Follow the repository conventions, run relevant checks, and leave a concise completion summary.");
    const provider = optionalTextField(node.provider, "节点 Agent", 40);
    if (provider && !EDITABLE_AGENT_PROVIDERS.has(provider)) throw new Error("节点 Agent 不受当前 AFK CLI 支持");
    return { id, template, label: textField(node.label, "画布节点名称", 80), description, prompt, provider, x: positiveInteger(node.x, "画布节点横向位置", 0, 1400), y: positiveInteger(node.y, "画布节点纵向位置", 0, 440) } as CanvasTemplateNode;
  });
}

function templateNameField(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const name = textField(value, "工作流模板名称", 80);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error("工作流模板名称只能使用小写字母、数字和连字符");
  return name;
}

function canvasLayoutNodes(raw: string): CanvasTemplateNode[] {
  try {
    const document = asConfigObject(loadYaml(raw));
    const desktop = asConfigObject(document.desktop);
    const canvas = asConfigObject(desktop.canvas);
    return cleanCanvasNodes(canvas.nodes);
  } catch { return []; }
}

async function readCanvasNodes(root: string, raw: string, templateName: string | undefined): Promise<CanvasTemplateNode[]> {
  const layout = canvasLayoutNodes(raw);
  if (!templateName || !layout.length) return [];
  const templatePath = path.join(root, ".afk", "workflows", templateName + ".yml");
  try {
    const document = asConfigObject(loadYaml(await fs.readFile(templatePath, "utf8")));
    const steps = Array.isArray(document.steps) ? document.steps : [];
    const actual = new Map(steps.map(step => { const entry = asConfigObject(step); return [entry.id, entry]; }));
    return layout.filter(node => { const step = actual.get(node.id); if (!step) return false; const role = String(step.role || ""); return node.template === "qa" ? role === "reviewer" : role !== "reviewer"; });
  } catch { return []; }
}

function managedTemplateDocument(templateName: string, nodes: CanvasTemplateNode[], provider: string): ConfigObject {
  const steps = nodes.map((node, index) => {
    const step: ConfigObject = {
      id: node.id,
      kind: "agent",
      role: node.template === "qa" ? "reviewer" : "implementer",
      prompt: node.prompt,
      provider: node.provider || provider,
    };
    if (index > 0) step.dependsOn = [nodes[index - 1].id];
    return step;
  });
  return { name: templateName, version: 1, description: "AFK Control managed workflow template", defaultProvider: provider, steps };
}

async function saveManagedTemplate(root: string, templateName: string, nodes: CanvasTemplateNode[], provider: string) {
  const directory = path.join(root, ".afk", "workflows");
  const templatePath = path.join(directory, templateName + ".yml");
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = templatePath + ".tmp-" + process.pid + "-" + Date.now();
  await fs.writeFile(temporaryPath, dumpYaml(managedTemplateDocument(templateName, nodes, provider), { noRefs: true, lineWidth: 100 }), "utf8");
  await fs.rename(temporaryPath, templatePath);
}

function assignOptional(target: ConfigObject, key: string, value: string | undefined) {
  if (value === undefined) delete target[key];
  else target[key] = value;
}

export async function saveWorkflowConfig(workspace: string, value: unknown): Promise<WorkflowConfigSummary> {
  const root = resolveWorkspace(workspace);
  const patch = cleanWorkflowPatch(value);
  const configPath = path.join(root, ".afk", "config.yml");
  const existingRaw = await fs.readFile(configPath, "utf8").catch(() => "");
  let existing: ConfigObject = {};
  if (existingRaw) {
    try { existing = asConfigObject(loadYaml(existingRaw)); }
    catch { throw new Error("现有 .afk/config.yml 无法解析，未写入任何更改"); }
  }
  const next: ConfigObject = { ...existing };
  next.agentDefault = patch.agentDefault;
  next.tmuxSession = patch.tmuxSession;
  next.targetBranch = patch.targetBranch;
  next.trackerTargetBranch = patch.baseBranch;
  next.maxRetries = patch.maxRetries;
  next.workflowHardTimeout = patch.hardTimeoutMs;
  next.completionTimeout = patch.completionTimeoutMs;
  next.contextThreshold = patch.contextThreshold;
  next.goalBudget = patch.goalBudget;
  const agents = { ...asConfigObject(next.agents) };
  const codex = { ...asConfigObject(agents.codex) };
  const appServer = { ...asConfigObject(codex.appServer) };
  codex.transport = patch.codex.transport;
  codex.auth = patch.codex.auth;
  codex.provider = patch.codex.provider;
  assignOptional(codex, "profile", patch.codex.profile);
  assignOptional(appServer, "endpoint", patch.codex.endpoint);
  assignOptional(appServer, "authTokenEnv", patch.codex.authTokenEnv);
  appServer.startupTimeoutMs = patch.codex.startupTimeoutMs;
  codex.appServer = appServer;
  agents.codex = codex;
  next.agents = agents;
  if (patch.canvasNodes.length) {
    const templateName = patch.templateName || "afk-control-workflow";
    await saveManagedTemplate(root, templateName, patch.canvasNodes, patch.agentDefault);
    next.template = templateName;
  } else if (patch.templateName) {
    next.template = patch.templateName;
  } else {
    delete next.template;
  }
  const desktop = { ...asConfigObject(next.desktop) };
  const canvas = { ...asConfigObject(desktop.canvas), nodes: patch.canvasNodes };
  desktop.canvas = canvas;
  next.desktop = desktop;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const temporaryPath = configPath + ".tmp-" + process.pid + "-" + Date.now();
  await fs.writeFile(temporaryPath, dumpYaml(next, { noRefs: true, lineWidth: 100 }), "utf8");
  await fs.rename(temporaryPath, configPath);
  return readWorkflowConfig(root);
}

function jsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

function textValue(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

async function readWorkflowRuns(root: string): Promise<WorkflowRunSummary[]> {
  const runRoot = path.join(root, ".afk", "runs");
  const directories = await fs.readdir(runRoot, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[]);
  const runs: WorkflowRunSummary[] = [];
  for (const entry of directories.filter(item => item.isDirectory()).sort((left, right) => right.name.localeCompare(left.name)).slice(0, 40)) {
    const dir = path.join(runRoot, entry.name);
    const request = jsonRecord(await fs.readFile(path.join(dir, "request.json"), "utf8").catch(() => ""));
    const result = jsonRecord(await fs.readFile(path.join(dir, "result.json"), "utf8").catch(() => ""));
    if (!Object.keys(request).length && !Object.keys(result).length) continue;
    const rawStatus = textValue(result, "status");
    const status = rawStatus === "completed" || rawStatus === "blocked" || rawStatus === "failed" || rawStatus === "aborted" || rawStatus === "timed_out" || rawStatus === "context_high" ? rawStatus : "running";
    const error = result.error;
    runs.push({
      id: textValue(request, "runId") || textValue(result, "runId") || entry.name,
      status,
      startedAt: textValue(request, "startedAt") || "",
      goal: textValue(request, "goalText") || "AFK 工作流",
      provider: textValue(request, "provider") || textValue(result, "provider") || "—",
      transport: textValue(request, "agentTransport"),
      auth: textValue(request, "agentAuth"),
      modelProvider: textValue(request, "agentModelProvider"),
      worktreePath: textValue(request, "worktreePath") || root,
      sessionId: textValue(result, "sessionId"),
      branch: textValue(result, "branch"),
      error: error && typeof error === "object" ? textValue(error as Record<string, unknown>, "message") : undefined,
    });
  }
  return runs.sort((left, right) => Date.parse(right.startedAt || "0") - Date.parse(left.startedAt || "0"));
}

function processAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function readLoopStatus(): Promise<LoopStatus> {
  const raw = await fs.readFile(path.join(homedir(), ".afk", "loop-status.json"), "utf8").catch(() => "");
  const record = jsonRecord(raw);
  const pid = typeof record.pid === "number" ? record.pid : undefined;
  const implement = record.implement && typeof record.implement === "object" ? record.implement as Record<string, unknown> : {};
  const qa = record.qa && typeof record.qa === "object" ? record.qa as Record<string, unknown> : {};
  const totals = record.totals && typeof record.totals === "object" ? record.totals as Record<string, unknown> : {};
  return {
    state: pid && processAlive(pid) ? "running" : "stopped",
    pid,
    implement: { active: typeof implement.active === "number" ? implement.active : 0, ids: Array.isArray(implement.ids) ? implement.ids.map(String) : [] },
    qa: { active: typeof qa.active === "number" ? qa.active : null, queue: Array.isArray(qa.queue) ? qa.queue.map(String) : [] },
    totals: { completed: typeof totals.completed === "number" ? totals.completed : 0, failed: typeof totals.failed === "number" ? totals.failed : 0 },
    startedAt: typeof record.startedAt === "number" ? record.startedAt : undefined,
    lastUpdateAt: typeof record.lastUpdateAt === "number" ? record.lastUpdateAt : undefined,
    lastError: record.lastError && typeof record.lastError === "object" ? textValue(record.lastError as Record<string, unknown>, "message") : undefined,
  };
}

export async function snapshot(workspace?: string) {
  const root = resolveWorkspace(workspace);
  const afkPath = await executable("afk");
  const version = afkPath ? await exec(afkPath, ["--version"], root) : { ok: false, stdout: "", stderr: "未在 PATH 中发现 afk" };
  const [events, containers, sessions, agentRuntimes, workflow, workflowRuns, loop, workflowTemplates] = await Promise.all([
    readEvents(root),
    listAfkContainers(root),
    listAfkTmux(root),
    detectAgentRuntimes(),
    readWorkflowConfig(root),
    readWorkflowRuns(root),
    readLoopStatus(),
    readWorkflowTemplates(root),
  ]);
  const afkAvailable = Boolean(afkPath) && version.ok;
  return {
    workspace: { root, afkDirectoryPresent: existsSync(path.join(root, ".afk")), eventCount: events.length },
    afk: { available: afkAvailable, executable: afkPath || "afk", summary: version.ok ? firstLine(version.stdout || version.stderr, "AFK 已就绪") : firstLine(version.stderr, "AFK 未就绪") },
    capabilities: AFK_CAPABILITY_DEFINITIONS.map(item => ({ ...item, available: afkAvailable })),
    workflow,
    workflowTemplates,
    workflowRuns,
    loop,
    agentRuntimes,
    events,
    containers,
    sessions,
  };
}
