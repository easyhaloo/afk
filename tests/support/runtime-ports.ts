/**
 * The runtime ports, with nothing wired to them.
 *
 * A command that reaches the runtime does so through a port, and a test
 * that drives a command has to hand it one. Handing it the real runtime
 * would make the test read the developer's configuration file and talk to
 * the developer's tmux; handing it nothing would make the test exercise a
 * path no user ever takes. This is the third thing: the ports, answering
 * from memory.
 */
import type {
  AgentTelemetryPort,
  BrowserPort,
  ConfigurationPort,
  GitLabConfig,
  LoopProcessPort,
  ResourceRegistryPort,
  SchedulerConfig,
  TmuxPort,
  WorkflowConfig,
} from '@afk/application';

export interface InMemoryRuntimePorts {
  configuration: ConfigurationPort;
  tmux: TmuxPort;
  loopProcess: LoopProcessPort;
  agentTelemetry: AgentTelemetryPort;
  browser: BrowserPort;
  resources: ResourceRegistryPort;
}

/** The configuration a run is shaped by, when nothing configures it. */
export function inMemoryWorkflowConfig(): WorkflowConfig {
  return {
    agentDefault: 'claude-code',
    tmuxSession: 'afk',
    completionTimeout: 300_000,
    qaTimeout: 300_000,
    workflowHardTimeout: 3_600_000,
    completionPoll: 5,
    idleTimeout: 300_000,
    acCheckTimeout: 120_000,
    contextThreshold: 200_000,
    promptTimeout: 120_000,
    handoffTimeout: 120_000,
    maxRetries: 2,
    maxSelfIterations: 10,
    maxQaReworkAttempts: 3,
    targetBranch: 'main',
    trackerTargetBranch: 'main',
    goalBudget: 500_000,
    agents: {
      codex: {
        transport: 'auto',
        auth: 'auto',
        provider: 'openai',
        appServer: { startupTimeoutMs: 30_000 },
      },
    },
  };
}

export function inMemorySchedulerConfig(): SchedulerConfig {
  return {
    maxConcurrent: 1,
    pollInterval: 60,
    requiredLabels: [],
    excludeLabels: [],
    waveNotify: false,
    updateDashboard: true,
  };
}

export function inMemoryGitLabConfig(): GitLabConfig {
  return { url: 'https://gitlab.com', token: '' };
}

/** The ports, wired to nothing that leaves the process. */
export function inMemoryRuntimePorts(): InMemoryRuntimePorts {
  return {
    configuration: {
      workflow: () => inMemoryWorkflowConfig(),
      defaults: () => inMemoryWorkflowConfig(),
      scheduler: () => inMemorySchedulerConfig(),
      gitLab: () => inMemoryGitLabConfig(),
    },
    tmux: {
      createSession: async (name, dir) => ({ name, window: 'main', dir }),
      hasSession: async () => false,
      killSession: async () => undefined,
      sendPrompt: async () => undefined,
      capturePane: async () => '',
      waitForSignal: async () => null,
      attach: async () => false,
      readiness: agent => ({ agent, ready: async () => true }),
    },
    loopProcess: {
      pidFile: () => '/tmp/afk-test-loop.pid',
      ensurePidDirectory: () => undefined,
      readPid: () => null,
      removePidFile: () => undefined,
      isAlive: () => false,
      spawnDaemon: () => undefined,
      waitForPid: async () => null,
      terminate: () => undefined,
    },
    agentTelemetry: {
      readUsage: async () => undefined,
      readTranscript: async () => undefined,
      readTools: async () => undefined,
      findRollout: async () => undefined,
    },
    browser: {
      open: async () => undefined,
    },
    resources: {
      readActive: () => [],
      readRun: () => [],
    },
  };
}
