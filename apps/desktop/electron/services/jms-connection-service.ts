import { existsSync } from "node:fs";
import type { SshBastion, SshHost, SshListResult, SshTestResult } from "../../shared/ssh-contract.js";
import { JUMPSERVER_BINARY_ERROR } from "../adapters/jumpserver-cli.js";

export type JmsTarget = {
  server: string;
  asset: string;
  /** The `<asset>@<server>` pair every jms subcommand accepts. */
  target: string;
};

export type JmsAsset = {
  name: string;
  address: string;
  platform: string;
};

type JmsCli = {
  listServers: () => Promise<Array<{ alias: string; host: string; username: string; isDefault: boolean }>>;
  listAssets: (serverAlias: string, opts?: { linuxOnly?: boolean }) => Promise<JmsAsset[]>;
  execCommand: (target: string, command: string) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  uploadFile: (localPath: string, target: string, remoteDirectory: string) => Promise<{ ok: boolean; stderr: string }>;
  resolveBinaryPath: () => Promise<string>;
};

export type JmsConnectionServiceOptions = {
  cli: JmsCli;
  listHosts: () => Promise<SshListResult>;
  listBastions?: () => Promise<SshBastion[]>;
  binaryCandidates?: string[];
  assetCacheTtlMs?: number;
  now?: () => number;
};

export const DEFAULT_JMS_BINARY_CANDIDATES = ["/opt/homebrew/bin/jms", "/usr/local/bin/jms", "/usr/bin/jms"];

function stripPort(authority: string) {
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    return end === -1 ? authority : authority.slice(0, end + 1);
  }
  const colon = authority.lastIndexOf(":");
  return colon === -1 ? authority : authority.slice(0, colon);
}

/**
 * Reduces anything jms or AFK stores as a server address — `https://host`,
 * `host:2222`, `user@host` — to a comparable hostname. JumpServer records the
 * web URL while AFK stores the SSH endpoint, so the comparison has to ignore
 * scheme, user info, port and path.
 */
export function normalizeJmsHost(value: string) {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "";
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const authority = withoutScheme.split("/")[0];
  const withoutUser = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority;
  return stripPort(withoutUser);
}

export function classifyJmsFailure(stderr: string): SshTestResult["code"] {
  const text = stderr.toLowerCase();
  if (/permission denied|authentication|authenticate|login failed|password|认证失败|登录失败|密码/.test(text)) return "auth-required";
  if (/not found|unknown|no such asset|不存在|未找到资产/.test(text)) return "invalid";
  return "unreachable";
}

export function createJmsConnectionService(deps: JmsConnectionServiceOptions) {
  const now = deps.now ?? Date.now;
  const assetCacheTtlMs = deps.assetCacheTtlMs ?? 60_000;
  const assetCache = new Map<string, { expiresAt: number; assets: JmsAsset[] }>();

  async function bastionHostname(alias: string | undefined) {
    if (!alias) return undefined;
    const { hosts } = await deps.listHosts();
    return hosts.find((host) => host.alias === alias)?.hostname;
  }

  async function resolveServer(host: SshHost): Promise<string> {
    if (host.jumpHostType !== "jumpserver") throw new Error("该主机不是 JumpServer 资产");
    if (!host.jumpHost) throw new Error("JumpServer 跳板机未配置");
    const servers = await deps.cli.listServers();
    if (servers.length === 0) throw new Error("未配置 jms 服务器；请先在 AFK 中添加 JumpServer 堡垒机");

    const bastions = (await deps.listBastions?.()) ?? [];
    const bastion = bastions.find((item) => item.alias === host.jumpHost);
    for (const candidate of [bastion?.jmsServerAlias, host.jumpHost]) {
      if (!candidate) continue;
      const match = servers.find((server) => server.alias === candidate);
      if (match) return match.alias;
    }

    const hostname = bastion?.hostname ?? await bastionHostname(host.jumpHost);
    if (hostname) {
      const wanted = normalizeJmsHost(hostname);
      const match = servers.find((server) => normalizeJmsHost(server.host) === wanted);
      if (match) return match.alias;
    }

    // A single configured JumpServer can only be the one the host refers to.
    if (servers.length === 1) return servers[0].alias;
    throw new Error(`未找到跳板机 ${host.jumpHost} 对应的 jms 服务器配置`);
  }

  async function assetsFor(server: string): Promise<JmsAsset[]> {
    const cached = assetCache.get(server);
    if (cached && cached.expiresAt > now()) return cached.assets;
    const assets = await deps.cli.listAssets(server, { linuxOnly: false });
    if (assets.length === 0) throw new Error(`无法读取 JumpServer ${server} 的资产列表`);
    assetCache.set(server, { expiresAt: now() + assetCacheTtlMs, assets });
    return assets;
  }

  /** Maps an AFK host onto the asset name JumpServer knows it by. */
  async function resolve(host: SshHost): Promise<JmsTarget> {
    const server = await resolveServer(host);
    const assets = await assetsFor(server);
    const asset = assets.find((item) => item.name === host.alias) ?? assets.find((item) => item.address === host.hostname);
    if (!asset) throw new Error(`JumpServer ${server} 上未找到资产 ${host.alias}（${host.hostname}）`);
    return { server, asset: asset.name, target: `${asset.name}@${server}` };
  }

  async function binaryPath(): Promise<string> {
    const resolved = await deps.cli.resolveBinaryPath().catch(() => "");
    if (resolved && existsSync(resolved)) return resolved;
    const fallback = (deps.binaryCandidates ?? DEFAULT_JMS_BINARY_CANDIDATES).find((candidate) => existsSync(candidate));
    if (fallback) return fallback;
    throw new Error(JUMPSERVER_BINARY_ERROR);
  }

  async function session(target: string) {
    return { binary: await binaryPath(), args: ["login", target] };
  }

  async function test(target: string) {
    const result = await deps.cli.execCommand(target, "true");
    if (result.ok) return { ok: true as const, code: "ready" as const };
    return { ok: false as const, code: classifyJmsFailure(result.stderr) };
  }

  async function upload(localPath: string, target: string, remoteDirectory: string) {
    const result = await deps.cli.uploadFile(localPath, target, remoteDirectory);
    if (!result.ok) throw new Error(result.stderr.trim() || "JumpServer SFTP 上传失败");
  }

  return {
    resolve,
    test,
    session,
    upload,
    binaryPath,
    clearAssetCache() {
      assetCache.clear();
    },
  };
}

export type JmsConnectionService = ReturnType<typeof createJmsConnectionService>;
