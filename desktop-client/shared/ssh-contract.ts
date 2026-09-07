export type SshHostSource = "system" | "managed";

export type SshExternalTerminalId = "iterm2" | "warp" | "ghostty" | "cmux" | "terminal";

export type SshJumpHostType = "none" | "openssh" | "jumpserver";

export type SshConnectionTarget = {
  hostname: string;
  port: number;
  user?: string;
  identityFile?: string;
  proxyJump?: string;
};

export function sshConnectionArgs(target: SshConnectionTarget) {
  const args: string[] = ["-p", String(target.port)];
  if (target.user) args.push("-l", target.user);
  if (target.identityFile) args.push("-i", target.identityFile);
  if (target.proxyJump) args.push("-J", target.proxyJump);
  args.push("--", target.hostname);
  return args;
}

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
  jumpHostType?: SshJumpHostType;
  jumpHost?: string;
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
  jumpHostType?: SshJumpHostType;
  jumpHost?: string;
  remoteWorkspace?: string;
};

export type ManagedSshHostRecord = ManagedSshHostInput & {
  id: string;
};

export type SshHostUpdateRequest = {
  hostId: string;
  input: ManagedSshHostInput;
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
