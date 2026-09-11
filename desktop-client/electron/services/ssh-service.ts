import { homedir } from "node:os";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ManagedSshHostInput, SshConnectionTarget, SshExternalTerminalId, SshFingerprint, SshHost, SshListResult, SshSession, SshTestResult, SshTrustRequest } from "../../shared/ssh-contract";
import type { ExternalTerminalName } from "../adapters/external-terminal-adapter";
import { assertAllowedSshPath, validateSshHostId, validateSshHostInput, validateSshResize, validateSshSessionId, validateSshUploadLocalPath, validateSshUploadRemoteDirectory } from "../security/ssh-validation";
import type { SshCredentialTarget } from "./ssh-credential-service";

type ServiceDependencies = {
  config: {
    listHosts: () => Promise<SshListResult>;
    upsertManagedHost: (input: ManagedSshHostInput) => Promise<SshHost>;
    updateManagedHost: (hostId: string, input: ManagedSshHostInput) => Promise<SshHost>;
    removeManagedHost: (id: string) => Promise<boolean>;
    removeSystemHost: (id: string) => Promise<boolean>;
  };
  commands: {
    resolve: (alias: string) => Promise<{ hostname?: string; port?: number; user?: string; identityFile?: string; proxyJump?: string }>;
    scanFingerprint: (target: { hostname: string; port: number }) => Promise<SshFingerprint>;
    testBatch: (target: SshConnectionTarget | string) => Promise<{ ok: boolean; code: SshTestResult["code"] }>;
    loadIdentity: (identityFile: string) => Promise<boolean>;
    keygenArgs: (identityFile: string) => string[];
    deployArgs: (target: SshConnectionTarget | string, publicKeyPath: string) => string[];
    upload: (localPath: string, target: SshConnectionTarget | string, remoteDirectory: string) => Promise<boolean>;
  };
  knownHosts: {
    isTrusted: (target: { hostname: string; port: number }, fingerprint: SshFingerprint) => Promise<boolean>;
    trustStatus?: (target: { hostname: string; port: number }, fingerprint: SshFingerprint) => Promise<"trusted" | "untrusted" | "identity-changed">;
    trust: (fingerprint: SshFingerprint) => Promise<SshFingerprint>;
    remove: (target: { hostname: string; port: number }) => Promise<boolean>;
  };
  credentialService?: {
    has: (hostId: string, target: SshCredentialTarget) => Promise<boolean>;
    get: (hostId: string, target: SshCredentialTarget) => Promise<string | undefined>;
    set: (hostId: string, password: string, target: SshCredentialTarget) => Promise<boolean>;
    remove: (hostId: string) => Promise<boolean>;
  };
    pty: {
    connect: (hostId: string, target: SshConnectionTarget | string, displayAlias?: string) => SshSession;
    generateKey: (identityFile: string) => SshSession;
    deployKey: (hostId: string, target: SshConnectionTarget | string, remoteCommand: string, password?: string, displayAlias?: string) => SshSession;
    input: (sessionId: string, data: string) => boolean;
    resize: (sessionId: string, cols: number, rows: number) => boolean;
    close: (sessionId: string) => boolean;
  };
  externalTerminal: {
    open: (target: SshConnectionTarget | string, displayAliasOrTerminal: string | SshExternalTerminalId, terminal?: SshExternalTerminalId) => Promise<ExternalTerminalName>;
  };
  audit?: (event: { operation: string; hostId?: string; resultCode: string; startedAt: string; finishedAt: string }) => void;
  home?: string;
};

type ListHostsOptions = {
  forceRefresh?: boolean;
};

function validateListHostsOptions(options: unknown): ListHostsOptions {
  if (options === undefined) return {};
  if (options === null || typeof options !== "object" || Array.isArray(options)) throw new Error("SSH 列表参数无效");
  const keys = Object.keys(options);
  if (keys.some((key) => key !== "forceRefresh")) throw new Error("SSH 列表参数无效");
  if ("forceRefresh" in options && typeof (options as { forceRefresh?: unknown }).forceRefresh !== "boolean") throw new Error("SSH 列表参数无效");
  return options as ListHostsOptions;
}

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

type ResolvedTarget = {
  hostname: string;
  port: number;
  user?: string;
  identityFile?: string;
  proxyJump?: string;
};

type ListInFlight = {
  forceRefresh: boolean;
  promise: Promise<SshListResult>;
};

const hostStatusTtlMs = 10_000;

function now() { return new Date().toISOString(); }

function audit(deps: ServiceDependencies, operation: string, resultCode: string, hostId: string | undefined, startedAt: string) {
  deps.audit?.({ operation, hostId, resultCode, startedAt, finishedAt: now() });
}

export function createSshService(deps: ServiceDependencies) {
  const home = deps.home || homedir();
  let listInFlight: ListInFlight | undefined;
  let cacheGeneration = 0;
  const resolvedTargetCache = new Map<string, CacheEntry<ResolvedTarget>>();
  const hostStatusCache = new Map<string, CacheEntry<SshHost>>();

  function hostDefinitionCacheKey(host: SshHost) {
    return JSON.stringify([host.id, host.alias, host.hostname, host.port, host.user, host.identityFile, host.proxyJump, host.jumpHostType, host.jumpHost, host.remoteWorkspace]);
  }

  function hostStatusCacheKey(host: SshHost, target: ResolvedTarget) {
    return JSON.stringify([host.id, target.hostname, target.port, target.user, target.identityFile, target.proxyJump]);
  }

  function isDirectManagedHost(host: SshHost) {
    return host.source === "managed" && host.configPath !== "~/.ssh/afk_hosts";
  }

  async function resolveCredentialTarget(host: SshHost): Promise<SshCredentialTarget> {
    const resolved = isDirectManagedHost(host) ? host : await deps.commands.resolve(legacyConnectionAlias(host));
    return {
      hostname: resolved.hostname || host.hostname,
      port: resolved.port ?? host.port,
      ...(resolved.user || host.user ? { user: resolved.user || host.user } : {}),
    };
  }

  async function resolveFingerprintTarget(host: SshHost): Promise<ResolvedTarget> {
    if (isDirectManagedHost(host)) return connectionTarget(host);
    if (host.source === "managed" && host.jumpHostType !== "jumpserver") return { hostname: host.hostname, port: host.port, user: host.user };
    const resolved = await deps.commands.resolve(legacyConnectionAlias(host));
    return { hostname: resolved.hostname || host.hostname, port: resolved.port ?? host.port, user: resolved.user || host.user, identityFile: resolved.identityFile, proxyJump: resolved.proxyJump };
  }

  function connectionTarget(host: SshHost): SshConnectionTarget {
    if (!isDirectManagedHost(host)) throw new Error("该 SSH 主机必须通过 OpenSSH 配置连接");
    const proxyJump = host.jumpHostType === "openssh" || host.jumpHostType === "jumpserver" ? host.jumpHost : host.proxyJump;
    if ((host.jumpHostType === "openssh" || host.jumpHostType === "jumpserver") && !proxyJump) throw new Error("跳板机未配置");
    return { hostname: host.hostname, port: host.port, user: host.user, identityFile: host.identityFile ? assertAllowedSshPath(host.identityFile, home) : undefined, proxyJump };
  }

  function connectionArgument(host: SshHost): SshConnectionTarget | string {
    return isDirectManagedHost(host) ? connectionTarget(host) : legacyConnectionAlias(host);
  }

  function legacyConnectionAlias(host: SshHost) {
    if (host.jumpHostType === "jumpserver") {
      if (!host.jumpHost) throw new Error("JumpServer 跳板机未配置");
      return host.jumpHost;
    }
    return host.alias;
  }

  function invalidateListCache() {
    cacheGeneration += 1;
    listInFlight = undefined;
    resolvedTargetCache.clear();
    hostStatusCache.clear();
  }

  async function findHost(hostId: string) {
    const id = validateSshHostId(hostId);
    const result = await deps.config.listHosts();
    const host = result.hosts.find((item) => item.id === id);
    if (!host) throw new Error("SSH 主机不存在");
    return host;
  }

  async function loadHostStatus(host: SshHost, forceRefresh: boolean, generation: number) {
    const definitionKey = hostDefinitionCacheKey(host);
    let target: ResolvedTarget | undefined;
    let value: SshHost;
    try {
      const argument = connectionArgument(host);
      const cachedTarget = resolvedTargetCache.get(definitionKey);
      if (!forceRefresh && cachedTarget && cachedTarget.expiresAt > Date.now()) target = cachedTarget.value;
      if (!target) {
        if (typeof argument === "string") {
          const resolved = await deps.commands.resolve(argument);
          target = { hostname: resolved.hostname || host.hostname, port: resolved.port || host.port, user: resolved.user, identityFile: resolved.identityFile, proxyJump: resolved.proxyJump };
        } else {
          target = argument;
        }
        if (cacheGeneration === generation) resolvedTargetCache.set(definitionKey, { value: target, expiresAt: Date.now() + hostStatusTtlMs });
      }
      const statusKey = hostStatusCacheKey(host, target);
      const cached = hostStatusCache.get(statusKey);
      if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.value;
      const fingerprint = await deps.commands.scanFingerprint(target);
      const trustStatus = deps.knownHosts.trustStatus ? await deps.knownHosts.trustStatus(target, fingerprint) : (await deps.knownHosts.isTrusted(target, fingerprint) ? "trusted" : "untrusted");
      if (trustStatus === "identity-changed") value = { ...host, hostname: target.hostname, port: target.port, fingerprint, status: "identity-changed" };
      else if (trustStatus !== "trusted") value = { ...host, hostname: target.hostname, port: target.port, fingerprint, status: "untrusted" };
      else {
        const tested = await deps.commands.testBatch(argument);
        value = { ...host, hostname: target.hostname, port: target.port, fingerprint, status: tested.ok ? "ready" : tested.code };
      }
    } catch {
      value = { ...host, status: "unreachable" };
    }
    if (target && cacheGeneration === generation) hostStatusCache.set(hostStatusCacheKey(host, target), { value, expiresAt: Date.now() + hostStatusTtlMs });
    return value;
  }

  async function loadHosts(forceRefresh: boolean, generation: number) {
    const result = await deps.config.listHosts();
    const hosts = await Promise.all(result.hosts.map(async (host) => {
      try {
        return await loadHostStatus(host, forceRefresh, generation);
      } catch {
        return { ...host, status: "unreachable" } as SshHost;
      }
    }));
    return { hosts, diagnostics: result.diagnostics };
  }

  function listHosts(options?: ListHostsOptions) {
    const forceRefresh = validateListHostsOptions(options).forceRefresh === true;
    if (listInFlight && (listInFlight.forceRefresh || !forceRefresh)) return listInFlight.promise;
    if (forceRefresh) {
      cacheGeneration += 1;
      resolvedTargetCache.clear();
      hostStatusCache.clear();
      listInFlight = undefined;
    }
    const generation = cacheGeneration;
    const entry: ListInFlight = { forceRefresh, promise: loadHosts(forceRefresh, generation) };
    listInFlight = entry;
    void entry.promise.then(
      () => {
        if (listInFlight === entry) listInFlight = undefined;
      },
      () => {
        if (listInFlight === entry) listInFlight = undefined;
      },
    );
    return entry.promise;
  }

  async function trustFingerprint(request: SshTrustRequest) {
    const startedAt = now();
    const host = await findHost(request.hostId);
    const target = await resolveFingerprintTarget(host);
    if (target.hostname !== request.fingerprint.hostname || target.port !== request.fingerprint.port) throw new Error("SSH 指纹与主机目标不匹配");
    try {
      const trusted = await deps.knownHosts.trust(request.fingerprint);
      invalidateListCache();
      audit(deps, "trust", "trusted", host.id, startedAt);
      return trusted;
    } catch (error) {
      audit(deps, "trust", "rejected", host.id, startedAt);
      throw error;
    }
  }

  async function testHost(hostId: string): Promise<SshTestResult> {
    const startedAt = now();
    const host = await findHost(hostId);
    const target = await resolveFingerprintTarget(host);
    const fingerprint = await deps.commands.scanFingerprint(target);
    if (!await deps.knownHosts.isTrusted(target, fingerprint)) {
      audit(deps, "test", "untrusted", host.id, startedAt);
      throw new Error("SSH 主机尚未信任，已阻止连接测试");
    }
    const result = await deps.commands.testBatch(connectionArgument(host));
    const tested: SshTestResult = { ok: result.ok, code: result.code, checkedAt: now() };
    audit(deps, "test", result.code, host.id, startedAt);
    return tested;
  }

  async function addHost(value: ManagedSshHostInput) {
    const input = validateSshHostInput(value);
    const saved = await deps.config.upsertManagedHost(input);
    invalidateListCache();
    return saved;
  }

  async function updateHost(hostId: string, value: ManagedSshHostInput) {
    const id = validateSshHostId(hostId);
    const input = validateSshHostInput(value);
    const host = await findHost(id);
    if (host.source !== "managed") throw new Error("只能编辑 AFK 管理的 SSH 主机");
    const saved = await deps.config.updateManagedHost(host.id, input);
    invalidateListCache();
    return saved;
  }

  async function removeHost(hostId: string) {
    const host = await findHost(hostId);
    if (host.source === "managed") {
      await deps.credentialService?.remove(host.id);
      const removed = await deps.config.removeManagedHost(host.id);
      if (removed) {
        invalidateListCache();
      }
      return removed;
    }
    const current = (await listHosts({ forceRefresh: true })).hosts.find((item) => item.id === host.id);
    if (current?.status !== "unreachable") throw new Error("只能清理不可达的系统 SSH 主机");
    const removed = await deps.config.removeSystemHost(host.id);
    if (removed) {
      invalidateListCache();
    }
    return removed;
  }

  async function generateKey() {
    const identityFile = path.join(home, ".ssh", "id_ed25519_afk");
    const publicKeyPath = `${identityFile}.pub`;
    if (await fs.access(identityFile).then(() => true).catch(() => false)) throw new Error("AFK SSH 密钥已存在；如需替换请先在系统终端明确处理旧密钥");
    return { publicKeyPath, session: deps.pty.generateKey(identityFile) };
  }

  async function deployKey(hostId: string) {
    const startedAt = now();
    const host = await findHost(hostId);
    if (host.jumpHostType === "jumpserver") throw new Error("JumpServer 资产不支持通过 AFK 自动部署公钥，请在目标终端内操作");
    const target = await resolveCredentialTarget(host);
    const fingerprint = await deps.commands.scanFingerprint(target);
    if (!await deps.knownHosts.isTrusted(target, fingerprint)) {
      audit(deps, "deploy-key", "untrusted", host.id, startedAt);
      throw new Error("SSH 主机尚未信任，已阻止公钥部署");
    }
    const configuredIdentity = host.identityFile || path.join(home, ".ssh", "id_ed25519_afk");
    const identityFile = assertAllowedSshPath(configuredIdentity, home);
    const publicKey = await fs.readFile(`${identityFile}.pub`, "utf8").catch(() => "");
    if (!publicKey.trim()) throw new Error("SSH 公钥不存在，请先生成或配置 IdentityFile");
    const encoded = Buffer.from(publicKey.trim(), "utf8").toString("base64");
    const remoteCommand = `umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; key=$(printf '%s' ${encoded} | (base64 -d 2>/dev/null || base64 -D)); grep -qxF "$key" ~/.ssh/authorized_keys || printf '%s\\n' "$key" >> ~/.ssh/authorized_keys; chmod 700 ~/.ssh; chmod 600 ~/.ssh/authorized_keys`;
    let password = await deps.credentialService?.get(host.id, target);
    try {
      const session = deps.pty.deployKey(host.id, connectionArgument(host), remoteCommand, password, host.alias);
      audit(deps, "deploy-key", "started", host.id, startedAt);
      return session;
    } finally {
      password = undefined;
    }
  }

  async function uploadFile(hostId: string, localPath: string) {
    const startedAt = now();
    const host = await findHost(hostId);
    const selectedPath = validateSshUploadLocalPath(localPath);
    const remoteDirectory = validateSshUploadRemoteDirectory(host.remoteWorkspace?.trim() || "~/");
    const stat = await fs.stat(selectedPath).catch(() => undefined);
    if (!stat?.isFile()) throw new Error("SSH 上传文件不存在或不是普通文件");
    const target = await resolveFingerprintTarget(host);
    const fingerprint = await deps.commands.scanFingerprint(target);
    if (!await deps.knownHosts.isTrusted(target, fingerprint)) {
      audit(deps, "upload", "untrusted", host.id, startedAt);
      throw new Error("SSH 主机尚未信任，已阻止文件上传");
    }
    try {
      await deps.commands.upload(selectedPath, connectionArgument(host), remoteDirectory);
      audit(deps, "upload", "uploaded", host.id, startedAt);
      return { fileName: path.basename(selectedPath), remoteDirectory };
    } catch (error) {
      audit(deps, "upload", "failed", host.id, startedAt);
      throw error;
    }
  }

  async function hasCredential(hostId: string) {
    const host = await findHost(hostId);
    if (!deps.credentialService) return false;
    return deps.credentialService.has(host.id, await resolveCredentialTarget(host));
  }

  async function setCredential(hostId: string, password: string) {
    const host = await findHost(hostId);
    if (!deps.credentialService) throw new Error("SSH 凭据安全存储不可用");
    return deps.credentialService.set(host.id, password, await resolveCredentialTarget(host));
  }

  async function removeCredential(hostId: string) {
    const id = validateSshHostId(hostId);
    if (!deps.credentialService) return false;
    return deps.credentialService.remove(id);
  }

  async function connect(hostId: string) {
    const host = await findHost(hostId);
    const target = await resolveFingerprintTarget(host);
    const fingerprint = await deps.commands.scanFingerprint(target);
    if (!await deps.knownHosts.isTrusted(target, fingerprint)) throw new Error("SSH 主机尚未信任，已阻止连接");
    return deps.pty.connect(host.id, connectionArgument(host), host.alias);
  }

  async function openExternal(hostId: string, terminalId: SshExternalTerminalId = "iterm2") {
    const startedAt = now();
    const host = await findHost(hostId);
    const argument = connectionArgument(host);
    const resolvedTarget = host.source === "managed" && !isDirectManagedHost(host)
      ? await deps.commands.resolve(String(argument))
      : await resolveFingerprintTarget(host);
    const target: ResolvedTarget = { hostname: resolvedTarget.hostname || host.hostname, port: resolvedTarget.port || host.port, user: resolvedTarget.user, identityFile: resolvedTarget.identityFile, proxyJump: resolvedTarget.proxyJump };
    const fingerprint = await deps.commands.scanFingerprint(target);
    if (!await deps.knownHosts.isTrusted(target, fingerprint)) {
      audit(deps, "open-external", "untrusted", host.id, startedAt);
      throw new Error("SSH 主机尚未信任，已阻止外部终端启动");
    }
    try {
      const terminal = typeof argument === "string"
        ? await deps.externalTerminal.open(argument, terminalId)
        : await deps.externalTerminal.open(argument, host.alias, terminalId);
      audit(deps, "open-external", terminal, host.id, startedAt);
      return { terminal: terminalId };
    } catch (error) {
      audit(deps, "open-external", "failed", host.id, startedAt);
      throw error;
    }
  }

  function input(sessionId: string, data: string) {
    return deps.pty.input(validateSshSessionId(sessionId), data);
  }

  function resize(sessionId: string, cols: number, rows: number) {
    const size = validateSshResize(cols, rows);
    return deps.pty.resize(validateSshSessionId(sessionId), size.cols, size.rows);
  }

  function close(sessionId: string) {
    return deps.pty.close(validateSshSessionId(sessionId));
  }

  return {
    listHosts,
    addHost,
    updateHost,
    removeHost,
    trustFingerprint,
    testHost,
    generateKey,
    deployKey,
    uploadFile,
    hasCredential,
    setCredential,
    removeCredential,
    connect,
    openExternal,
    input,
    resize,
    close,
    sshDirectory: path.join(home, ".ssh"),
  };
}
