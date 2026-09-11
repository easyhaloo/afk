import { homedir } from "node:os";
import path from "node:path";
import type { AgentRuntime } from "../../shared/ipc-contract";
import { exec, executable, firstLine } from "../adapters/process-executor";

type AgentRuntimeDefinition = Pick<AgentRuntime, "id" | "label" | "command"> & { versionArgs: string[] };

const DEFINITIONS: AgentRuntimeDefinition[] = [
  { id: "claude", label: "Claude Code", command: "claude", versionArgs: ["--version"] },
  { id: "codex", label: "Codex", command: "codex", versionArgs: ["--version"] },
  { id: "cursor", label: "Cursor Agent", command: "cursor-agent", versionArgs: ["--version"] },
  { id: "pi", label: "Pi", command: "pi", versionArgs: ["--version"] },
  { id: "opencode", label: "OpenCode", command: "opencode", versionArgs: ["--version"] },
  { id: "copilot", label: "GitHub Copilot", command: "copilot", versionArgs: ["--version"] },
];

function installationSource(executablePath: string) {
  const directory = path.dirname(executablePath);
  if (directory === path.join(homedir(), "Library", "pnpm")) return "pnpm";
  if (directory === path.join(homedir(), ".bun", "bin")) return "Bun";
  if (directory === path.join(homedir(), ".cargo", "bin")) return "Cargo";
  if (directory === "/opt/homebrew/bin" || directory === "/opt/homebrew/sbin") return "Homebrew";
  if (directory === "/usr/local/bin") return "本地全局路径";
  return "PATH";
}

export async function detectAgentRuntimes(): Promise<AgentRuntime[]> {
  return Promise.all(DEFINITIONS.map(async (definition) => {
    const checkedAt = new Date().toISOString();
    const executablePath = await executable(definition.command);
    const installation = { source: executablePath ? installationSource(executablePath) : "—", version: "", checkedAt };
    if (!executablePath) return { ...definition, available: false, executable: "", status: "missing" as const, installation, summary: "未在诊断 PATH 中发现 " + definition.command };
    const version = await exec(executablePath, definition.versionArgs);
    if (!version.ok) return { ...definition, available: false, executable: executablePath, status: "error" as const, installation, summary: "已发现命令，但版本检测失败：" + firstLine(version.stderr, "未知错误") };
    const versionText = firstLine(version.stdout || version.stderr, "已发现可调用命令");
    return { ...definition, available: true, executable: executablePath, status: "available" as const, installation: { ...installation, version: versionText }, summary: versionText };
  }));
}
