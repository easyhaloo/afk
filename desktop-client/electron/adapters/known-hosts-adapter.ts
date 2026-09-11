import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { SshFingerprint } from "../../shared/ssh-contract";

type KnownHostsOptions = {
  home: string;
  scan: (target: { hostname: string; port: number }) => Promise<string>;
  fingerprint: (target: { hostname: string; port: number }) => Promise<SshFingerprint>;
};

function sameFingerprint(left: SshFingerprint, right: SshFingerprint) {
  return left.hostname === right.hostname && left.port === right.port && left.algorithm === right.algorithm && left.value === right.value;
}

export function createKnownHostsAdapter({ home, scan, fingerprint }: KnownHostsOptions) {
  const sshDirectory = path.join(home, ".ssh");
  const file = path.join(sshDirectory, "known_hosts");
  return {
    async trustStatus(target: { hostname: string; port: number }, candidate: SshFingerprint) {
      const raw = await fs.readFile(file, "utf8").catch(() => "");
      const hostTokens = target.port === 22 ? [target.hostname, `[${target.hostname}]:${target.port}`] : [`[${target.hostname}]:${target.port}`];
      let found = false;
      const trusted = raw.split(/\r?\n/).some((line) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3 || !hostTokens.includes(parts[0])) return false;
        found = true;
        const algorithm = parts[1].replace(/^ssh-/, "").replace(/^ecdsa-/, "").toUpperCase();
        const value = `SHA256:${createHash("sha256").update(Buffer.from(parts[2], "base64")).digest("base64").replace(/=+$/, "")}`;
        return algorithm === candidate.algorithm && value === candidate.value;
      });
      return trusted ? "trusted" as const : found ? "identity-changed" as const : "untrusted" as const;
    },
    async isTrusted(target: { hostname: string; port: number }, candidate: SshFingerprint) {
      return (await this.trustStatus(target, candidate)) === "trusted";
    },
    async trust(candidate: SshFingerprint) {
      await fs.mkdir(sshDirectory, { recursive: true, mode: 0o700 });
      const firstScan = await scan(candidate);
      if (!firstScan.trim()) throw new Error("SSH 主机未返回可信任的公钥");
      const secondScan = await scan(candidate);
      const current = await fingerprint(candidate);
      if (!sameFingerprint(candidate, current)) throw new Error("SSH 主机指纹在确认期间发生变化");
      const existing = await fs.readFile(file, "utf8").catch(() => "");
      if (!existing.split(/\r?\n/).includes(secondScan.trim())) await fs.appendFile(file, `${secondScan.trimEnd()}\n`, { mode: 0o600 });
      await fs.chmod(file, 0o600);
      return current;
    },
    async remove(target: { hostname: string; port: number }) {
      const raw = await fs.readFile(file, "utf8").catch(() => "");
      const escaped = target.hostname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`^(\\[?${escaped}\\]?)(:${target.port})?\\s`, "i");
      const next = raw.split(/\r?\n/).filter((line) => !pattern.test(line)).join("\n").replace(/\n+$/, "");
      await fs.writeFile(file, next ? `${next}\n` : "", { mode: 0o600 });
      return true;
    },
  };
}
