import { exec } from "./process-executor";

type ExecResult = { ok: boolean; stdout: string; stderr: string };

export type JumpserverAssetRow = {
  name: string;
  address: string;
  platform: string;
  rawType: string;
};

export type JumpserverServer = {
  alias: string;
  host: string;
  username: string;
  isDefault: boolean;
};

export type JumpserverCliOptions = {
  exec?: (command: string, args: string[], cwd?: string, input?: string, options?: { timeoutMs?: number; maxBuffer?: number }) => Promise<ExecResult>;
  resolveBinary?: () => Promise<string>;
};

function parseServerLine(line: string): JumpserverServer | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  // Default marker: * prefix
  const isDefault = trimmed.startsWith("*");
  const content = isDefault ? trimmed.slice(1).trim() : trimmed;
  // Format: alias host username
  const parts = content.split(/\s+/);
  if (parts.length < 3) return null;
  return {
    alias: parts[0],
    host: parts[1],
    username: parts[2],
    isDefault,
  };
}

function parseAssetLine(line: string): JumpserverAssetRow | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  // Skip separator lines (dashes only)
  if (/^-+$/.test(trimmed)) return null;
  // Skip header-like lines
  if (trimmed.startsWith("Name") || trimmed.startsWith("name")) return null;
  // Skip info lines
  if (trimmed.startsWith("[INFO]")) return null;
  // Whitespace-split columns: Name, Address, Platform, Type
  const parts = trimmed.split(/\s+/);
  if (parts.length < 4) return null;
  return {
    name: parts[0],
    address: parts[1],
    platform: parts[2],
    rawType: parts[3],
  };
}

export function createJumpserverCli(options: JumpserverCliOptions = {}) {
  const execFn = options.exec ?? exec;
  const resolveBinaryFn = options.resolveBinary ?? (() => execFn("which", ["jms"]).then((r) => (r.ok ? r.stdout.trim() : "")));

  return {
    async listServers(): Promise<JumpserverServer[]> {
      const result = await execFn("jms", ["config", "list"]);
      if (!result.ok) return [];
      const lines = result.stdout.split(/\r?\n/);
      const servers: JumpserverServer[] = [];
      for (const line of lines) {
        const server = parseServerLine(line);
        if (server) servers.push(server);
      }
      return servers;
    },

    async addServer(input: { alias: string; host: string; port?: number; username: string; password: string }): Promise<{ ok: boolean; alias: string }> {
      const port = input.port ?? 2222;
      const stdin = [input.host, String(port), input.username, input.password, input.password].join("\n");
      const result = await execFn("jms", ["config", "add", input.alias], undefined, stdin);
      if (!result.ok) {
        return { ok: false, alias: input.alias };
      }
      return { ok: true, alias: input.alias };
    },

    async removeServer(alias: string): Promise<boolean> {
      const result = await execFn("jms", ["config", "remove", alias]);
      return result.ok;
    },

    async listAssets(serverAlias: string, opts?: { linuxOnly?: boolean }): Promise<JumpserverAssetRow[]> {
      const result = await execFn("jms", ["ls", serverAlias]);
      if (!result.ok) return [];
      const lines = result.stdout.split(/\r?\n/);
      const rows: JumpserverAssetRow[] = [];
      for (const line of lines) {
        const row = parseAssetLine(line);
        if (!row) continue;
        if (opts?.linuxOnly !== false && !row.platform.startsWith("Linux")) continue;
        rows.push(row);
      }
      return rows;
    },

    async probeAssetReachability(input: { asset: string; serverAlias: string; command?: string }): Promise<boolean> {
      const cmd = input.command ?? "true";
      const result = await execFn("jms", ["exec", `${input.asset}@${input.serverAlias}`, `'${cmd}'`]);
      if (!result.ok) return false;
      return result.stdout === "true";
    },

    async resolveBinaryPath(): Promise<string> {
      return resolveBinaryFn();
    },
  };
}

export const JUMPSERVER_BINARY_ERROR = "未检测到 jms CLI，请先运行 brew install jms 或访问 https://github.com/jumpserver/jms 获取安装步骤";
