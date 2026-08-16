import { execFile } from 'node:child_process';
import type { AgentRuntimeSelection, CodexRuntimeSelection } from './types';

export type CodexTransport = 'auto' | 'exec' | 'app-server';
export type CodexAuth = 'auto' | 'chatgpt' | 'api';

export interface CodexConfig {
  transport: CodexTransport;
  auth: CodexAuth;
  provider: string;
  profile?: string;
  appServer: {
    endpoint?: string;
    authTokenEnv?: string;
    startupTimeoutMs: number;
  };
}

export interface CodexRuntimeOverrides {
  transport?: CodexTransport;
  auth?: CodexAuth;
  provider?: string;
  profile?: string;
  endpoint?: string;
  authTokenEnv?: string;
  startupTimeoutMs?: number;
}

export interface CodexHostDiagnostics {
  auth?: Exclude<CodexAuth, 'auto'> | 'unknown';
  provider?: string;
}

export const DEFAULT_CODEX_CONFIG: Readonly<CodexConfig> = {
  transport: 'auto',
  auth: 'auto',
  provider: 'auto',
  appServer: { startupTimeoutMs: 10_000 },
};

export function resolveCodexRuntime(input: {
  cli: CodexRuntimeOverrides;
  config: CodexConfig;
  host?: CodexHostDiagnostics;
}): CodexRuntimeSelection {
  const configuredTransport = input.cli.transport ?? input.config.transport;
  const configuredAuth = input.cli.auth ?? input.config.auth;
  const configuredProvider = input.cli.provider ?? input.config.provider;
  const endpoint = input.cli.endpoint ?? input.config.appServer.endpoint;
  const transport = configuredTransport === 'auto'
    ? (endpoint ? 'app-server' : 'exec')
    : configuredTransport;
  const auth = configuredAuth === 'auto' ? (input.host?.auth ?? 'unknown') : configuredAuth;
  const provider = configuredProvider === 'auto'
    ? (input.host?.provider ?? 'auto')
    : configuredProvider;

  assertTransport(configuredTransport);
  assertAuth(configuredAuth);
  if (!provider.trim()) throw new Error('Codex provider must not be empty');
  if (endpoint) assertEndpoint(endpoint);

  return {
    kind: 'codex',
    transport,
    auth,
    provider,
    ...optional('profile', input.cli.profile ?? input.config.profile),
    ...optional('endpoint', endpoint ?? (transport === 'app-server' ? 'stdio://' : undefined)),
    ...optional('authTokenEnv', input.cli.authTokenEnv ?? input.config.appServer.authTokenEnv),
    startupTimeoutMs: input.cli.startupTimeoutMs ?? input.config.appServer.startupTimeoutMs,
  };
}

export type CodexReadiness =
  | { ready: true; auth: 'chatgpt' | 'api' | 'unknown'; provider: string }
  | {
    ready: false;
    code: 'CLI_NOT_FOUND' | 'AUTH_INVALID' | 'PROVIDER_INVALID' | 'ENDPOINT_UNREACHABLE';
    message: string;
  };

export type CodexDoctorRunner = (
  executable: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export type CodexReadinessProbe = (runtime: CodexRuntimeSelection) => Promise<CodexReadiness>;
export type CodexEndpointProbe = (runtime: CodexRuntimeSelection) => Promise<void>;

export async function prepareAgentRuntime(
  runtime: AgentRuntimeSelection,
  probe: CodexReadinessProbe = probeCodexReadiness,
): Promise<AgentRuntimeSelection> {
  if (runtime.kind !== 'codex') return runtime;
  const readiness = await probe(runtime);
  if (!readiness.ready) throw new Error(readiness.message);
  return Object.freeze({
    ...runtime,
    auth: runtime.auth === 'unknown' ? readiness.auth : runtime.auth,
    provider: runtime.provider === 'auto' ? readiness.provider : runtime.provider,
  });
}

export async function probeCodexReadiness(
  runtime: CodexRuntimeSelection,
  run: CodexDoctorRunner = runCodexDoctor,
  checkEndpoint: CodexEndpointProbe = probeAppServerEndpoint,
): Promise<CodexReadiness> {
  try {
    const { stdout } = await run('codex', ['doctor', '--json']);
    const diagnostics = parseDoctorOutput(stdout);
    if (diagnostics.ready === false) {
      return readinessFailure(diagnostics.code, runtime);
    }
    if (runtime.transport === 'app-server' && runtime.endpoint && runtime.endpoint !== 'stdio://') {
      try {
        await checkEndpoint(runtime);
      } catch {
        return { ready: false, code: 'ENDPOINT_UNREACHABLE', message: 'Codex app-server endpoint is not reachable' };
      }
    }
    return {
      ready: true,
      auth: diagnostics.auth ?? runtime.auth,
      provider: diagnostics.provider ?? runtime.provider,
    };
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return { ready: false, code: 'CLI_NOT_FOUND', message: 'Codex CLI was not found on PATH' };
    }
    return readinessFailure(undefined, runtime);
  }
}

async function probeAppServerEndpoint(runtime: CodexRuntimeSelection): Promise<void> {
  const { createAppServerTransport } = await import('./codex-app-server/transport');
  const transport = await createAppServerTransport(runtime);
  await transport.close();
}

function runCodexDoctor(executable: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseDoctorOutput(stdout: string): {
  ready?: boolean;
  auth?: 'chatgpt' | 'api' | 'unknown';
  provider?: string;
  code?: string;
} {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!isRecord(parsed)) return {};
    return {
      ready: typeof parsed.ready === 'boolean' ? parsed.ready : undefined,
      auth: normalizeAuth(parsed.auth ?? parsed.authMode ?? parsed.storedAuthMode),
      provider: stringValue(parsed.provider ?? parsed.modelProvider ?? parsed.defaultProvider),
      code: stringValue(parsed.code),
    };
  } catch {
    return {};
  }
}

function readinessFailure(code: string | undefined, runtime: CodexRuntimeSelection): CodexReadiness {
  if (code === 'ENDPOINT_UNREACHABLE') {
    return { ready: false, code: 'ENDPOINT_UNREACHABLE', message: 'Codex app-server endpoint is not reachable' };
  }
  if (code === 'PROVIDER_INVALID' || (runtime.auth === 'unknown' && runtime.provider !== 'auto')) {
    return { ready: false, code: 'PROVIDER_INVALID', message: 'Codex model provider is not ready' };
  }
  return { ready: false, code: 'AUTH_INVALID', message: 'Codex authentication is not ready' };
}

function normalizeAuth(value: unknown): 'chatgpt' | 'api' | 'unknown' | undefined {
  if (value === 'chatgpt' || value === 'api' || value === 'unknown') return value;
  if (value === 'api_key') return 'api';
  return undefined;
}

function assertTransport(value: string): asserts value is CodexTransport {
  if (value !== 'auto' && value !== 'exec' && value !== 'app-server') {
    throw new Error(`Invalid Codex transport: ${value}`);
  }
}

function assertAuth(value: string): asserts value is CodexAuth {
  if (value !== 'auto' && value !== 'chatgpt' && value !== 'api') {
    throw new Error(`Invalid Codex auth mode: ${value}`);
  }
}

export function assertCodexEndpoint(endpoint: string): void {
  assertEndpoint(endpoint);
}

function assertEndpoint(endpoint: string): void {
  if (!/^(stdio:\/\/|unix:\/\/|wss?:\/\/)/.test(endpoint)) {
    throw new Error(`Invalid Codex app-server endpoint: ${endpoint}`);
  }
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : { [key]: value } as { [P in K]?: V };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}
