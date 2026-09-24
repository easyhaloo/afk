import { describe, expect, it, vi } from "vitest";
import { resolveWorkItemCli } from "../../electron/services/work-item-cli-service";

function deps() {
  return {
    appPath: "/src/afk/desktop-client",
    packaged: false,
    exists: vi.fn(async () => true),
    which: vi.fn(async () => "/usr/local/bin/afk"),
    help: vi.fn(async () => ({ ok: true, stdout: "--execution-manifest <path>" })),
  };
}

describe("work item CLI resolver", () => {
  it("prefers the local built CLI for desktop development", async () => {
    const options = deps();
    await expect(resolveWorkItemCli(options)).resolves.toBe("/src/afk/dist/index.js");
    expect(options.which).not.toHaveBeenCalled();
    expect(options.help).toHaveBeenCalledWith("/src/afk/dist/index.js");
  });

  it("rejects an installed CLI that cannot consume execution manifests", async () => {
    const options = { ...deps(), packaged: true, help: vi.fn(async () => ({ ok: true, stdout: "Usage: afk run" })) };
    await expect(resolveWorkItemCli(options)).rejects.toThrow("不支持 --execution-manifest");
    expect(options.which).toHaveBeenCalledOnce();
  });

  it("honors an explicit absolute CLI override", async () => {
    const options = { ...deps(), configuredCli: "/opt/afk-new/bin/afk" };
    await expect(resolveWorkItemCli(options)).resolves.toBe(options.configuredCli);
    expect(options.help).toHaveBeenCalledWith(options.configuredCli);
  });
});
