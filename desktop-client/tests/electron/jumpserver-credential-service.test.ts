import { describe, expect, it, vi } from "vitest";
import { createJumpserverCredentialStore } from "../../electron/services/jumpserver-credential-service";

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

describe("Jumpserver credential service", () => {
  const targetOne = { hostname: "bastion.example.test", port: 2222, user: "admin" };
  const targetTwo = { hostname: "bastion2.example.test", port: 2223, user: "operator" };

  it("round-trips encryption and decryption of password", async () => {
    const deps = dependencies();
    const service = createJumpserverCredentialStore({ home: "/home/test", safeStorage: deps.safeStorage, fileSystem: deps.fileSystem });

    await service.set("bastion:one", "p@ssword", targetOne);

    expect(await service.has("bastion:one", targetOne)).toBe(true);
    const cred = await service.get("bastion:one", targetOne);
    expect(cred?.password).toBe("p@ssword");
    expect(cred?.otpSecret).toBeUndefined();
  });

  it("round-trips encryption and decryption of password with OTP secret", async () => {
    const deps = dependencies();
    const service = createJumpserverCredentialStore({ home: "/home/test", safeStorage: deps.safeStorage, fileSystem: deps.fileSystem });

    await service.set("bastion:one", "p@ssword", targetOne, "JBSWY3DPEHPK3PXP");

    expect(await service.has("bastion:one", targetOne)).toBe(true);
    const cred = await service.get("bastion:one", targetOne);
    expect(cred?.password).toBe("p@ssword");
    expect(cred?.otpSecret).toBe("JBSWY3DPEHPK3PXP");
  });

  it("round-trips without OTP (otpEncrypted undefined)", async () => {
    const deps = dependencies();
    const service = createJumpserverCredentialStore({ home: "/home/test", safeStorage: deps.safeStorage, fileSystem: deps.fileSystem });

    await service.set("bastion:one", "p@ssword", targetOne);

    const file = "/home/test/.config/afk/jumpserver-credentials.json";
    const stored = JSON.parse(deps.files.get(file)!);
    expect(stored.credentials["bastion:one"]).not.toHaveProperty("otpEncrypted");
  });

  it("writes atomically with chmod 0o600 and isolates bastion entries", async () => {
    const deps = dependencies();
    const service = createJumpserverCredentialStore({ home: "/home/test", safeStorage: deps.safeStorage, fileSystem: deps.fileSystem });

    await service.set("bastion:one", "first", targetOne);
    await service.set("bastion:two", "second", targetTwo);

    expect(await service.get("bastion:one", targetOne)).toEqual({ password: "first" });
    expect(await service.get("bastion:two", targetTwo)).toEqual({ password: "second" });
    expect([...deps.files.values()].some((content) => content.includes("first") || content.includes("second"))).toBe(false);
    expect(deps.fileSystem.rename).toHaveBeenCalled();
    expect(deps.fileSystem.chmod).toHaveBeenCalledWith("/home/test/.config/afk", 0o700);
    expect(deps.fileSystem.chmod).toHaveBeenCalledWith("/home/test/.config/afk/jumpserver-credentials.json", 0o600);
  });

  it("serializes concurrent writes so both credentials survive", async () => {
    const deps = dependencies();
    const service = createJumpserverCredentialStore({ home: "/home/test", safeStorage: deps.safeStorage, fileSystem: deps.fileSystem });

    await Promise.all([
      service.set("bastion:one", "first", targetOne),
      service.set("bastion:two", "second", targetTwo),
    ]);

    expect(await service.get("bastion:one", targetOne)).toEqual({ password: "first" });
    expect(await service.get("bastion:two", targetTwo)).toEqual({ password: "second" });
  });

  it("sameTarget requires hostname, port, and user to all match", async () => {
    const deps = dependencies();
    const service = createJumpserverCredentialStore({ home: "/home/test", safeStorage: deps.safeStorage, fileSystem: deps.fileSystem });

    await service.set("bastion:one", "pwd", targetOne);

    expect(await service.has("bastion:one", { ...targetOne, hostname: "other.example.test" })).toBe(false);
    expect(await service.has("bastion:one", { ...targetOne, port: 3333 })).toBe(false);
    expect(await service.has("bastion:one", { ...targetOne, user: "other" })).toBe(false);
    expect(await service.has("bastion:one", targetOne)).toBe(true);
  });

  it("has returns false when target differs even if entry exists", async () => {
    const deps = dependencies();
    const service = createJumpserverCredentialStore({ home: "/home/test", safeStorage: deps.safeStorage, fileSystem: deps.fileSystem });

    await service.set("bastion:one", "pwd", targetOne);

    expect(await service.has("bastion:one", targetTwo)).toBe(false);
    expect(await service.get("bastion:one", targetTwo)).toBeUndefined();
  });

  it("set with empty password throws", async () => {
    const deps = dependencies();
    const service = createJumpserverCredentialStore({ home: "/home/test", safeStorage: deps.safeStorage, fileSystem: deps.fileSystem });

    await expect(service.set("bastion:one", "", targetOne)).rejects.toThrow("JumpServer 凭据参数无效");
  });

  it("set with embedded null, carriage return, or newline in password throws", async () => {
    const deps = dependencies();
    const service = createJumpserverCredentialStore({ home: "/home/test", safeStorage: deps.safeStorage, fileSystem: deps.fileSystem });

    await expect(service.set("bastion:one", "bad\0password", targetOne)).rejects.toThrow("JumpServer 凭据参数无效");
    await expect(service.set("bastion:one", "bad\rpassword", targetOne)).rejects.toThrow("JumpServer 凭据参数无效");
    await expect(service.set("bastion:one", "bad\npassword", targetOne)).rejects.toThrow("JumpServer 凭据参数无效");
  });

  it("set with password exceeding 4096 bytes throws", async () => {
    const deps = dependencies();
    const service = createJumpserverCredentialStore({ home: "/home/test", safeStorage: deps.safeStorage, fileSystem: deps.fileSystem });

    await expect(service.set("bastion:one", "x".repeat(4097), targetOne)).rejects.toThrow("JumpServer 凭据参数无效");
  });

  it("empty OTP secret is treated as not provided", async () => {
    const deps = dependencies();
    const service = createJumpserverCredentialStore({ home: "/home/test", safeStorage: deps.safeStorage, fileSystem: deps.fileSystem });

    await service.set("bastion:one", "pwd", targetOne, "");

    const file = "/home/test/.config/afk/jumpserver-credentials.json";
    const stored = JSON.parse(deps.files.get(file)!);
    expect(stored.credentials["bastion:one"]).not.toHaveProperty("otpEncrypted");
  });

  it("remove deletes the entry", async () => {
    const deps = dependencies();
    const service = createJumpserverCredentialStore({ home: "/home/test", safeStorage: deps.safeStorage, fileSystem: deps.fileSystem });

    await service.set("bastion:one", "pwd", targetOne);
    expect(await service.has("bastion:one", targetOne)).toBe(true);

    await service.remove("bastion:one");

    expect(await service.has("bastion:one", targetOne)).toBe(false);
    expect(await service.get("bastion:one", targetOne)).toBeUndefined();
  });

  it("file corruption (invalid JSON) throws 凭据文件损坏", async () => {
    const deps = dependencies();
    const file = "/home/test/.config/afk/jumpserver-credentials.json";
    deps.files.set(file, "{ broken json }");
    const service = createJumpserverCredentialStore({ home: "/home/test", safeStorage: deps.safeStorage, fileSystem: deps.fileSystem });

    await expect(service.has("bastion:one", targetOne)).rejects.toThrow("JumpServer 凭据文件损坏");
    await expect(service.get("bastion:one", targetOne)).rejects.toThrow("JumpServer 凭据文件损坏");
  });

  it("missing safeStorage throws 不可用", async () => {
    const deps = dependencies();
    deps.safeStorage.isEncryptionAvailable.mockReturnValue(false);
    const service = createJumpserverCredentialStore({ home: "/home/test", safeStorage: deps.safeStorage, fileSystem: deps.fileSystem });

    await expect(service.set("bastion:one", "pwd", targetOne)).rejects.toThrow("JumpServer 凭据安全存储不可用");
    await expect(service.get("bastion:one", targetOne)).rejects.toThrow("JumpServer 凭据安全存储不可用");
  });
});
