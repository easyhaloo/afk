import { describe, expect, it, vi } from "vitest";
import { createJmsConnectionService, normalizeJmsHost, classifyJmsFailure } from "../../electron/services/jms-connection-service.js";

const bastionHost = {
  id: "managed:bastion",
  alias: "jms-bastion",
  hostname: "dev-jumpserver.fangcloud.net",
  port: 2222,
  user: "wangwendi",
  source: "managed" as const,
  configPath: "AFK 应用数据/ssh-hosts.yml",
  status: "ready" as const,
};

function jmsHost(overrides: Record<string, unknown> = {}) {
  return {
    id: "managed:llm-wiki",
    alias: "llm-wiki",
    hostname: "172.16.206.239",
    port: 22,
    user: "root",
    jumpHostType: "jumpserver" as const,
    jumpHost: "jms-bastion",
    source: "managed" as const,
    configPath: "AFK 应用数据/ssh-hosts.yml",
    status: "ready" as const,
    ...overrides,
  };
}

function cli(overrides: Record<string, unknown> = {}) {
  return {
    listServers: async () => [{ alias: "dev", host: "https://dev-jumpserver.fangcloud.net", username: "wangwendi", isDefault: true }],
    listAssets: async () => [{ name: "llm-wiki", address: "172.16.206.239", platform: "Linux", rawType: "Linux" }],
    execCommand: async () => ({ ok: true, stdout: "true", stderr: "" }),
    uploadFile: async () => ({ ok: true, stderr: "" }),
    resolveBinaryPath: async () => process.execPath,
    ...overrides,
  };
}

function service(overrides: { cli?: ReturnType<typeof cli>; hosts?: unknown[]; bastions?: unknown[] } = {}) {
  return createJmsConnectionService({
    cli: overrides.cli ?? cli(),
    listHosts: async () => ({ hosts: [bastionHost, jmsHost()] as never, diagnostics: [] }),
    listBastions: async () => (overrides.bastions ?? []) as never,
  });
}

describe("JMS connection service", () => {
  it("resolves a host to its JumpServer asset by name", async () => {
    await expect(service().resolve(jmsHost() as never)).resolves.toEqual({ server: "dev", asset: "llm-wiki", target: "llm-wiki@dev" });
  });

  it("resolves the jms server alias from an AFK bastion record", async () => {
    const bastion = { id: "bastion-1", alias: "jms-bastion", hostname: "dev-jumpserver.fangcloud.net", port: 2222, user: "wangwendi", jmsServerAlias: "dev", syncFilter: { linuxOnly: true } };
    const listServers = vi.fn(async () => [{ alias: "dev", host: "https://other.example.test", username: "wangwendi", isDefault: false }]);
    const runtime = service({ cli: cli({ listServers }), bastions: [bastion] });
    await expect(runtime.resolve(jmsHost() as never)).resolves.toMatchObject({ server: "dev" });
  });

  it("matches the configured jms server by hostname when no bastion record exists", async () => {
    const listServers = vi.fn(async () => [{ alias: "prod", host: "https://dev-jumpserver.fangcloud.net/luna/", username: "wangwendi", isDefault: false }]);
    const runtime = service({ cli: cli({ listServers }) });
    await expect(runtime.resolve(jmsHost() as never)).resolves.toMatchObject({ server: "prod", target: "llm-wiki@prod" });
  });

  it("falls back to an asset address when the AFK alias differs from the asset name", async () => {
    const listAssets = vi.fn(async () => [{ name: "wiki-node", address: "172.16.206.239", platform: "Linux", rawType: "Linux" }]);
    const runtime = service({ cli: cli({ listAssets }) });
    await expect(runtime.resolve(jmsHost() as never)).resolves.toEqual({ server: "dev", asset: "wiki-node", target: "wiki-node@dev" });
  });

  it("rejects hosts that are not JumpServer assets", async () => {
    await expect(service().resolve({ ...jmsHost(), jumpHostType: "none" } as never)).rejects.toThrow("不是 JumpServer 资产");
  });

  it("reports a missing asset instead of guessing a target", async () => {
    const listAssets = vi.fn(async () => [{ name: "other", address: "10.0.0.1", platform: "Linux", rawType: "Linux" }]);
    const runtime = service({ cli: cli({ listAssets }) });
    await expect(runtime.resolve(jmsHost() as never)).rejects.toThrow("未找到资产");
  });

  it("rejects when no jms server is configured", async () => {
    const runtime = service({ cli: cli({ listServers: async () => [] }) });
    await expect(runtime.resolve(jmsHost() as never)).rejects.toThrow("未配置 jms 服务器");
  });

  it("caches the asset list per server", async () => {
    const listAssets = vi.fn(async () => [{ name: "llm-wiki", address: "172.16.206.239", platform: "Linux", rawType: "Linux" }]);
    const runtime = service({ cli: cli({ listAssets }) });
    await runtime.resolve(jmsHost() as never);
    await runtime.resolve(jmsHost() as never);
    expect(listAssets).toHaveBeenCalledTimes(1);
  });

  it("tests connectivity with jms exec and classifies failures", async () => {
    const execCommand = vi.fn(async () => ({ ok: true, stdout: "true", stderr: "" }));
    const runtime = service({ cli: cli({ execCommand }) });
    await expect(runtime.test("llm-wiki@dev")).resolves.toEqual({ ok: true, code: "ready" });
    expect(execCommand).toHaveBeenCalledWith("llm-wiki@dev", "true");

    expect(classifyJmsFailure("Permission denied")).toBe("auth-required");
    expect(classifyJmsFailure("asset not found")).toBe("invalid");
    expect(classifyJmsFailure("connection timed out")).toBe("unreachable");
  });

  it("surfaces the jms stderr when an upload fails", async () => {
    const runtime = service({ cli: cli({ uploadFile: async () => ({ ok: false, stderr: "No such directory" }) }) });
    await expect(runtime.upload("/tmp/report.pdf", "llm-wiki@dev", "/srv")).rejects.toThrow("No such directory");
  });

  it("builds the interactive login session from the resolved jms binary", async () => {
    // `process.execPath` is the one executable path that exists on every
    // runner: `binaryPath()` refuses a resolved path the filesystem lost, so a
    // hard-coded Homebrew path made this test depend on the developer's Mac.
    const runtime = service({ cli: cli({ resolveBinaryPath: async () => process.execPath }) });
    await expect(runtime.session("llm-wiki@dev")).resolves.toEqual({ binary: process.execPath, args: ["login", "llm-wiki@dev"] });
  });

  it("falls back to a configured candidate when the resolved binary is gone", async () => {
    const runtime = createJmsConnectionService({
      cli: cli({ resolveBinaryPath: async () => "/nonexistent/jms" }),
      listHosts: async () => ({ hosts: [bastionHost] as never, diagnostics: [] }),
      binaryCandidates: [process.execPath],
    });
    await expect(runtime.session("llm-wiki@dev")).resolves.toEqual({ binary: process.execPath, args: ["login", "llm-wiki@dev"] });
  });

  it("explains how to install jms when no binary is found", async () => {
    const runtime = createJmsConnectionService({
      cli: cli({ resolveBinaryPath: async () => "" }),
      listHosts: async () => ({ hosts: [bastionHost] as never, diagnostics: [] }),
      binaryCandidates: ["/nonexistent/jms"],
    });
    await expect(runtime.session("llm-wiki@dev")).rejects.toThrow("未检测到 jms CLI");
  });

  it("normalizes JumpServer and OpenSSH addresses for matching", () => {
    expect(normalizeJmsHost("https://dev-jumpserver.fangcloud.net")).toBe("dev-jumpserver.fangcloud.net");
    expect(normalizeJmsHost("https://dev-jumpserver.fangcloud.net/luna/")).toBe("dev-jumpserver.fangcloud.net");
    expect(normalizeJmsHost("wangwendi@dev-jumpserver.fangcloud.net:2222")).toBe("dev-jumpserver.fangcloud.net");
    expect(normalizeJmsHost("[::1]:22")).toBe("[::1]");
    expect(normalizeJmsHost("  ")).toBe("");
  });
});
