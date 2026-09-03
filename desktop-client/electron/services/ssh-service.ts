import { homedir } from "node:os";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ManagedSshHostInput, SshExternalTerminalId, SshFingerprint, SshHost, SshListResult, SshSession, SshTestResult, SshTrustRequest } from "../../shared/ssh-contract";
import type { ExternalTerminalName } from "../adapters/external-terminal-adapter";
import { assertAllowedSshPath, validateSshHostId, validateSshHostInput, validateSshResize, validateSshSessionId } from "../security/ssh-validation";

type ServiceDependencies = {
  config: {
    listHosts: () => Promise<SshListResult>;
    upsertManagedHost: (input: ManagedSshHostInput) => Promise<SshHost>;
    removeManagedHost: (id: string) => Promise<boolean>;
  };
  commands: {
    resolve: (alias: string) => Promise<{ hostname?: string; port?: number; user?: string; identityFile?: string; proxyJump?: string }>;
    scanFingerprint: (target: { hostname: string; port: number }) => Promise<SshFingerprint>;
    testBatch: (alias: string) => Promise<{ ok: boolean; code: SshTestResult["code"] }>;
    loadIdentity: (identityFile: string) => Promise<boolean>;
    keygenArgs: (identityFile: string) => string[];
    deployArgs: (alias: string, publicKeyPath: string) => string[];
  };
  knownHosts: {
    isTrusted: (target: { hostname: string; port: number }, fingerprint: SshFingerprint) => Promise<boolean>;
    trustStatus?: (target: { hostname: string; port: number }, fingerprint: SshFingerprint) => Promise<"trusted" | "untrusted" | "identity-changed">;
    trust: (fingerprint: SshFingerprint) => Promise<SshFingerprint>;
    remove: (target: { hostname: string; port: number }) => Promise<boolean>;
  };
  pty: {
    connect: (hostId: string, alias: string) => SshSession;
    generateKey: (identityFile: string) => SshSession;
    deployKey: (hostId: string, alias: string, remoteCommand: string) => SshSession;
    input: (sessionId: string, data: string) => boolean;
    resize: (sessionId: string, cols: number, rows: number) => boolean;
    close: (sessionId: string) => boolean;
  };
  externalTerminal: {
    open: (alias: string, terminal: SshExternalTerminalId) => Promise<ExternalTerminalName>;
  };
  audit?: (event: { operation: string; hostId?: string; resultCode: string; startedAt: string; finishedAt: string }) => void;
  home?: string;
};

type ListHostsOptions = {
  forceRefresh?: boolean;
};

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

type ResolvedTarget = {
  hostname: string;
  port: number;
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
    return JSON.stringify([host.id, host.alias, host.hostname, host.port, host.user, host.identityFile, host.proxyJump, host.remoteWorkspace]);
  }

  function hostStatusCacheKey(host: SshHost, target: ResolvedTarget) {
    return JSON.stringify([host.id, target.hostname, target.port]);
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
      const cachedTarget = resolvedTargetCache.get(definitionKey);
      if (!forceRefresh && cachedTarget && cachedTarget.expiresAt > Date.now()) target = cachedTarget.value;
      if (!target) {
        const resolved = await deps.commands.resolve(host.alias);
        target = { hostname: resolved.hostname || host.hostname, port: resolved.port || host.port };
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
        const tested = await deps.commands.testBatch(host.alias);
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

  function listHosts(options: ListHostsOptions = {}) {
    const forceRefresh = options.forceRefresh === true;
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
    if (host.hostname !== request.fingerprint.hostname || host.port !== request.fingerprint.port) throw new Error("SSH 指纹与主机目标不匹配");
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
    const fingerprint = await deps.commands.scanFingerprint({ hostname: host.hostname, port: host.port });
    if (!await deps.knownHosts.isTrusted({ hostname: host.hostname, port: host.port }, fingerprint)) {
      audit(deps, "test", "untrusted", host.id, startedAt);
      throw new Error("SSH 主机尚未信任，已阻止连接测试");
    }
    const result = await deps.commands.testBatch(host.alias);
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

  async function removeHost(hostId: string) {
    const host = await findHost(hostId);
    if (host.source !== "managed") throw new Error("只能删除 AFK 管理的 SSH 主机");
    const removed = await deps.config.removeManagedHost(host.id);
    if (removed) invalidateListCache();
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
    const fingerprint = await deps.commands.scanFingerprint({ hostname: host.hostname, port: host.port });
    if (!await deps.knownHosts.isTrusted({ hostname: host.hostname, port: host.port }, fingerprint)) {
      audit(deps, "deploy-key", "untrusted", host.id, startedAt);
      throw new Error("SSH 主机尚未信任，已阻止公钥部署");
    }
    const configuredIdentity = host.identityFile || path.join(home, ".ssh", "id_ed25519_afk");
    const identityFile = assertAllowedSshPath(configuredIdentity, home);
    const publicKey = await fs.readFile(`${identityFile}.pub`, "utf8").catch(() => "");
    if (!publicKey.trim()) throw new Error("SSH 公钥不存在，请先生成或配置 IdentityFile");
    const encoded = Buffer.from(publicKey.trim(), "utf8").toString("base64");
    const remoteCommand = `umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; key=$(printf '%s' ${encoded} | (base64 -d 2>/dev/null || base64 -D)); grep -qxF "$key" ~/.ssh/authorized_keys || printf '%s\\n' "$key" >> ~/.ssh/authorized_keys; chmod 700 ~/.ssh; chmod 600 ~/.ssh/authorized_keys`;
    const session = deps.pty.deployKey(host.id, host.alias, remoteCommand);
    audit(deps, "deploy-key", "started", host.id, startedAt);
    return session;
  }

  async function connect(hostId: string) {
    const host = await findHost(hostId);
    const fingerprint = await deps.commands.scanFingerprint({ hostname: host.hostname, port: host.port });
    if (!await deps.knownHosts.isTrusted({ hostname: host.hostname, port: host.port }, fingerprint)) throw new Error("SSH 主机尚未信任，已阻止连接");
    return deps.pty.connect(host.id, host.alias);
  }

  async function openExternal(hostId: string, terminalId: SshExternalTerminalId = "iterm2") {
    const startedAt = now();
    const host = await findHost(hostId);
    const resolved = await deps.commands.resolve(host.alias);
    const target = { hostname: resolved.hostname || host.hostname, port: resolved.port || host.port };
    const fingerprint = await deps.commands.scanFingerprint(target);
    if (!await deps.knownHosts.isTrusted(target, fingerprint)) {
      audit(deps, "open-external", "untrusted", host.id, startedAt);
      throw new Error("SSH 主机尚未信任，已阻止外部终端启动");
    }
    try {
      const terminal = await deps.externalTerminal.open(host.alias, terminalId);
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
    removeHost,
    trustFingerprint,
    testHost,
    generateKey,
    deployKey,
    connect,
    openExternal,
    input,
    resize,
    close,
    sshDirectory: path.join(home, ".ssh"),
  };
}
