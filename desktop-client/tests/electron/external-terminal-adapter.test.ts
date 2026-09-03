import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createExternalTerminalAdapter,
  createLaunchServicesApplicationDetector,
} from "../../electron/adapters/external-terminal-adapter";

type ExecCall = {
  file: string;
  args: readonly string[];
};

const ITERM2_SCRIPT = `on run argv
  set hostAlias to item 1 of argv
  set sshCommand to "/usr/bin/ssh -- " & quoted form of hostAlias
  tell application "iTerm2"
    activate
    create window with default profile command sshCommand
  end tell
end run`;

const TERMINAL_SCRIPT = `on run argv
  set hostAlias to item 1 of argv
  set sshCommand to "/usr/bin/ssh -- " & quoted form of hostAlias
  tell application "Terminal"
    activate
    do script sshCommand
  end tell
end run`;

function commandError(message: string, code: string | number, stderr: string) {
  return Object.assign(new Error(message), { code, stderr });
}

function createHarness(options: {
  platform?: NodeJS.Platform;
  iTerm2Installed?: boolean;
  launchError?: Error;
} = {}) {
  const calls: ExecCall[] = [];
  const detections: string[] = [];
  const adapter = createExternalTerminalAdapter({
    platform: options.platform ?? "darwin",
    isApplicationInstalled: async (application) => {
      detections.push(application);
      return options.iTerm2Installed ?? true;
    },
    execFile: async (file, args) => {
      calls.push({ file, args });
      if (options.launchError) throw options.launchError;
      return { stdout: "", stderr: "" };
    },
  });
  return { adapter, calls, detections };
}

describe("LaunchServices application detection", () => {
  it("uses a fixed osascript bundle-id query when LaunchServices finds the application", async () => {
    const calls: ExecCall[] = [];
    const detect = createLaunchServicesApplicationDetector(async (file, args) => {
      calls.push({ file, args });
      return { stdout: "com.googlecode.iterm2\n", stderr: "" };
    });

    await expect(detect("com.googlecode.iterm2")).resolves.toBe(true);
    expect(calls).toEqual([{
      file: "/usr/bin/osascript",
      args: ["-e", 'get id of application id "com.googlecode.iterm2"'],
    }]);
  });

  it("reports explicitly missing only for AppleScript error number -1728", async () => {
    const detect = createLaunchServicesApplicationDetector(async () => {
      throw commandError(
        "application not found",
        1,
        "execution error: Can’t get application id \"im.afk.missing\". (-1728)",
      );
    });

    await expect(detect("im.afk.missing")).resolves.toBe(false);
  });

  it("reports a detection failure for other exec or AppleScript errors", async () => {
    const detect = createLaunchServicesApplicationDetector(async () => {
      throw commandError("automation denied", 1, "execution error: Not authorized. (-1743)");
    });

    await expect(detect("com.googlecode.iterm2")).rejects.toThrow("外部终端检测失败");
  });

  it.runIf(process.platform === "darwin")("queries installed and missing bundles without launching an application", async () => {
    const detect = createLaunchServicesApplicationDetector();

    await expect(detect("com.apple.Terminal")).resolves.toBe(true);
    await expect(detect(`im.afk.missing.${randomUUID()}`)).resolves.toBe(false);
  });
});

describe("external terminal adapter", () => {
  it("prefers iTerm2 when it is installed", async () => {
    const { adapter, calls, detections } = createHarness();

    await expect(adapter.open("aliyun")).resolves.toBe("iTerm2");

    expect(detections).toEqual(["com.googlecode.iterm2"]);
    expect(calls).toEqual([{
      file: "/usr/bin/osascript",
      args: ["-e", ITERM2_SCRIPT, "--", "aliyun"],
    }]);
  });

  it("falls back to Terminal.app only when iTerm2 is not installed", async () => {
    const { adapter, calls } = createHarness({ iTerm2Installed: false });

    await expect(adapter.open("dev-server")).resolves.toBe("Terminal.app");

    expect(calls).toEqual([{
      file: "/usr/bin/osascript",
      args: ["-e", TERMINAL_SCRIPT, "--", "dev-server"],
    }]);
  });

  it("launches the explicitly selected Ghostty without probing or falling back to iTerm2", async () => {
    const calls: ExecCall[] = [];
    const detections: string[] = [];
    const adapter = createExternalTerminalAdapter({
      platform: "darwin",
      isApplicationInstalled: async (bundleId) => { detections.push(bundleId); return bundleId === "com.mitchellh.ghostty"; },
      execFile: async (file, args) => { calls.push({ file, args }); return { stdout: "", stderr: "" }; },
    });

    await expect(adapter.open("build-box", "ghostty")).resolves.toBe("Ghostty");
    expect(detections).toEqual(["com.mitchellh.ghostty"]);
    expect(calls).toEqual([{ file: "/usr/bin/open", args: ["-na", "Ghostty.app", "--args", "-e", "/usr/bin/ssh", "--", "build-box"] }]);
  });

  it("launches cmux with a shell-quoted SSH alias", async () => {
    const calls: ExecCall[] = [];
    const adapter = createExternalTerminalAdapter({
      platform: "darwin",
      isApplicationInstalled: async () => true,
      execFile: async (file, args) => { calls.push({ file, args }); return { stdout: "", stderr: "" }; },
    });
    const alias = "prod'; echo owned; #";

    await expect(adapter.open(alias, "cmux")).resolves.toBe("cmux");
    expect(calls).toEqual([{ file: "/Applications/cmux.app/Contents/Resources/bin/cmux", args: ["new-workspace", "--command", "/usr/bin/ssh -- 'prod'\\''; echo owned; #'" ] }]);
  });

  it("launches Warp through a fixed AppleScript without embedding the alias", async () => {
    const calls: ExecCall[] = [];
    const adapter = createExternalTerminalAdapter({
      platform: "darwin",
      isApplicationInstalled: async () => true,
      execFile: async (file, args) => { calls.push({ file, args }); return { stdout: "", stderr: "" }; },
    });
    const alias = "prod'; touch /tmp/owned; echo '";

    await expect(adapter.open(alias, "warp")).resolves.toBe("Warp");
    expect(calls[0].file).toBe("/usr/bin/osascript");
    expect(calls[0].args[1]).toContain('tell application "Warp"');
    expect(calls[0].args[1]).toContain("quoted form of hostAlias");
    expect(calls[0].args[1]).not.toContain(alias);
    expect(calls[0].args.slice(2)).toEqual(["--", alias]);
  });

  it("keeps the AppleScript fixed and passes an untrusted alias only as the final argv", async () => {
    const maliciousAlias = "prod'; touch /tmp/owned; echo '";
    const { adapter, calls } = createHarness();

    await adapter.open(maliciousAlias);

    expect(calls).toEqual([{
      file: "/usr/bin/osascript",
      args: ["-e", ITERM2_SCRIPT, "--", maliciousAlias],
    }]);
    expect(ITERM2_SCRIPT).toContain('set sshCommand to "/usr/bin/ssh -- " & quoted form of hostAlias');
    expect(ITERM2_SCRIPT).toContain("create window with default profile command sshCommand");
    expect(ITERM2_SCRIPT).not.toContain(maliciousAlias);
  });

  it("fails explicitly outside macOS without detecting or launching an application", async () => {
    const { adapter, calls, detections } = createHarness({ platform: "linux" });

    await expect(adapter.open("aliyun")).rejects.toThrow("外部终端仅支持 macOS");
    expect(detections).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("does not open Terminal.app after an iTerm2 launch failure", async () => {
    const { adapter, calls } = createHarness({ launchError: new Error("launch failed") });

    await expect(adapter.open("aliyun")).rejects.toThrow("外部终端启动失败");
    expect(calls).toEqual([{
      file: "/usr/bin/osascript",
      args: ["-e", ITERM2_SCRIPT, "--", "aliyun"],
    }]);
  });
});
