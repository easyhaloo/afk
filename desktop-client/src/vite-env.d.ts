/** AFK Control UI contract: the renderer only receives summarized, fixed-whitelist local diagnostics. */
/// <reference types="vite/client" />

interface RuntimeEvent {
  id: string;
  timestamp: string;
  source: string;
  result: string;
  nextStep: string;
  raw: string;
}

interface AgentRuntime {
  id: "claude" | "codex" | "gemini" | "opencode";
  label: string;
  command: string;
  available: boolean;
  executable: string;
  summary: string;
  status: "available" | "missing" | "error";
}

interface Snapshot {
  workspace: { root: string; afkDirectoryPresent: boolean; eventCount: number };
  afk: { available: boolean; executable: string; summary: string };
  agentRuntimes: AgentRuntime[];
  events: RuntimeEvent[];
  containers: Array<{ engine: string; name: string; image: string; status: string }>;
  sessions: Array<{ name: string; windows: string; attached: boolean }>;
}

interface Window {
  afkDesktop: {
    chooseWorkspace: () => Promise<string | null>;
    snapshot: (workspace: string) => Promise<Snapshot>;
    tmuxPane: (session: string) => Promise<string>;
    tmuxSend: (session: string, line: string) => Promise<boolean>;
  };
}
