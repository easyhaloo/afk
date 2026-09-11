import { describe, expect, it, vi } from "vitest";
import { createExternalUrlService } from "../../electron/services/external-url-service";

describe("external URL service", () => {
  it("opens HTTP(S) URLs through the injected desktop adapter", async () => {
    const openExternal = vi.fn(async () => undefined);
    const service = createExternalUrlService({ openExternal });

    await expect(service.open("https://github.com/example/issues/42")).resolves.toBe(true);
    expect(openExternal).toHaveBeenCalledWith("https://github.com/example/issues/42");
  });

  it("rejects non-web protocols before invoking the desktop adapter", async () => {
    const openExternal = vi.fn(async () => undefined);
    const service = createExternalUrlService({ openExternal });

    await expect(service.open("file:///tmp/secret")).rejects.toThrow("只允许打开 http 或 https 地址");
    expect(openExternal).not.toHaveBeenCalled();
  });
});
