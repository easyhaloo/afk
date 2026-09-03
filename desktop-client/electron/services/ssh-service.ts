import { homedir } from "node:os";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ManagedSshHostInput, SshFingerprint, SshHost, SshListResult, SshSession, SshTestResult, SshTrustRequest } from "../../shared/ssh-contract";
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
  audit?: (event: { operation: string; hostId?: string; resultCode: string; startedAt: string; finishedAt: string }) => void;
  home?: string;
};

function now() { return new Date().toISOString(); }

function audit(deps: ServiceDependencies, operation: string, resultCode: string, hostId: string | undefined, startedAt: string) {
  deps.audit?.({ operation, hostId, resultCode, startedAt, finishedAt: now() });
}

export function createSshService(deps: ServiceDependencies) {
  const home = deps.home || homedir();

  async function findHost(hostId: string) {
    const id = validateSshHostId(hostId);
    const result = await deps.config.listHosts();
    const host = result.hosts.find((item) => item.id === id);
    if (!host) throw new Error("SSH 主机不存在");
    return host;
  }

  async function listHosts() {
    const result = await deps.config.listHosts();
    const hosts = await Promise.all(result.hosts.map(async (host) => {
      try {
        const resolved = await deps.commands.resolve(host.alias);
        const target = { hostname: resolved.hostname || host.hostname, port: resolved.port || host.port };
        const fingerprint = await deps.commands.scanFingerprint(target);
        const trustStatus = deps.knownHosts.trustStatus ? await deps.knownHosts.trustStatus(target, fingerprint) : (await deps.knownHosts.isTrusted(target, fingerprint) ? "trusted" : "untrusted");
        if (trustStatus === "identity-changed") return { ...host, hostname: target.hostname, port: target.port, fingerprint, status: "identity-changed" } as SshHost;
        if (trustStatus !== "trusted") return { ...host, hostname: target.hostname, port: target.port, fingerprint, status: "untrusted" } as SshHost;
        const tested = await deps.commands.testBatch(host.alias);
        return { ...host, hostname: target.hostname, port: target.port, fingerprint, status: tested.ok ? "ready" : tested.code } as SshHost;
      } catch {
        return { ...host, status: "unreachable" } as SshHost;
      }
    }));
    return { hosts, diagnostics: result.diagnostics };
  }

  async function trustFingerprint(request: SshTrustRequest) {
    const startedAt = now();
    const host = await findHost(request.hostId);
    if (host.hostname !== request.fingerprint.hostname || host.port !== request.fingerprint.port) throw new Error("SSH 指纹与主机目标不匹配");
    try {
      const trusted = await deps.knownHosts.trust(request.fingerprint);
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
    return deps.config.upsertManagedHost(input);
  }

  async function removeHost(hostId: string) {
    const host = await findHost(hostId);
    if (host.source !== "managed") throw new Error("只能删除 AFK 管理的 SSH 主机");
    return deps.config.removeManagedHost(host.id);
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
    input,
    resize,
    close,
    sshDirectory: path.join(home, ".ssh"),
  };
}
