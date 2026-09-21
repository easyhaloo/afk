import { describe, expect, it, vi } from "vitest";
import { createJumpserverCli } from "../../electron/adapters/jumpserver-cli";

describe("JumpServer CLI", () => {
  describe("listServers", () => {
    it("parses default server with * marker", async () => {
      const mockExec = vi.fn().mockResolvedValue({ ok: true, stdout: "* default-server 192.168.1.10 admin", stderr: "" });
      const cli = createJumpserverCli({ exec: mockExec });
      const servers = await cli.listServers();
      expect(servers).toEqual([
        { alias: "default-server", host: "192.168.1.10", username: "admin", isDefault: true },
      ]);
    });

    it("parses multiple servers", async () => {
      const mockExec = vi.fn().mockResolvedValue({
        ok: true,
        stdout: "server-a 10.0.0.1 user1\nserver-b 10.0.0.2 user2\n* server-c 10.0.0.3 user3",
        stderr: "",
      });
      const cli = createJumpserverCli({ exec: mockExec });
      const servers = await cli.listServers();
      expect(servers).toEqual([
        { alias: "server-a", host: "10.0.0.1", username: "user1", isDefault: false },
        { alias: "server-b", host: "10.0.0.2", username: "user2", isDefault: false },
        { alias: "server-c", host: "10.0.0.3", username: "user3", isDefault: true },
      ]);
    });

    it("returns empty array on empty output", async () => {
      const mockExec = vi.fn().mockResolvedValue({ ok: true, stdout: "", stderr: "" });
      const cli = createJumpserverCli({ exec: mockExec });
      const servers = await cli.listServers();
      expect(servers).toEqual([]);
    });
  });

  describe("listAssets", () => {
    it("skips [INFO] lines", async () => {
      const mockExec = vi.fn().mockResolvedValue({
        ok: true,
        stdout: "web-01 10.0.1.10 Linux Ubuntu\n[INFO] Connecting to server...\nweb-02 10.0.1.11 Linux Debian",
        stderr: "",
      });
      const cli = createJumpserverCli({ exec: mockExec });
      const assets = await cli.listAssets("server-a");
      expect(assets).toEqual([
        { name: "web-01", address: "10.0.1.10", platform: "Linux", rawType: "Ubuntu" },
        { name: "web-02", address: "10.0.1.11", platform: "Linux", rawType: "Debian" },
      ]);
    });

    it("skips header and separator lines", async () => {
      const mockExec = vi.fn().mockResolvedValue({
        ok: true,
        stdout: "Name Address Platform Type\n------------------------------\nweb-01 10.0.1.10 Linux Ubuntu",
        stderr: "",
      });
      const cli = createJumpserverCli({ exec: mockExec });
      const assets = await cli.listAssets("server-a");
      expect(assets).toEqual([{ name: "web-01", address: "10.0.1.10", platform: "Linux", rawType: "Ubuntu" }]);
    });

    it("filters Windows assets by default", async () => {
      const mockExec = vi.fn().mockResolvedValue({
        ok: true,
        stdout: "web-01 10.0.1.10 Linux Ubuntu\ndb-01 10.0.2.10 Windows WinServer",
        stderr: "",
      });
      const cli = createJumpserverCli({ exec: mockExec });
      const assets = await cli.listAssets("server-a");
      expect(assets).toEqual([{ name: "web-01", address: "10.0.1.10", platform: "Linux", rawType: "Ubuntu" }]);
    });

    it("includes Windows when linuxOnly is false", async () => {
      const mockExec = vi.fn().mockResolvedValue({
        ok: true,
        stdout: "web-01 10.0.1.10 Linux Ubuntu\ndb-01 10.0.2.10 Windows WinServer",
        stderr: "",
      });
      const cli = createJumpserverCli({ exec: mockExec });
      const assets = await cli.listAssets("server-a", { linuxOnly: false });
      expect(assets).toEqual([
        { name: "web-01", address: "10.0.1.10", platform: "Linux", rawType: "Ubuntu" },
        { name: "db-01", address: "10.0.2.10", platform: "Windows", rawType: "WinServer" },
      ]);
    });
  });

  describe("addServer", () => {
    it("calls exec with config add and pipes host/user/password via input", async () => {
      const mockExec = vi.fn().mockResolvedValue({ ok: true, stdout: "", stderr: "" });
      const cli = createJumpserverCli({ exec: mockExec });
      await cli.addServer({ alias: "test-server", host: "192.168.1.100", username: "admin", password: "secret123" });
      expect(mockExec).toHaveBeenCalledWith(
        "jms",
        ["config", "add", "test-server"],
        undefined,
        "192.168.1.100\n2222\nadmin\nsecret123\nsecret123",
      );
    });

    it("uses default port 2222 when not provided", async () => {
      const mockExec = vi.fn().mockResolvedValue({ ok: true, stdout: "", stderr: "" });
      const cli = createJumpserverCli({ exec: mockExec });
      await cli.addServer({ alias: "test-server", host: "192.168.1.100", username: "admin", password: "secret123" });
      const call = mockExec.mock.calls[0];
      expect(call[3]).toContain("2222");
    });
  });

  describe("removeServer", () => {
    it("returns false on exec failure", async () => {
      const mockExec = vi.fn().mockResolvedValue({ ok: false, stdout: "", stderr: "not found" });
      const cli = createJumpserverCli({ exec: mockExec });
      const result = await cli.removeServer("nonexistent");
      expect(result).toBe(false);
    });

    it("returns true on exec success", async () => {
      const mockExec = vi.fn().mockResolvedValue({ ok: true, stdout: "", stderr: "" });
      const cli = createJumpserverCli({ exec: mockExec });
      const result = await cli.removeServer("test-server");
      expect(result).toBe(true);
    });
  });

  describe("probeAssetReachability", () => {
    it("returns true when stdout is 'true' and ok is true", async () => {
      const mockExec = vi.fn().mockResolvedValue({ ok: true, stdout: "true", stderr: "" });
      const cli = createJumpserverCli({ exec: mockExec });
      const result = await cli.probeAssetReachability({ asset: "web-01", serverAlias: "server-a" });
      expect(result).toBe(true);
    });

    it("returns false when ok is false", async () => {
      const mockExec = vi.fn().mockResolvedValue({ ok: false, stdout: "", stderr: "connection refused" });
      const cli = createJumpserverCli({ exec: mockExec });
      const result = await cli.probeAssetReachability({ asset: "web-01", serverAlias: "server-a" });
      expect(result).toBe(false);
    });

    it("returns false when stdout is not 'true'", async () => {
      const mockExec = vi.fn().mockResolvedValue({ ok: true, stdout: "false", stderr: "" });
      const cli = createJumpserverCli({ exec: mockExec });
      const result = await cli.probeAssetReachability({ asset: "web-01", serverAlias: "server-a" });
      expect(result).toBe(false);
    });
  });

  describe("resolveBinaryPath", () => {
    it("returns trimmed stdout of which jms", async () => {
      const mockExec = vi.fn().mockResolvedValue({ ok: true, stdout: "  /usr/local/bin/jms  \n", stderr: "" });
      const cli = createJumpserverCli({ exec: mockExec });
      const path = await cli.resolveBinaryPath();
      expect(path).toBe("/usr/local/bin/jms");
    });

    it("returns empty string when binary not found", async () => {
      const mockExec = vi.fn().mockResolvedValue({ ok: false, stdout: "", stderr: "not found" });
      const cli = createJumpserverCli({ exec: mockExec });
      const path = await cli.resolveBinaryPath();
      expect(path).toBe("");
    });
  });
});
