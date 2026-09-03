export type SshHostSource = "system" | "managed";

export type SshHostStatus =
  | "ready"
  | "untrusted"
  | "key-missing"
  | "unreachable"
  | "auth-required"
  | "identity-changed"
  | "invalid";

export type SshHost = {
  id: string;
  alias: string;
  hostname: string;
  port: number;
  user?: string;
  identityFile?: string;
  proxyJump?: string;
  source: SshHostSource;
  configPath: string;
  status: SshHostStatus;
  remoteWorkspace?: string;
  fingerprint?: SshFingerprint;
  lastTest?: SshTestResult;
  diagnostics?: SshDiagnostic[];
};

export type SshFingerprint = {
  algorithm: string;
  bits?: number;
  value: string;
  hostname: string;
  port: number;
};

export type SshDiagnostic = {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  path?: string;
  hostAlias?: string;
};

export type SshTestResult = {
  ok: boolean;
  code: "ready" | "auth-required" | "unreachable" | "identity-changed" | "invalid";
  checkedAt: string;
};

export type SshSession = {
  id: string;
  hostId: string;
  alias: string;
  kind: "ssh" | "keygen" | "deploy";
  title: string;
  state: "opening" | "open" | "closed" | "failed";
};

export type ManagedSshHostInput = {
  alias: string;
  hostname: string;
  port?: number;
  user?: string;
  identityFile?: string;
  proxyJump?: string;
  remoteWorkspace?: string;
};

export type SshListResult = {
  hosts: SshHost[];
  diagnostics: SshDiagnostic[];
};

export type SshTrustRequest = {
  hostId: string;
  fingerprint: SshFingerprint;
};

export type SshInputRequest = {
  sessionId: string;
  data: string;
};

export type SshResizeRequest = {
  sessionId: string;
  cols: number;
  rows: number;
};

export function sshHostStatusPriority(status: SshHostStatus) {
  return ["invalid", "identity-changed", "untrusted", "key-missing", "auth-required", "unreachable", "ready"].indexOf(status);
}
