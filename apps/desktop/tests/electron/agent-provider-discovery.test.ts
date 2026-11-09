import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultPluginRuntime, PluginRuntime } from "@afk/runtime/plugin-sdk";
import { executable } from "../../electron/adapters/process-executor.js";
import { detectAgentRuntimes, listRegisteredAgentProviders } from "../../electron/services/runtime-service.js";

vi.mock("@afk/runtime/plugin-sdk", async importOriginal => ({
  ...await importOriginal<typeof import("@afk/runtime/plugin-sdk")>(), createDefaultPluginRuntime: vi.fn(),
}));
vi.mock("../../electron/adapters/process-executor.js", () => ({
  executable: vi.fn(async () => undefined), exec: vi.fn(), firstLine: vi.fn(),
}));

beforeEach(() => { vi.clearAllMocks(); });

async function runtimeFor(name: string) {
  const runtime = new PluginRuntime();
  await runtime.activate({ id: "desktop-agent-test", version: "1.0.0", setup(context) {
    context.registerAgentProvider(name, { name, capabilities: new Set(), createExecution: vi.fn() });
    context.registerAgentProvider("invalid-provider", { name: "invalid-provider" } as never);
  } });
  vi.spyOn(runtime, "dispose");
  return runtime;
}

describe("registered workflow agent discovery", () => {
  it("projects callable registered providers through the shared runtime and releases it", async () => {
    const runtime = await runtimeFor("enterprise-agent");
    vi.mocked(createDefaultPluginRuntime).mockResolvedValueOnce(runtime);
    expect(await listRegisteredAgentProviders("/workspace/project")).toEqual(["enterprise-agent"]);
    expect(createDefaultPluginRuntime).toHaveBeenCalledWith({ workspaceRoot: "/workspace/project" });
    expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(runtime.listProviders("agent.provider")).toEqual([]);
    expect(executable).not.toHaveBeenCalled();
  });

  it("reloads the registry to observe installation and removal between snapshots", async () => {
    const first = await runtimeFor("first-agent");
    const second = await runtimeFor("second-agent");
    vi.mocked(createDefaultPluginRuntime).mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    expect(await listRegisteredAgentProviders("/workspace/project")).toEqual(["first-agent"]);
    expect(await listRegisteredAgentProviders("/workspace/project")).toEqual(["second-agent"]);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.dispose).toHaveBeenCalledOnce();
  });

  it("releases the runtime when registry projection fails", async () => {
    const runtime = await runtimeFor("enterprise-agent");
    vi.spyOn(runtime, "getAgentProviderRegistry").mockImplementation(() => { throw new Error("registry unavailable"); });
    vi.mocked(createDefaultPluginRuntime).mockResolvedValueOnce(runtime);
    await expect(listRegisteredAgentProviders("/workspace/project")).rejects.toThrow("registry unavailable");
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });

  it("keeps executable diagnostics on the fixed command whitelist", async () => {
    const runtimes = await detectAgentRuntimes();
    expect(runtimes).toHaveLength(6);
    expect(runtimes.every(runtime => !runtime.available && runtime.status === "missing")).toBe(true);
    expect(executable).toHaveBeenCalledTimes(6);
    expect(createDefaultPluginRuntime).not.toHaveBeenCalled();
  });
});
