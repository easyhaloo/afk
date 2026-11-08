import { describe, expect, it, vi } from "vitest";
import { configureGoogleAccountPlugins, GoogleOAuthCredentialProvider, GoogleOAuthError } from "@afk/runtime/plugin-sdk";
import { createGoogleAuthService } from "../../electron/services/google-auth-service.js";

vi.mock("@afk/runtime/plugin-sdk", async importOriginal => ({ ...await importOriginal<typeof import("@afk/runtime/plugin-sdk")>(), GoogleOAuthCredentialProvider: vi.fn(), configureGoogleAccountPlugins: vi.fn().mockResolvedValue(undefined) }));

function setup() {
  const provider = { status: vi.fn().mockResolvedValue({ connected: true, email: "me@example.com", expiresAt: "2027-01-01T00:00:00Z", accessToken: "SECRET" }), login: vi.fn().mockResolvedValue({ subject: "private-id", email: "me@example.com", token: "SECRET" }), logout: vi.fn().mockResolvedValue(undefined) };
  const chooseClientFile = vi.fn().mockResolvedValue("/private/google-client.json");
  const openExternal = vi.fn().mockResolvedValue(undefined);
  const configurePlugins = vi.fn().mockResolvedValue(undefined);
  return { provider, chooseClientFile, openExternal, configurePlugins, service: createGoogleAuthService({ provider, chooseClientFile, openExternal, configurePlugins }) };
}

describe("desktop Google OAuth service", () => {
  it("selects the client only in main and returns an allowlisted account DTO", async () => {
    const { service, provider, configurePlugins } = setup();
    expect(await service.login()).toEqual({ connected: true, email: "me@example.com" });
    expect(provider.login).toHaveBeenCalledWith("/private/google-client.json", { signal: expect.any(AbortSignal) });
    expect(await service.status()).toEqual({ connected: true, email: "me@example.com", expiresAt: "2027-01-01T00:00:00Z" });
    expect(JSON.stringify(await service.status())).not.toContain("SECRET");
    expect(configurePlugins).toHaveBeenCalledOnce();
    expect(provider.login.mock.invocationCallOrder[0]).toBeLessThan(configurePlugins.mock.invocationCallOrder[0]);
  });

  it("opens only the provider's Google authorization URL through the Electron shell dependency", async () => {
    const { chooseClientFile, openExternal } = setup();
    vi.mocked(GoogleOAuthCredentialProvider).mockClear();
    createGoogleAuthService({ chooseClientFile, openExternal });
    const openBrowser = vi.mocked(GoogleOAuthCredentialProvider).mock.calls[0][0]!.openBrowser!;
    await openBrowser("https://accounts.google.com/o/oauth2/v2/auth?client_id=example");
    expect(openExternal).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?client_id=example");
    for (const url of ["file:///tmp/script", "https://evil.example/", "https://accounts.google.com/other"]) await expect(openBrowser(url)).rejects.toThrow();
    expect(openExternal).toHaveBeenCalledOnce();
  });

  it("aborts a login and waits for provider callback cleanup before allowing another login", async () => {
    const { service, provider, configurePlugins } = setup();
    let cleaned = false;
    provider.login.mockImplementationOnce((_file, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { cleaned = true; reject(new Error("aborted SECRET")); });
    }));
    const pending = service.login();
    await vi.waitFor(() => expect(provider.login).toHaveBeenCalledOnce());
    await expect(service.login()).rejects.toThrow("正在进行");
    await expect(service.logout()).rejects.toThrow("正在进行");
    await service.cancel();
    expect(cleaned).toBe(true);
    expect(await pending).toBeNull();
    expect(configurePlugins).not.toHaveBeenCalled();
    expect(await service.login()).toEqual({ connected: true, email: "me@example.com" });
  });

  it("cleans up cancellation during native file selection and handles picker dismissal", async () => {
    const { service, provider, chooseClientFile, configurePlugins } = setup();
    let choose!: (file: string) => void;
    chooseClientFile.mockImplementationOnce(() => new Promise(resolve => { choose = resolve; }));
    const pending = service.login();
    const cancelled = service.cancel();
    choose("/private/client.json");
    await cancelled;
    expect(await pending).toBeNull();
    expect(provider.login).not.toHaveBeenCalled();
    expect(configurePlugins).not.toHaveBeenCalled();
    chooseClientFile.mockResolvedValueOnce(undefined);
    expect(await service.login()).toBeNull();
    expect(provider.login).not.toHaveBeenCalled();
  });

  it("provides actionable safe errors, preserves retry and never forwards raw credential failures", async () => {
    const { service, provider } = setup();
    provider.login.mockRejectedValueOnce(new GoogleOAuthError("token.scope"));
    await expect(service.login()).rejects.toThrow("权限");
    provider.login.mockRejectedValueOnce(new GoogleOAuthError("authorization.timeout"));
    await expect(service.login()).rejects.toThrow("回调已关闭");
    provider.login.mockRejectedValueOnce(new Error("SECRET client_secret=private"));
    await expect(service.login()).rejects.toThrow("Desktop OAuth 客户端 JSON");
    const unknownError = Object.assign(new GoogleOAuthError("token.exchange"), { code: "new-sdk-code", message: "SECRET" });
    provider.login.mockRejectedValueOnce(unknownError);
    await expect(service.login()).rejects.toThrow("Google 授权失败");
    provider.status.mockRejectedValueOnce(new Error("SECRET"));
    await expect(service.status()).rejects.toThrow("钥匙串");
    provider.logout.mockRejectedValueOnce(new Error("SECRET"));
    await expect(service.logout()).rejects.toThrow("凭据已保留");
    await service.logout();
    expect(provider.logout).toHaveBeenCalledTimes(2);
  });

  it("keeps the stored account when plugin configuration fails and allows a safe retry", async () => {
    const { service, provider, configurePlugins } = setup();
    configurePlugins.mockRejectedValueOnce(new Error("SECRET plugins.yml path"));
    await expect(service.login()).rejects.toThrow("已连接但配置失败");
    expect(provider.logout).not.toHaveBeenCalled();
    expect(await service.status()).toMatchObject({ connected: true, email: "me@example.com" });
    expect(await service.login()).toEqual({ connected: true, email: "me@example.com" });
    expect(configurePlugins).toHaveBeenCalledTimes(2);
  });

  it("delegates default setup to the shared SDK helper without writing actual user configuration", async () => {
    const { provider, chooseClientFile, openExternal } = setup();
    vi.mocked(configureGoogleAccountPlugins).mockClear();
    const service = createGoogleAuthService({ provider, chooseClientFile, openExternal });
    await service.login();
    expect(configureGoogleAccountPlugins).toHaveBeenCalledWith();
  });
});
