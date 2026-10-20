import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSnapshot, SnapshotContractError } from "../../shared/snapshot-schema";

const mocks = vi.hoisted(() => ({
  agentRuntimes: [] as Record<string, unknown>[],
  home: "",
}));

// os.homedir() does not follow a stubbed HOME on every platform, so the
// loop-status record — a file the program does not own — is read from a
// directory the test controls.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mocks.home || actual.homedir() };
});

vi.mock("../../electron/adapters/process-executor", () => ({ executable: async () => undefined, firstLine: () => "" }));
vi.mock("../../electron/adapters/resource-adapter", () => ({
  listAfkContainers: async () => [{ engine: "docker", name: "afk-runner", image: "ghcr.io/afk/runner:0.1.0", status: "Up 18 minutes" }],
  listAfkTmux: async () => [{ name: "afk-release", workspace: "/tmp/afk", windows: "1", attached: true }],
}));
vi.mock("../../electron/services/runtime-service", () => ({ detectAgentRuntimes: async () => mocks.agentRuntimes }));
vi.mock("../../electron/services/project-run-scope-service", () => ({
  projectRunScopeService: {
    workspaces: async (root: string) => [root],
    runs: async () => [{ id: "run-1", workItemId: "github:acme/api#1", status: "running", startedAt: "2026-08-22T09:18:37+08:00", workspacePath: "/tmp/afk" }],
  },
}));

const { snapshot } = await import("../../electron/services/desktop-service");

let directory: string;

const WORKFLOW_TEMPLATE_YAML = [
  "name: afk-control-workflow",
  "version: 1",
  "description: AFK Control managed workflow template",
  "defaultProvider: codex",
  "steps:",
  "  - id: implement",
  "    kind: agent",
  "    role: implementer",
  "    prompt: Implement the work item.",
  "    provider: codex",
  "",
].join("\n");

const CONFIG_YAML = [
  "agentDefault: codex",
  "tmuxSession: afk",
  "targetBranch: main",
  "trackerTargetBranch: main",
  "maxRetries: 2",
  "template: afk-control-workflow",
  "agents:",
  "  codex:",
  "    transport: app-server",
  "    auth: chatgpt",
  "    provider: openai",
  "    appServer:",
  "      endpoint: ws://127.0.0.1:4500",
  "      authTokenEnv: AFK_CODEX_TOKEN",
  "      startupTimeoutMs: 30000",
  "desktop:",
  "  canvas:",
  "    nodes:",
  "      - id: implement",
  "        template: agent",
  "        label: 实现",
  "        description: 实现工作项",
  "        prompt: Implement the work item.",
  "        provider: codex",
  "        x: 220",
  "        y: 74",
  "",
].join("\n");

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "afk-snapshot-contract-"));
  vi.stubEnv("HOME", directory);
  mocks.home = directory;
  mocks.agentRuntimes = [{
    id: "claude",
    label: "Claude Code",
    command: "claude",
    available: true,
    executable: "/opt/homebrew/bin/claude",
    summary: "2.1.18",
    status: "available",
    installation: { source: "Homebrew", version: "2.1.18", checkedAt: "2026-08-22T09:33:51+08:00" },
  }];
  await mkdir(path.join(directory, ".afk", "runs", "build-1"), { recursive: true });
  await mkdir(path.join(directory, ".afk", "workflows"), { recursive: true });
  await writeFile(
    path.join(directory, ".afk", "runs", "build-1", "events.jsonl"),
    `${JSON.stringify({ timestamp: "2026-08-22T09:18:37+08:00", event: "run.started", message: "运行已开始" })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(directory, ".afk", "runs", "build-1", "request.json"),
    JSON.stringify({ runId: "build-1", startedAt: "2026-08-22T09:18:37+08:00", goalText: "发布桌面端", provider: "codex", worktreePath: "/tmp/afk-worktree" }),
    "utf8",
  );
  await writeFile(
    path.join(directory, ".afk", "runs", "build-1", "result.json"),
    JSON.stringify({ status: "completed", sessionId: "sess-1", branch: "afk/build-1" }),
    "utf8",
  );
  await writeFile(path.join(directory, ".afk", "workflows", "afk-control-workflow.yml"), WORKFLOW_TEMPLATE_YAML, "utf8");
  await writeFile(path.join(directory, ".afk", "config.yml"), CONFIG_YAML, "utf8");
  await writeFile(
    path.join(directory, ".afk", "loop-status.json"),
    JSON.stringify({
      pid: 48210,
      execution: { active: 1, ids: ["10"] },
      totals: { completed: 4, failed: 0 },
      startedAt: 1787124200000,
      lastUpdateAt: 1787127821915,
      lastError: { "42": "execution-blocked" },
    }),
    "utf8",
  );
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("snapshot contract at the main-process edge", () => {
  it("hands over a payload that holds the contract, unchanged", async () => {
    const live = await snapshot(directory);

    expect(parseSnapshot(live)).toEqual(live);
    expect(live.workflow.canvasNodes.map(node => node.provider)).toEqual(["codex"]);
    expect(live.workflowTemplates.find(template => template.id === "afk-control-workflow")?.canvasNodes).toHaveLength(1);
    expect(live.workflowRuns.map(run => run.status)).toEqual(["completed"]);
    expect(live.events).toHaveLength(1);
    expect(live.loop.lastError).toEqual({ "42": "execution-blocked" });
    expect(live.agentRuntimes[0].installation.version).toBe("2.1.18");
  });

  it("refuses to hand over a payload that broke the contract", async () => {
    mocks.agentRuntimes = [{ id: "unknown-agent", label: "未知", command: "unknown", available: true, executable: "", summary: "", status: "available", installation: { source: "PATH", version: "", checkedAt: "2026-08-22T09:33:51+08:00" } }];

    const failure = await snapshot(directory).then(() => null, (cause: unknown) => cause);

    expect(failure).toBeInstanceOf(SnapshotContractError);
    expect((failure as SnapshotContractError).issues.join(" ")).toMatch(/agentRuntimes\.0\.id/);
  });
});
