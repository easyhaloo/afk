import { exec } from "./process-executor.js";

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

export type JumpserverCommandResult = { ok: boolean; stdout: string; stderr: string };

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

// `jms config list` and `jms ls` pad columns with runs of spaces, and a long
// value runs straight into the next column ("https://host.example.comuser").
// Whitespace splitting cannot recover those rows, so column offsets are taken
// from the header line and applied by position.
const COLUMN_NAMES = ["Alias", "Host", "Username", "Default", "Name", "Address", "Platform", "Type"] as const;

type Columns = Map<string, number>;

function headerColumns(line: string): Columns | null {
  if (!/\S {2,}\S/.test(line)) return null;
  const columns: Columns = new Map();
  for (const name of COLUMN_NAMES) {
    const index = line.indexOf(name);
    if (index !== -1) columns.set(name, index);
  }
  return columns.size >= 2 ? columns : null;
}

function sliceColumn(line: string, start: number, end: number | undefined) {
  return (end === undefined ? line.slice(start) : line.slice(start, end)).trim();
}

function parsePaddedServerLine(line: string, columns: Columns): JumpserverServer | null {
  const hostStart = columns.get("Host");
  const usernameStart = columns.get("Username");
  if (hostStart === undefined || usernameStart === undefined) return null;
  if (!line.trim() || /^-+$/.test(line.trim()) || /^Total:/.test(line.trim())) return null;
  const defaultStart = columns.get("Default");
  const alias = sliceColumn(line, 0, hostStart);
  const host = sliceColumn(line, hostStart, usernameStart);
  const username = sliceColumn(line, usernameStart, defaultStart);
  if (!alias || !host) return null;
  return { alias, host, username, isDefault: defaultStart === undefined ? false : line.slice(defaultStart).includes("*") };
}

function parsePaddedAssetLine(line: string, columns: Columns): JumpserverAssetRow | null {
  const addressStart = columns.get("Address");
  const platformStart = columns.get("Platform");
  const typeStart = columns.get("Type");
  if (addressStart === undefined || platformStart === undefined) return null;
  const trimmed = line.trim();
  if (!trimmed || /^-+$/.test(trimmed) || trimmed.startsWith("[INFO]") || /^Total:/.test(trimmed)) return null;
  const name = sliceColumn(line, 0, addressStart);
  const address = sliceColumn(line, addressStart, platformStart);
  const platform = sliceColumn(line, platformStart, typeStart);
  const rawType = typeStart === undefined ? "" : sliceColumn(line, typeStart, undefined);
  if (!name || !address || !platform) return null;
  return { name, address, platform, rawType };
}

export function createJumpserverCli(options: JumpserverCliOptions = {}) {
  const execFn = options.exec ?? exec;
  const resolveBinaryFn = options.resolveBinary ?? (() => execFn("which", ["jms"]).then((r) => (r.ok ? r.stdout.trim() : "")));

  return {
    async listServers(): Promise<JumpserverServer[]> {
      const result = await execFn("jms", ["config", "list"]);
      if (!result.ok) return [];
      const lines = result.stdout.split(/\r?\n/);
      const columns = lines.map(headerColumns).find(Boolean) ?? null;
      const servers: JumpserverServer[] = [];
      for (const line of lines) {
        const server = columns ? parsePaddedServerLine(line, columns) : parseServerLine(line);
        if (server && server.alias !== "Alias") servers.push(server);
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
      const columns = lines.map(headerColumns).find((value) => value?.has("Address")) ?? null;
      const rows: JumpserverAssetRow[] = [];
      for (const line of lines) {
        const row = columns ? parsePaddedAssetLine(line, columns) : parseAssetLine(line);
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

    // Runs one command on an asset through the bastion. `target` is the jms
    // `<asset>@<server>` pair; the command stays a single argv entry, so it is
    // never interpreted by a shell.
    async execCommand(target: string, command: string): Promise<JumpserverCommandResult> {
      const result = await execFn("jms", ["exec", target, command]);
      return { ok: result.ok, stdout: result.stdout.trim(), stderr: result.stderr };
    },

    // Uploads a local file into a remote directory. jms detects the direction
    // from whichever side of the pair carries the `asset@server:` prefix.
    async uploadFile(localPath: string, target: string, remoteDirectory: string): Promise<{ ok: boolean; stderr: string }> {
      const directory = remoteDirectory.endsWith("/") ? remoteDirectory : `${remoteDirectory}/`;
      const result = await execFn("jms", ["sftp", localPath, `${target}:${directory}`]);
      return { ok: result.ok, stderr: result.stderr };
    },

    async resolveBinaryPath(): Promise<string> {
      return resolveBinaryFn();
    },
  };
}

export const JUMPSERVER_BINARY_ERROR = "未检测到 jms CLI，请先运行 brew install jms 或访问 https://github.com/jumpserver/jms 获取安装步骤";
