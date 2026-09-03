export type RuntimeEvent = {
  id: string;
  timestamp: string;
  source: string;
  status?: string;
  result: string;
  nextStep: string;
  raw: string;
};

export type AgentRuntime = {
  id: "claude" | "codex" | "cursor" | "pi" | "opencode" | "copilot";
  label: string;
  command: string;
  available: boolean;
  executable: string;
  summary: string;
  status: "available" | "missing" | "error";
  installation: { source: string; version: string; checkedAt: string };
};

export type CliCapability = {
  id: string;
  label: string;
  command: string;
  description: string;
  available: boolean;
};

export type CanvasTemplateNode = {
  id: string;
  template: "agent" | "qa";
  label: string;
  description: string;
  prompt: string;
  provider?: "claude-code" | "codex" | "cursor" | "pi" | "opencode" | "copilot";
  x: number;
  y: number;
};

export type WorkflowTemplateStepSummary = {
  id: string;
  role: string;
  kind: "agent" | "system";
  provider?: string;
  action?: string;
  when?: { step: string; equals: string };
  dependsOn: string[];
};

export type WorkflowTemplateSummary = {
  id: string;
  name: string;
  description: string;
  source: "builtin" | "project" | "managed";
  steps: WorkflowTemplateStepSummary[];
};

export type WorkflowConfigSummary = {
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

export type WorkflowRunSummary = {
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

export type LoopStatus = {
  state: "running" | "stopped";
  pid?: number;
  implement: { active: number; ids: string[] };
  qa: { active: number | null; queue: string[] };
  totals: { completed: number; failed: number };
  startedAt?: number;
  lastUpdateAt?: number;
  lastError?: string;
};

export type AppearancePreferences = {
  locale: "system" | "zh-CN" | "en-US";
  fontFamily: "system" | "serif" | "mono";
  fontScale: "small" | "medium" | "large";
  accent: "violet" | "teal" | "amber";
  theme: "light" | "graphite";
};

export type Snapshot = {
  workspace: { root: string; afkDirectoryPresent: boolean; eventCount: number };
  afk: { available: boolean; executable: string; summary: string };
  capabilities: CliCapability[];
  workflow: WorkflowConfigSummary;
  workflowTemplates: WorkflowTemplateSummary[];
  workflowRuns: WorkflowRunSummary[];
  loop: LoopStatus;
  agentRuntimes: AgentRuntime[];
  events: RuntimeEvent[];
  containers: Array<{ engine: string; name: string; image: string; status: string }>;
  sessions: Array<{ name: string; windows: string; attached: boolean }>;
};

export type DesktopApi = {
  chooseWorkspace: () => Promise<string | null>;
  snapshot: (workspace: string) => Promise<Snapshot>;
  appearance: () => Promise<AppearancePreferences>;
  saveAppearance: (appearance: AppearancePreferences) => Promise<AppearancePreferences>;
  saveWorkflow: (workspace: string, workflow: WorkflowConfigSummary) => Promise<WorkflowConfigSummary>;
  tmuxPane: (workspace: string, session: string) => Promise<string>;
  tmuxSend: (workspace: string, session: string, line: string) => Promise<boolean>;
  ssh: {
    list: () => Promise<SshListResult>;
    add: (input: ManagedSshHostInput) => Promise<SshHost>;
    remove: (hostId: string) => Promise<boolean>;
    trust: (request: SshTrustRequest) => Promise<SshFingerprint>;
    generateKey: () => Promise<{ publicKeyPath: string; session: SshSession }>;
    deployKey: (hostId: string) => Promise<SshSession>;
    test: (hostId: string) => Promise<SshTestResult>;
    connect: (hostId: string) => Promise<SshSession>;
    input: (request: SshInputRequest) => Promise<boolean>;
    resize: (request: SshResizeRequest) => Promise<boolean>;
    close: (sessionId: string) => Promise<boolean>;
    onData: (listener: (sessionId: string, data: string) => void) => () => void;
    onExit: (listener: (sessionId: string, code: number) => void) => () => void;
  };
};

export const IPC_CHANNELS = {
  chooseWorkspace: "afk:choose-workspace",
  snapshot: "afk:snapshot",
  appearance: "afk:appearance",
  appearanceSave: "afk:appearance-save",
  workflowSave: "afk:workflow-save",
  tmuxPane: "afk:tmux-pane",
  tmuxSend: "afk:tmux-send",
  sshList: "afk:ssh-list",
  sshAdd: "afk:ssh-add",
  sshRemove: "afk:ssh-remove",
  sshTrust: "afk:ssh-trust",
  sshGenerateKey: "afk:ssh-generate-key",
  sshDeployKey: "afk:ssh-deploy-key",
  sshTest: "afk:ssh-test",
  sshConnect: "afk:ssh-connect",
  sshInput: "afk:ssh-input",
  sshResize: "afk:ssh-resize",
  sshClose: "afk:ssh-close",
  sshData: "afk:ssh-data",
  sshExit: "afk:ssh-exit",
} as const;
import type {
  ManagedSshHostInput,
  SshFingerprint,
  SshHost,
  SshInputRequest,
  SshListResult,
  SshResizeRequest,
  SshSession,
  SshTestResult,
  SshTrustRequest,
} from "./ssh-contract";
