import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import type { SshExternalTerminalId } from "../../shared/ssh-contract";

export type ExternalTerminalName = "iTerm2" | "Warp" | "Ghostty" | "cmux" | "Terminal.app";

type ExecFileResult = {
  stdout: string;
  stderr: string;
};

type ExecFile = (file: string, args: readonly string[]) => Promise<ExecFileResult>;

type ExternalTerminalAdapterOptions = {
  execFile?: ExecFile;
  platform?: NodeJS.Platform;
  isApplicationInstalled?: (bundleId: string) => Promise<boolean>;
};

const runExecFile = promisify(nodeExecFile);
const TERMINAL_BUNDLE_IDS: Record<SshExternalTerminalId, string> = {
  iterm2: "com.googlecode.iterm2",
  warp: "dev.warp.Warp-Stable",
  ghostty: "com.mitchellh.ghostty",
  cmux: "com.cmuxterm.app",
  terminal: "com.apple.Terminal",
};

const TERMINAL_LABELS: Record<SshExternalTerminalId, ExternalTerminalName> = {
  iterm2: "iTerm2",
  warp: "Warp",
  ghostty: "Ghostty",
  cmux: "cmux",
  terminal: "Terminal.app",
};

const CMUX_CLI = "/Applications/cmux.app/Contents/Resources/bin/cmux";

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

const WARP_SCRIPT = `on run argv
  set hostAlias to item 1 of argv
  set sshCommand to "/usr/bin/ssh -- " & quoted form of hostAlias
  tell application "Warp"
    activate
  end tell
  tell application "System Events"
    keystroke sshCommand
    key code 36
  end tell
end run`;

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function defaultExecFile(file: string, args: readonly string[]) {
  const { stdout, stderr } = await runExecFile(file, [...args]);
  return { stdout: String(stdout), stderr: String(stderr) };
}

function isExplicitBundleNotFound(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const details = error as { code?: string | number; stderr?: string | Buffer };
  const stderr = String(details.stderr ?? "");
  return details.code === 1 && /\(-1728\)\s*$/m.test(stderr);
}

export function createLaunchServicesApplicationDetector(execFile: ExecFile = defaultExecFile) {
  return async (bundleId: string) => {
    try {
      await execFile("/usr/bin/osascript", ["-e", `get id of application id "${bundleId}"`]);
      return true;
    } catch (error) {
      if (isExplicitBundleNotFound(error)) return false;
      throw new Error("外部终端检测失败");
    }
  };
}

export function createExternalTerminalAdapter(options: ExternalTerminalAdapterOptions = {}) {
  const execFile = options.execFile ?? defaultExecFile;
  const platform = options.platform ?? process.platform;
  const isApplicationInstalled = options.isApplicationInstalled ?? createLaunchServicesApplicationDetector(execFile);

  return {
    async open(alias: string, requestedTerminalId?: SshExternalTerminalId): Promise<ExternalTerminalName> {
      if (platform !== "darwin") throw new Error("外部终端仅支持 macOS");
      let terminalId = requestedTerminalId;
      if (!terminalId) terminalId = await isApplicationInstalled(TERMINAL_BUNDLE_IDS.iterm2) ? "iterm2" : "terminal";
      else if (!await isApplicationInstalled(TERMINAL_BUNDLE_IDS[terminalId])) throw new Error(`${TERMINAL_LABELS[terminalId]} 未安装`);
      try {
        if (terminalId === "ghostty") {
          await execFile("/usr/bin/open", ["-na", "Ghostty.app", "--args", "-e", "/usr/bin/ssh", "--", alias]);
        } else if (terminalId === "cmux") {
          await execFile(CMUX_CLI, ["new-workspace", "--command", `/usr/bin/ssh -- ${shellQuote(alias)}`]);
        } else {
          const script = terminalId === "iterm2" ? ITERM2_SCRIPT : terminalId === "warp" ? WARP_SCRIPT : TERMINAL_SCRIPT;
          await execFile("/usr/bin/osascript", ["-e", script, "--", alias]);
        }
      } catch {
        throw new Error("外部终端启动失败");
      }
      return TERMINAL_LABELS[terminalId];
    },
  };
}
