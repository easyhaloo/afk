import { promises as fs } from "node:fs";
import path from "node:path";
import type { ManagedSshHostInput, SshDiagnostic, SshHost, SshListResult } from "../../shared/ssh-contract";
import { validateSshHostInput } from "../security/ssh-validation";

type ExecResult = { ok: boolean; stdout: string; stderr: string };

type SshConfigAdapterOptions = {
  home: string;
  exec: (command: string, args: string[]) => Promise<ExecResult>;
};

type ConfigBlock = {
  alias: string;
  lines: string[];
  values: Record<string, string>;
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
    if (!directive) {
      if (line.trim() && !line.trim().startsWith("#")) diagnostics.push({ code: "ssh.malformed-directive", severity: "warning", message: `Host ${current.alias} 包含无法解析的配置行`, path: configPath, hostAlias: current.alias });
      continue;
    }
    const { key, value } = directive;
    if (key === "stricthostkeychecking" && isHostKeyCheckingDisabled(value)) {
      diagnostics.push({ code: "ssh.host-key-checking-disabled", severity: "warning", message: `Host ${current.alias} 已关闭 SSH 主机密钥严格校验`, path: configPath, hostAlias: current.alias });
    }
    if (key === "userknownhostsfile" && isKnownHostsDisabled(value)) {
      diagnostics.push({ code: "ssh.known-hosts-disabled", severity: "warning", message: `Host ${current.alias} 已禁用用户 known_hosts 文件`, path: configPath, hostAlias: current.alias });
    }
    if (["hostname", "port", "user", "identityfile", "proxyjump", "include"].includes(key) && current.values[key] === undefined) {
      current.values[key] = value;
    }
  }
  if (current) blocks.push(current);
  return { blocks: blocks.filter((block) => isConcreteAlias(block.alias)), diagnostics, source };
}

function hostFromBlock(block: ConfigBlock, source: "system" | "managed", configPath: string): SshHost {
  const port = Number.parseInt(block.values.port || "22", 10);
  return {
    id: `${source}:${block.alias}`,
    alias: block.alias,
    hostname: block.values.hostname || block.alias,
    port: Number.isInteger(port) && port > 0 && port <= 65_535 ? port : 22,
    user: block.values.user,
    identityFile: block.values.identityfile,
    proxyJump: block.values.proxyjump,
    source,
    configPath,
    status: "untrusted",
  };
}

function managedBlock(input: ManagedSshHostInput) {
  const lines = [`Host ${input.alias}`, `  HostName ${input.hostname}`, `  Port ${input.port ?? 22}`];
  if (input.user) lines.push(`  User ${input.user}`);
  if (input.identityFile) lines.push(`  IdentityFile ${input.identityFile}`);
  if (input.proxyJump) lines.push(`  ProxyJump ${input.proxyJump}`);
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

async function readOrEmpty(file: string) {
  return fs.readFile(file, "utf8").catch(() => "");
}

async function atomicWrite(file: string, content: string, mode = 0o600) {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, content, { mode });
  await fs.chmod(temporary, mode);
  try { await fs.rename(temporary, file); } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
}

export function createSshConfigAdapter({ home, exec }: SshConfigAdapterOptions) {
  const configPath = userConfigPath(home);
  const managedPath = managedConfigPath(home);
  const displayConfigPath = "~/.ssh/config";
  const displayManagedPath = "~/.ssh/afk_hosts";

  async function ensureSshDirectory() {
    await fs.mkdir(sshDir(home), { recursive: true, mode: 0o700 });
    await fs.chmod(sshDir(home), 0o700);
  }

  async function ensureInclude() {
    await ensureSshDirectory();
    const raw = await readOrEmpty(configPath);
    if (raw.split(/\r?\n/).some((line) => line.trim() === includeLine)) return;
    await atomicWrite(configPath, `${raw.replace(/\s*$/, "")}\n\n${includeLine}\n`);
  }

  async function listHosts(): Promise<SshListResult> {
    const [systemRaw, managedRaw] = await Promise.all([readOrEmpty(configPath), readOrEmpty(managedPath)]);
    const systemParsed = parseBlocks(systemRaw, "system", displayConfigPath);
    const managedParsed = parseBlocks(managedRaw, "managed", displayManagedPath);
    const hosts = [...systemParsed.blocks.map((block) => hostFromBlock(block, "system", displayConfigPath)), ...managedParsed.blocks.map((block) => hostFromBlock(block, "managed", displayManagedPath))];
    const seen = new Set<string>();
    const unique = hosts.filter((host) => { if (seen.has(host.id)) return false; seen.add(host.id); return true; });
    const diagnostics = [...systemParsed.diagnostics, ...managedParsed.diagnostics];
    for (const host of unique) {
      const resolved = await exec("ssh", ["-G", host.alias]);
      if (!resolved.ok) diagnostics.push({ code: "ssh.resolve-failed", severity: "warning", message: `无法解析 SSH 主机 ${host.alias}`, path: host.configPath, hostAlias: host.alias });
    }
    return { hosts: unique, diagnostics };
  }

  async function upsertManagedHost(value: ManagedSshHostInput) {
    const input = validateSshHostInput(value);
    await ensureSshDirectory();
    await ensureInclude();
    const raw = await readOrEmpty(managedPath);
    const next = replaceBlock(raw, input.alias, managedBlock(input));
    await atomicWrite(managedPath, next);
    const result = await listHosts();
    const host = result.hosts.find((item) => item.id === `managed:${input.alias}`);
    if (!host) throw new Error("AFK SSH 主机写入后无法重新读取");
    return host;
  }

  async function removeManagedHost(id: string) {
    if (!id.startsWith("managed:")) throw new Error("只能删除 AFK 管理的 SSH 主机");
    const alias = id.slice("managed:".length);
    if (!isConcreteAlias(alias)) throw new Error("SSH 主机 ID 无效");
    const raw = await readOrEmpty(managedPath);
    await atomicWrite(managedPath, replaceBlock(raw, alias, null));
    return true;
  }

  return { listHosts, upsertManagedHost, removeManagedHost, ensureInclude };
}
