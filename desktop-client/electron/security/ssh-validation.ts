import path from "node:path";
import type { ManagedSshHostInput } from "../../shared/ssh-contract";

const ALIAS_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

function requiredString(value: unknown, message: string) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(message);
  return value.trim();
}

export function validateSshHostInput(value: unknown): ManagedSshHostInput {
  if (!value || typeof value !== "object") throw new Error("SSH 主机参数无效");
  const input = value as Record<string, unknown>;
  const alias = requiredString(input.alias, "SSH 主机别名无效");
  if (!ALIAS_PATTERN.test(alias) || alias === "." || alias === "..") throw new Error("SSH 主机别名无效");
  const hostname = requiredString(input.hostname, "SSH 主机地址无效");
  const port = input.port === undefined ? 22 : input.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("SSH 端口无效");
  const optional = (key: string) => input[key] === undefined ? undefined : requiredString(input[key], `SSH ${key} 无效`);
  return {
    alias,
    hostname,
    port,
    user: optional("user"),
    identityFile: optional("identityFile"),
    proxyJump: optional("proxyJump"),
    remoteWorkspace: optional("remoteWorkspace"),
  };
}

export function assertAllowedSshPath(value: string, home: string) {
  const candidate = requiredString(value, "SSH 密钥路径无效");
  const expanded = candidate === "~" || candidate.startsWith("~/") ? path.join(home, candidate.slice(2)) : path.resolve(candidate);
  const sshRoot = path.join(path.resolve(home), ".ssh");
  const relative = path.relative(sshRoot, expanded);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("SSH 密钥路径必须位于用户 SSH 目录");
  return expanded;
}

export function validateSshHostId(value: unknown) {
  const id = requiredString(value, "SSH 主机 ID 无效");
  if (!id.startsWith("system:") && !id.startsWith("managed:")) throw new Error("SSH 主机 ID 无效");
  return id;
}

export function validateSshSessionId(value: unknown) {
  const id = requiredString(value, "SSH 会话 ID 无效");
  if (!/^[A-Za-z0-9-]{8,100}$/.test(id)) throw new Error("SSH 会话 ID 无效");
  return id;
}

export function validateSshResize(cols: unknown, rows: unknown) {
  if (typeof cols !== "number" || !Number.isInteger(cols) || cols < 1 || cols > 500 || typeof rows !== "number" || !Number.isInteger(rows) || rows < 1 || rows > 300) throw new Error("SSH 终端尺寸无效");
  return { cols, rows };
}
