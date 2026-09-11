import { promises as fs } from "node:fs";
import path from "node:path";
import type { ManagedSshHostInput, ManagedSshHostRecord, SshDiagnostic, SshHost, SshJumpHostType, SshListResult } from "../../shared/ssh-contract";
import { validateSshHostInput } from "../security/ssh-validation";

type ExecResult = { ok: boolean; stdout: string; stderr: string };

type SshConfigAdapterOptions = {
  home: string;
  exec: (command: string, args: string[]) => Promise<ExecResult>;
  managedStore?: {
    list: () => Promise<ManagedSshHostRecord[]>;
    upsert: (input: ManagedSshHostInput) => Promise<ManagedSshHostRecord>;
    update: (id: string, input: ManagedSshHostInput) => Promise<ManagedSshHostRecord>;
    remove: (id: string) => Promise<boolean>;
  };
  fileSystem?: Pick<typeof fs, "chmod" | "mkdir" | "readFile" | "rename" | "rm" | "stat" | "writeFile">;
};

type ConfigBlock = {
  alias: string;
  lines: string[];
  values: Record<string, string>;
};

type ConfigFingerprint =
  | { exists: false }
  | { exists: true; mtimeMs: number; size: number };

type ParsedConfig = ReturnType<typeof parseBlocks>;

type ConfigCacheEntry = {
  fingerprint: ConfigFingerprint;
  parsed: ParsedConfig;
};

const includeLine = "Include ~/.ssh/afk_hosts";

function sshDir(home: string) { return path.join(home, ".ssh"); }
function userConfigPath(home: string) { return path.join(sshDir(home), "config"); }
function managedConfigPath(home: string) { return path.join(sshDir(home), "afk_hosts"); }

function isConcreteAlias(alias: string) {
  return /^[A-Za-z0-9_.-]+$/.test(alias) && alias !== "." && alias !== "..";
}

function parseDirective(line: string) {
  const match = line.trim().match(/^([A-Za-z][A-Za-z0-9]*)(?:\s*=\s*|\s+)(.+?)\s*$/);
  if (!match) return null;
  return { key: match[1].toLowerCase(), value: match[2] };
}

function tokenizeSafetyValue(value: string) {
  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
    } else if (character === '"' || character === "'") {
      quote = character;
      tokenStarted = true;
    } else if (character === "#" && !tokenStarted) {
      break;
    } else if (/\s/.test(character)) {
      if (tokenStarted) tokens.push(token);
      token = "";
      tokenStarted = false;
    } else {
      token += character;
      tokenStarted = true;
    }
  }
  if (quote) return undefined;
  if (tokenStarted) tokens.push(token);
  return tokens;
}

function isHostKeyCheckingDisabled(value: string) {
  const setting = tokenizeSafetyValue(value)?.[0];
  return setting !== undefined && ["no", "off"].includes(setting.toLowerCase());
}

function isKnownHostsDisabled(value: string) {
  return tokenizeSafetyValue(value)?.some((file) => ["none", "/dev/null"].includes(file.toLowerCase())) ?? false;
}

function parseBlocks(raw: string, source: "system" | "managed", configPath: string) {
  const blocks: ConfigBlock[] = [];
  const diagnostics: SshDiagnostic[] = [];
  let current: ConfigBlock | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const directive = parseDirective(line);
    if (directive?.key === "host") {
      if (current) blocks.push(current);
      current = { alias: directive.value, lines: [line], values: {} };
      if (!isConcreteAlias(current.alias)) diagnostics.push({ code: "ssh.non-concrete-host", severity: "info", message: `已忽略非具体 Host：${current.alias}`, path: configPath });
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
    const metadata = line.trim().match(/^#\s*AFK\s+(JumpHostType|JumpHost)\s+(\S+)\s*$/i);
    if (metadata) {
      current.values[`afk${metadata[1].toLowerCase()}`] = metadata[2];
      continue;
    }
    if (!directive) {
      if (line.trim() && !line.trim().startsWith("#")) diagnostics.push({ code: "ssh.malformed-directive", severity: "warning", message: `Host ${current.alias} 包含无法解析的配置行`, path: configPath, hostAlias: current.alias });
      continue;
    }
    const { key, value } = directive;
    const isFirstValue = current.values[key] === undefined;
    if ((key === "stricthostkeychecking" || key === "userknownhostsfile") && isFirstValue) {
      current.values[key] = value;
    }
    if (key === "stricthostkeychecking" && isFirstValue && isHostKeyCheckingDisabled(value)) {
      diagnostics.push({ code: "ssh.host-key-checking-disabled", severity: "warning", message: `Host ${current.alias} 已关闭 SSH 主机密钥严格校验`, path: configPath, hostAlias: current.alias });
    }
    if (key === "userknownhostsfile" && isFirstValue && isKnownHostsDisabled(value)) {
      diagnostics.push({ code: "ssh.known-hosts-disabled", severity: "warning", message: `Host ${current.alias} 已禁用用户 known_hosts 文件`, path: configPath, hostAlias: current.alias });
    }
    if (["hostname", "port", "user", "identityfile", "proxyjump", "include"].includes(key) && isFirstValue) {
      current.values[key] = value;
    }
  }
  if (current) blocks.push(current);
  return { blocks: blocks.filter((block) => isConcreteAlias(block.alias)), diagnostics, source };
}

function hostFromBlock(block: ConfigBlock, source: "system" | "managed", configPath: string): SshHost {
  const port = Number.parseInt(block.values.port || "22", 10);
  const metadataType = block.values.afkjumphosttype === "openssh" || block.values.afkjumphosttype === "jumpserver" ? block.values.afkjumphosttype as SshJumpHostType : undefined;
  const jumpHost = block.values.afkjumphost || (block.values.proxyjump && !metadataType ? block.values.proxyjump : undefined);
  return {
    id: `${source}:${block.alias}`,
    alias: block.alias,
    hostname: block.values.hostname || block.alias,
    port: Number.isInteger(port) && port > 0 && port <= 65_535 ? port : 22,
    user: block.values.user,
    identityFile: block.values.identityfile,
    proxyJump: block.values.proxyjump,
    jumpHostType: metadataType || (block.values.proxyjump ? "openssh" : undefined),
    jumpHost,
    source,
    configPath,
    status: "untrusted",
  };
}

function hostFromManagedRecord(record: ManagedSshHostRecord, configPath: string): SshHost {
  return {
    id: record.id,
    alias: record.alias,
    hostname: record.hostname,
    port: record.port ?? 22,
    user: record.user,
    identityFile: record.identityFile,
    proxyJump: record.proxyJump,
    jumpHostType: record.jumpHostType,
    jumpHost: record.jumpHost,
    source: "managed",
    configPath,
    status: "untrusted",
    remoteWorkspace: record.remoteWorkspace,
  };
}

function managedBlock(input: ManagedSshHostInput) {
  const lines = [`Host ${input.alias}`, `  HostName ${input.hostname}`, `  Port ${input.port ?? 22}`];
  if (input.user) lines.push(`  User ${input.user}`);
  if (input.identityFile) lines.push(`  IdentityFile ${input.identityFile}`);
  if (input.jumpHostType === "jumpserver" && input.jumpHost) {
    lines.push(`  # AFK JumpHostType jumpserver`, `  # AFK JumpHost ${input.jumpHost}`);
  } else if (input.proxyJump || (input.jumpHostType === "openssh" && input.jumpHost)) {
    lines.push(`  ProxyJump ${input.proxyJump || input.jumpHost}`);
  }
  return `${lines.join("\n")}\n`;
}

function replaceBlock(raw: string, alias: string, replacement: string | null) {
  const lines = raw.split(/\r?\n/);
  const starts: number[] = [];
  lines.forEach((line, index) => { if (new RegExp(`^\\s*Host\\s+${alias.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*$`, "i").test(line)) starts.push(index); });
  if (!starts.length) return replacement ? `${raw.replace(/\s*$/, "")}\n\n${replacement}` : raw;
  const start = starts[0];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*Host\s+/i.test(lines[index])) { end = index; break; }
  }
  const next = [...lines.slice(0, start), ...(replacement ? replacement.trimEnd().split("\n") : []), ...lines.slice(end)];
  return `${next.join("\n").replace(/\n+$/, "")}\n`;
}

function isFileNotFound(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function fingerprintsMatch(left: ConfigFingerprint, right: ConfigFingerprint) {
  if (!left.exists || !right.exists) return left.exists === right.exists;
  return left.mtimeMs === right.mtimeMs && left.size === right.size;
}

async function readOrEmpty(fileSystem: NonNullable<SshConfigAdapterOptions["fileSystem"]>, file: string) {
  return fileSystem.readFile(file, "utf8").catch(() => "");
}

async function atomicWrite(fileSystem: NonNullable<SshConfigAdapterOptions["fileSystem"]>, file: string, content: string, mode = 0o600) {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fileSystem.writeFile(temporary, content, { mode });
  await fileSystem.chmod(temporary, mode);
  try { await fileSystem.rename(temporary, file); } catch (error) { await fileSystem.rm(temporary, { force: true }); throw error; }
}

export function createSshConfigAdapter({ home, exec, managedStore, fileSystem = fs }: SshConfigAdapterOptions) {
  const configPath = userConfigPath(home);
  const managedPath = managedConfigPath(home);
  const displayConfigPath = "~/.ssh/config";
  const displayManagedPath = managedStore ? "AFK 应用数据/ssh-hosts.yml" : "~/.ssh/afk_hosts";
  const configCache = new Map<string, ConfigCacheEntry>();
  let cacheGeneration = 0;
  let listHostsInFlight: Promise<SshListResult> | null = null;

  function invalidateConfigCache() {
    cacheGeneration += 1;
    configCache.clear();
    listHostsInFlight = null;
  }

  async function readParsedConfig(file: string, source: "system" | "managed", displayPath: string, generation: number) {
    let fingerprint: ConfigFingerprint;
    try {
      const stats = await fileSystem.stat(file);
      fingerprint = { exists: true, mtimeMs: stats.mtimeMs, size: stats.size };
    } catch (error) {
      if (isFileNotFound(error)) {
        fingerprint = { exists: false };
      } else {
        configCache.delete(file);
        const raw = await readOrEmpty(fileSystem, file);
        return parseBlocks(raw, source, displayPath);
      }
    }

    const cached = configCache.get(file);
    if (cached && fingerprintsMatch(cached.fingerprint, fingerprint)) return cached.parsed;

    if (!fingerprint.exists) {
      const parsed = parseBlocks("", source, displayPath);
      if (generation === cacheGeneration) configCache.set(file, { fingerprint, parsed });
      return parsed;
    }

    try {
      const raw = await fileSystem.readFile(file, "utf8");
      const parsed = parseBlocks(raw, source, displayPath);
      if (generation === cacheGeneration) configCache.set(file, { fingerprint, parsed });
      return parsed;
    } catch {
      configCache.delete(file);
      return parseBlocks("", source, displayPath);
    }
  }

  async function ensureSshDirectory() {
    await fileSystem.mkdir(sshDir(home), { recursive: true, mode: 0o700 });
    await fileSystem.chmod(sshDir(home), 0o700);
  }

  async function ensureInclude() {
    await ensureSshDirectory();
    const raw = await readOrEmpty(fileSystem, configPath);
    if (raw.split(/\r?\n/).some((line) => line.trim() === includeLine)) return;
    const existing = raw.replace(/^\s+|\s+$/g, "");
    await atomicWrite(fileSystem, configPath, existing ? `${includeLine}\n\n${existing}\n` : `${includeLine}\n`);
    invalidateConfigCache();
  }

  async function loadHosts(generation: number): Promise<SshListResult> {
    const [systemParsed, managedRecords, legacyManagedParsed] = await Promise.all([
      readParsedConfig(configPath, "system", displayConfigPath, generation),
      managedStore ? managedStore.list() : Promise.resolve([]),
      readParsedConfig(managedPath, "managed", managedStore ? "~/.ssh/afk_hosts" : displayManagedPath, generation),
    ]);
    const managedHosts = managedStore ? managedRecords.map((record) => hostFromManagedRecord(record, displayManagedPath)) : legacyManagedParsed.blocks.map((block) => hostFromBlock(block, "managed", displayManagedPath));
    const legacyHosts = managedStore ? legacyManagedParsed.blocks.map((block) => hostFromBlock(block, "managed", "~/.ssh/afk_hosts")) : [];
    const hosts = [...systemParsed.blocks.map((block) => hostFromBlock(block, "system", displayConfigPath)), ...managedHosts, ...legacyHosts];
    const seen = new Set<string>();
    const unique = hosts.filter((host) => { if (seen.has(host.id)) return false; seen.add(host.id); return true; });
    const diagnostics = [...systemParsed.diagnostics, ...legacyManagedParsed.diagnostics];
    for (const host of unique) {
      if (host.source === "managed") continue;
      const resolved = await exec("ssh", ["-G", host.alias]);
      if (!resolved.ok) diagnostics.push({ code: "ssh.resolve-failed", severity: "warning", message: `无法解析 SSH 主机 ${host.alias}`, path: host.configPath, hostAlias: host.alias });
    }
    return { hosts: unique, diagnostics };
  }

  function listHosts(): Promise<SshListResult> {
    if (listHostsInFlight) return listHostsInFlight;
    const request = loadHosts(cacheGeneration);
    listHostsInFlight = request;
    request.then(
      () => { if (listHostsInFlight === request) listHostsInFlight = null; },
      () => { if (listHostsInFlight === request) listHostsInFlight = null; },
    );
    return request;
  }

  async function upsertManagedHost(value: ManagedSshHostInput) {
    const input = validateSshHostInput(value);
    if (managedStore) return hostFromManagedRecord(await managedStore.upsert(input), displayManagedPath);
    await ensureSshDirectory();
    await ensureInclude();
    const raw = await readOrEmpty(fileSystem, managedPath);
    const next = replaceBlock(raw, input.alias, managedBlock(input));
    await atomicWrite(fileSystem, managedPath, next);
    invalidateConfigCache();
    const result = await listHosts();
    const host = result.hosts.find((item) => item.id === `managed:${input.alias}`);
    if (!host) throw new Error("AFK SSH 主机写入后无法重新读取");
    return host;
  }

  async function updateManagedHost(id: string, value: ManagedSshHostInput) {
    if (managedStore) return hostFromManagedRecord(await managedStore.update(id, value), displayManagedPath);
    if (!id.startsWith("managed:")) throw new Error("只能编辑 AFK 管理的 SSH 主机");
    const oldAlias = id.slice("managed:".length);
    if (!isConcreteAlias(oldAlias)) throw new Error("SSH 主机 ID 无效");
    const input = validateSshHostInput(value);
    await ensureSshDirectory();
    await ensureInclude();
    const raw = await readOrEmpty(fileSystem, managedPath);
    if (oldAlias !== input.alias && new RegExp(`^\\s*Host\\s+${input.alias.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")}\\s*$`, "im").test(raw)) throw new Error("SSH 主机别名已存在");
    const withoutOld = replaceBlock(raw, oldAlias, null);
    const next = replaceBlock(withoutOld, input.alias, managedBlock(input));
    await atomicWrite(fileSystem, managedPath, next);
    invalidateConfigCache();
    const result = await listHosts();
    const host = result.hosts.find((item) => item.id === `managed:${input.alias}`);
    if (!host) throw new Error("AFK SSH 主机更新后无法重新读取");
    return host;
  }

  async function removeManagedHost(id: string) {
    if (managedStore) return managedStore.remove(id);
    if (!id.startsWith("managed:")) throw new Error("只能删除 AFK 管理的 SSH 主机");
    const alias = id.slice("managed:".length);
    if (!isConcreteAlias(alias)) throw new Error("SSH 主机 ID 无效");
    const raw = await readOrEmpty(fileSystem, managedPath);
    await atomicWrite(fileSystem, managedPath, replaceBlock(raw, alias, null));
    invalidateConfigCache();
    return true;
  }

  async function removeSystemHost(id: string) {
    if (!id.startsWith("system:")) throw new Error("只能清理系统 SSH 主机");
    const alias = id.slice("system:".length);
    if (!isConcreteAlias(alias)) throw new Error("SSH 主机 ID 无效");
    const raw = await readOrEmpty(fileSystem, configPath);
    await atomicWrite(fileSystem, configPath, replaceBlock(raw, alias, null));
    invalidateConfigCache();
    return true;
  }

  return { listHosts, upsertManagedHost, updateManagedHost, removeManagedHost, removeSystemHost, ensureInclude };
}
