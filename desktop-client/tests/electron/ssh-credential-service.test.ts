import { describe, expect, it, vi } from "vitest";
import { createSshCredentialService } from "../../electron/services/ssh-credential-service";

function dependencies() {
  const files = new Map<string, string>();
  const modes = new Map<string, number>();
  const safeStorage = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`, "utf8")),
    decryptString: vi.fn((value: Buffer) => {
      const text = value.toString("utf8");
      if (!text.startsWith("encrypted:")) throw new Error("bad ciphertext");
      return text.slice("encrypted:".length);
    }),
  };
  const fileSystem = {
    chmod: vi.fn(async (file: string, mode: number) => {
      modes.set(file, mode);
    }),
    mkdir: vi.fn(async () => undefined),
    readFile: vi.fn(async (file: string) => {
      const content = files.get(file);
      if (content === undefined) throw Object.assign(new Error("not found"), { code: "ENOENT" });
      return content;
    }),
    rename: vi.fn(async (from: string, to: string) => {
      const content = files.get(from);
      if (content === undefined) throw new Error("temporary file missing");
      files.set(to, content);
      files.delete(from);
      modes.set(to, modes.get(from) ?? 0o600);
    }),
    rm: vi.fn(async (file: string) => {
      files.delete(file);
      modes.delete(file);
    }),
    writeFile: vi.fn(async (file: string, content: string, options?: { mode?: number }) => {
      files.set(file, content);
      if (options?.mode !== undefined) modes.set(file, options.mode);
    }),
  };
  return { files, modes, safeStorage, fileSystem };
}

describe("SSH credential service", () => {
  const targetOne = { hostname: "one.example.test", port: 22, user: "root" };
  const targetTwo = { hostname: "two.example.test", port: 2202, user: "deploy" };

  it("stores encrypted credentials atomically with restrictive permissions and isolates hosts", async () => {
    const deps = dependencies();
    const service = createSshCredentialService({ home: "/home/test", safeStorage: deps.safeStorage, fileSystem: deps.fileSystem });

    await service.set("managed:one", "p@ssword", targetOne);
    await service.set("managed:two", "another", targetTwo);

    expect(await service.has("managed:one", targetOne)).toBe(true);
    expect(await service.get("managed:one", targetOne)).toBe("p@ssword");
    expect(await service.get("managed:two", targetTwo)).toBe("another");
    expect(await service.has("managed:missing", targetOne)).toBe(false);
    expect([...deps.files.values()].some((content) => content.includes("p@ssword") || content.includes("another"))).toBe(false);
    expect(deps.fileSystem.rename).toHaveBeenCalled();
    expect(deps.fileSystem.chmod).toHaveBeenCalledWith("/home/test/.config/afk", 0o700);
    expect(deps.fileSystem.chmod).toHaveBeenCalledWith("/home/test/.config/afk/ssh-credentials.json", 0o600);
  });

  it("removes one host credential without affecting another host", async () => {
    const deps = dependencies();
    const service = createSshCredentialService({ home: "/home/test", safeStorage: deps.safeStorage, fileSystem: deps.fileSystem });

    await service.set("managed:one", "first", targetOne);
    await service.set("managed:two", "second", targetTwo);
    await service.remove("managed:one");

    await expect(service.get("managed:one", targetOne)).resolves.toBeUndefined();
    await expect(service.get("managed:two", targetTwo)).resolves.toBe("second");
  });

  it("serializes concurrent sets so credentials for both hosts survive", async () => {
    const deps = dependencies();
    const service = createSshCredentialService({ home: "/home/test", safeStorage: deps.safeStorage, fileSystem: deps.fileSystem });

    await Promise.all([
      service.set("managed:one", "first", targetOne),
      service.set("managed:two", "second", targetTwo),
    ]);

    await expect(service.get("managed:one", targetOne)).resolves.toBe("first");
    await expect(service.get("managed:two", targetTwo)).resolves.toBe("second");
  });

  it("serializes concurrent set and remove mutations without restoring removed credentials", async () => {
    const deps = dependencies();
    const service = createSshCredentialService({ home: "/home/test", safeStorage: deps.safeStorage, fileSystem: deps.fileSystem });
    await service.set("managed:one", "first", targetOne);

    await Promise.all([
      service.set("managed:two", "second", targetTwo),
      service.remove("managed:one"),
    ]);

    await expect(service.get("managed:one", targetOne)).resolves.toBeUndefined();
    await expect(service.get("managed:two", targetTwo)).resolves.toBe("second");
  });

  it("returns no credential for a missing file", async () => {
    const deps = dependencies();
    const service = createSshCredentialService({ home: "/home/test", safeStorage: deps.safeStorage, fileSystem: deps.fileSystem });

    await expect(service.has("managed:missing", targetOne)).resolves.toBe(false);
    await expect(service.get("managed:missing", targetOne)).resolves.toBeUndefined();
  });

  it("rejects unavailable secure storage with a stable error", async () => {
    const deps = dependencies();
    deps.safeStorage.isEncryptionAvailable.mockReturnValue(false);
    const service = createSshCredentialService({ home: "/home/test", safeStorage: deps.safeStorage, fileSystem: deps.fileSystem });

    await expect(service.set("managed:one", "password", targetOne)).rejects.toThrow("SSH 凭据安全存储不可用");
    await expect(service.get("managed:one", targetOne)).rejects.toThrow("SSH 凭据安全存储不可用");
  });

  it("rejects malformed encrypted data with a stable error", async () => {
    const deps = dependencies();
    const file = "/home/test/.config/afk/ssh-credentials.json";
    deps.files.set(file, JSON.stringify({ version: 1, credentials: { "managed:one": { encrypted: "%%%", target: targetOne } } }));
    const service = createSshCredentialService({ home: "/home/test", safeStorage: deps.safeStorage, fileSystem: deps.fileSystem });

    await expect(service.get("managed:one", targetOne)).rejects.toThrow("SSH 凭据文件损坏");
    await expect(service.has("managed:one", targetOne)).resolves.toBe(true);
  });

  it("treats legacy credentials without a target binding as unset", async () => {
    const deps = dependencies();
    const file = "/home/test/.config/afk/ssh-credentials.json";
    deps.files.set(file, JSON.stringify({ version: 1, credentials: { "managed:one": Buffer.from("encrypted:legacy").toString("base64") } }));
    const service = createSshCredentialService({ home: "/home/test", safeStorage: deps.safeStorage, fileSystem: deps.fileSystem });

    await expect(service.has("managed:one", targetOne)).resolves.toBe(false);
    await expect(service.get("managed:one", targetOne)).resolves.toBeUndefined();
  });

  it("does not expose a credential when the resolved target changes", async () => {
    const deps = dependencies();
    const service = createSshCredentialService({ home: "/home/test", safeStorage: deps.safeStorage, fileSystem: deps.fileSystem });
    await service.set("managed:one", "first", targetOne);

    await expect(service.has("managed:one", { ...targetOne, hostname: "replacement.example.test" })).resolves.toBe(false);
    await expect(service.get("managed:one", { ...targetOne, port: 2222 })).resolves.toBeUndefined();
    await expect(service.get("managed:one", { ...targetOne, user: "ubuntu" })).resolves.toBeUndefined();
  });

  it("rejects invalid host ids and unsafe passwords", async () => {
    const deps = dependencies();
    const service = createSshCredentialService({ home: "/home/test", safeStorage: deps.safeStorage, fileSystem: deps.fileSystem });

    await expect(service.set("other:one", "password", targetOne)).rejects.toThrow("SSH 主机 ID 无效");
    await expect(service.set("managed:one", "", targetOne)).rejects.toThrow("SSH 部署密码无效");
    await expect(service.set("managed:one", "bad\0password", targetOne)).rejects.toThrow("SSH 部署密码无效");
    await expect(service.set("managed:one", "bad\rpassword", targetOne)).rejects.toThrow("SSH 部署密码无效");
    await expect(service.set("managed:one", "bad\npassword", targetOne)).rejects.toThrow("SSH 部署密码无效");
    await expect(service.set("managed:one", "x".repeat(4097), targetOne)).rejects.toThrow("SSH 部署密码无效");
  });

  it.each(["bad\0password", "bad\rpassword", "bad\npassword", "x".repeat(4097)])("rejects unsafe decrypted passwords", async (password) => {
    const deps = dependencies();
    const file = "/home/test/.config/afk/.config/afk/ssh-credentials.json";
    deps.files.set("/home/test/.config/afk/ssh-credentials.json", JSON.stringify({
      version: 1,
      credentials: { "managed:one": { encrypted: Buffer.from(`encrypted:${password}`).toString("base64"), target: targetOne } },
    }));
    const service = createSshCredentialService({ home: "/home/test", safeStorage: deps.safeStorage, fileSystem: deps.fileSystem });

    await expect(service.get("managed:one", targetOne)).rejects.toThrow("SSH 部署密码无效");
  });
});
