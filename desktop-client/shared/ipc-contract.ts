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
  copyText: (text: string) => Promise<boolean>;
  openExternal: (url: string) => Promise<boolean>;
  chooseWorkspace: () => Promise<string | null>;
  snapshot: (workspace: string) => Promise<Snapshot>;
  appearance: () => Promise<AppearancePreferences>;
  saveAppearance: (appearance: AppearancePreferences) => Promise<AppearancePreferences>;
  saveWorkflow: (workspace: string, workflow: WorkflowConfigSummary) => Promise<WorkflowConfigSummary>;
  tmuxPane: (workspace: string, session: string) => Promise<string>;
  tmuxSend: (workspace: string, session: string, line: string) => Promise<boolean>;
  ssh: {
    list: (options?: SshListOptions) => Promise<SshListResult>;
    add: (input: ManagedSshHostInput) => Promise<SshHost>;
    update: (hostId: string, input: ManagedSshHostInput) => Promise<SshHost>;
    remove: (hostId: string) => Promise<boolean>;
    trust: (request: SshTrustRequest) => Promise<SshFingerprint>;
    generateKey: () => Promise<{ publicKeyPath: string; session: SshSession }>;
    deployKey: (hostId: string) => Promise<SshSession>;
    test: (hostId: string) => Promise<SshTestResult>;
    upload: (hostId: string) => Promise<SshUploadResult | null>;
    connect: (hostId: string) => Promise<SshSession>;
    openExternal: (hostId: string, terminal?: SshExternalTerminalId) => Promise<SshExternalTerminalResult>;
    credentialHas: (hostId: string) => Promise<boolean>;
    credentialSet: (input: SshCredentialSetInput) => Promise<boolean>;
    credentialRemove: (hostId: string) => Promise<boolean>;
    input: (request: SshInputRequest) => Promise<boolean>;
    resize: (request: SshResizeRequest) => Promise<boolean>;
    close: (sessionId: string) => Promise<boolean>;
    onData: (listener: (sessionId: string, data: string) => void) => () => void;
    onExit: (listener: (sessionId: string, code: number) => void) => () => void;
  };
  backlog: {
    list: (workspace: string, options?: BacklogListOptions) => Promise<BacklogItem[]>;
    show: (workspace: string, id: string) => Promise<BacklogItem>;
    create: (workspace: string, input: BacklogCreateInput) => Promise<BacklogItem>;
    start: (workspace: string, input: BacklogRunStartInput) => Promise<BacklogRunSummary>;
    runs: (workspace: string, backlogId?: string) => Promise<BacklogRunSummary[]>;
    addTag: (workspace: string, id: string, tag: string) => Promise<BacklogItem>;
    removeTag: (workspace: string, id: string, tag: string) => Promise<BacklogItem>;
  };
};

export const IPC_CHANNELS = {
  copyText: "afk:copy-text",
  openExternal: "afk:open-external",
  chooseWorkspace: "afk:choose-workspace",
  snapshot: "afk:snapshot",
  appearance: "afk:appearance",
  appearanceSave: "afk:appearance-save",
  workflowSave: "afk:workflow-save",
  tmuxPane: "afk:tmux-pane",
  tmuxSend: "afk:tmux-send",
  sshList: "afk:ssh-list",
  sshAdd: "afk:ssh-add",
  sshUpdate: "afk:ssh-update",
  sshRemove: "afk:ssh-remove",
  sshTrust: "afk:ssh-trust",
  sshGenerateKey: "afk:ssh-generate-key",
  sshDeployKey: "afk:ssh-deploy-key",
  sshTest: "afk:ssh-test",
  sshUpload: "afk:ssh-upload",
  sshConnect: "afk:ssh-connect",
  sshOpenExternal: "afk:ssh-open-external",
  sshCredentialHas: "afk:ssh-credential-has",
  sshCredentialSet: "afk:ssh-credential-set",
  sshCredentialRemove: "afk:ssh-credential-remove",
  sshInput: "afk:ssh-input",
  sshResize: "afk:ssh-resize",
  sshClose: "afk:ssh-close",
  sshData: "afk:ssh-data",
  sshExit: "afk:ssh-exit",
  backlogList: "afk:backlog-list",
  backlogShow: "afk:backlog-show",
  backlogCreate: "afk:backlog-create",
  backlogStart: "afk:backlog-start",
  backlogRuns: "afk:backlog-runs",
  backlogTagAdd: "afk:backlog-tag-add",
  backlogTagRemove: "afk:backlog-tag-remove",
} as const;
import type {
  ManagedSshHostInput,
  SshFingerprint,
  SshExternalTerminalId,
  SshHost,
  SshInputRequest,
  SshListResult,
  SshResizeRequest,
  SshSession,
  SshTestResult,
  SshTrustRequest,
  SshUploadResult,
} from "./ssh-contract";
import type {
  BacklogCreateInput,
  BacklogItem,
  BacklogListOptions,
  BacklogRunStartInput,
  BacklogRunSummary,
} from "./backlog-contract";

export type SshExternalTerminalResult = {
  terminal: SshExternalTerminalId;
};

export type SshListOptions = {
  forceRefresh?: boolean;
};

export type SshCredentialSetInput = {
  hostId: string;
  password: string;
};
