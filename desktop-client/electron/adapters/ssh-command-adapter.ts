import { createHash } from "node:crypto";
import type { SshFingerprint } from "../../shared/ssh-contract";

type ExecResult = { ok: boolean; stdout: string; stderr: string };

type SshCommandAdapterOptions = {
  exec: (command: string, args: string[]) => Promise<ExecResult>;
};

type ResolvedSshConfig = {
  hostname?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  proxyJump?: string;
};

function parseResolved(stdout: string): ResolvedSshConfig {
  const result: ResolvedSshConfig = {};
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^(hostname|user|port|identityfile|proxyjump)\s+(.+)$/i);
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (key === "port") result.port = Number.parseInt(match[2], 10);
    else if (key === "identityfile") result.identityFile ||= match[2];
    else if (key === "hostname") result.hostname ||= match[2];
    else if (key === "user") result.user ||= match[2];
    else if (key === "proxyjump") result.proxyJump ||= match[2];
  }
  return result;
}

function fingerprintFromKeyLine(line: string, hostname: string, port: number): SshFingerprint {
  const match = line.trim().match(/^(\S+)\s+(ssh-[^\s]+|ecdsa-[^\s]+)\s+(\S+)/);
  if (!match) throw new Error("SSH 主机指纹格式无效");
  const keyType = match[2];
  const digest = createHash("sha256").update(Buffer.from(match[3], "base64")).digest("base64").replace(/=+$/, "");
  return {
    algorithm: keyType.replace(/^ssh-/, "").replace(/^ecdsa-/, "").toUpperCase(),
    bits: keyType === "ssh-ed25519" ? 256 : undefined,
    value: `SHA256:${digest}`,
    hostname,
    port,
  };
}

function firstKeyLine(stdout: string) {
  const line = stdout.split(/\r?\n/).map((item) => item.trim()).find((item) => item && !item.startsWith("#"));
  if (!line) throw new Error("SSH 主机未返回可验证的公钥");
  return line;
}

function batchCode(stderr: string) {
  const text = stderr.toLowerCase();
  if (text.includes("host key verification failed") || text.includes("remote host identification has changed")) return "identity-changed" as const;
  if (text.includes("permission denied") || text.includes("too many authentication failures")) return "auth-required" as const;
  if (text.includes("timed out") || text.includes("could not resolve") || text.includes("connection refused") || text.includes("no route")) return "unreachable" as const;
  return "unreachable" as const;
}

export function createSshCommandAdapter({ exec }: SshCommandAdapterOptions) {
  return {
    async resolve(alias: string) {
      const result = await exec("ssh", ["-G", alias]);
      if (!result.ok) throw new Error("SSH 配置解析失败");
      return parseResolved(result.stdout);
    },
    async scanFingerprint(target: { hostname: string; port: number }) {
      const result = await exec("ssh-keyscan", ["-T", "8", "-p", String(target.port), target.hostname]);
      if (!result.ok) throw new Error("SSH 主机指纹扫描失败");
      return fingerprintFromKeyLine(firstKeyLine(result.stdout), target.hostname, target.port);
    },
    async loadIdentity(identityFile: string) {
      const result = await exec("ssh-add", ["--apple-use-keychain", identityFile]);
      if (!result.ok) throw new Error("SSH 密钥无法加载到 ssh-agent");
      return true;
    },
    async testBatch(alias: string) {
      const result = await exec("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", alias, "true"]);
      return result.ok ? { ok: true, code: "ready" as const } : { ok: false, code: batchCode(result.stderr) };
    },
    keygenArgs(identityFile: string) {
      return ["-t", "ed25519", "-f", identityFile, "-C", "afk-managed"];
    },
    deployArgs(alias: string, publicKeyPath: string) {
      return ["-i", publicKeyPath, alias];
    },
  };
}
