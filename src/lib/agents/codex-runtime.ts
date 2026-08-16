import { execFile } from 'node:child_process';
import type { AgentRuntimeSelection, CodexRuntimeSelection } from './types';
import { AppServerClient } from './codex-app-server/client';
import { createAppServerTransport, type AppServerTransport } from './codex-app-server/transport';

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
  appServer: { startupTimeoutMs: 30_000 },
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
  const profile = input.cli.profile ?? input.config.profile;

  assertTransport(configuredTransport);
  assertAuth(configuredAuth);
  if (!provider.trim()) throw new Error('Codex provider must not be empty');
  if (endpoint) assertEndpoint(endpoint);
  if (transport === 'app-server' && profile) {
    throw new Error('Codex profile is not supported with app-server transport');
  }

  return {
    kind: 'codex',
    transport,
    auth,
    provider,
    ...optional('profile', profile),
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
  options?: { timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string }>;

export type CodexReadinessProbe = (runtime: CodexRuntimeSelection) => Promise<CodexReadiness>;
export type CodexEndpointProbe = (runtime: CodexRuntimeSelection) => Promise<void>;
type AppServerTransportFactory = (
  runtime: CodexRuntimeSelection,
) => AppServerTransport | Promise<AppServerTransport>;

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
  checkEndpoint: CodexEndpointProbe = probeCodexAppServerEndpoint,
): Promise<CodexReadiness> {
  if (runtime.transport === 'app-server') {
    try {
      await checkEndpoint(runtime);
      return { ready: true, auth: runtime.auth, provider: runtime.provider };
    } catch (error) {
      return readinessFailure(readinessErrorCode(error) ?? 'ENDPOINT_UNREACHABLE', runtime);
    }
  }
  try {
    const configOverrides = codexConfigOverrideArgs(runtime);
    const execOverrides = [
      ...(runtime.profile ? ['--profile', runtime.profile] : []),
      ...configOverrides,
    ];
    const commandOptions = { timeoutMs: runtime.startupTimeoutMs };
    const { stdout } = await run('codex', ['doctor', '--json', ...configOverrides], commandOptions);
    const diagnostics = parseDoctorOutput(stdout);
    if (diagnostics.ready === false) {
      return readinessFailure(diagnostics.code, runtime);
    }
    if (runtime.auth !== 'unknown' && diagnostics.auth !== runtime.auth) {
      return readinessFailure('AUTH_INVALID', runtime);
    }
    const probe = await run('codex', [
      'exec', '--json', '--ephemeral', '--skip-git-repo-check',
      '--sandbox', 'read-only', ...execOverrides,
      '-C', process.cwd(),
      'Reply with READY. Do not call tools or modify files.',
    ], commandOptions);
    if (!hasCompletedTurn(probe.stdout)) throw new Error('Codex live model probe did not complete');
    return {
      ready: true,
      auth: diagnostics.auth ?? runtime.auth,
      provider: runtime.profile && runtime.provider === 'auto'
        ? 'auto'
        : diagnostics.provider ?? runtime.provider,
    };
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return { ready: false, code: 'CLI_NOT_FOUND', message: 'Codex CLI was not found on PATH' };
    }
    return readinessFailure(undefined, runtime);
  }
}

export async function probeCodexAppServerEndpoint(
  runtime: CodexRuntimeSelection,
  createTransport: AppServerTransportFactory = createAppServerTransport,
): Promise<void> {
  let transport: AppServerTransport;
  try {
    transport = await createTransport(runtime);
  } catch (error) {
    if ((runtime.endpoint ?? 'stdio://') === 'stdio://' && isErrno(error, 'ENOENT')) {
      throw readinessError('CLI_NOT_FOUND');
    }
    throw readinessError('ENDPOINT_UNREACHABLE');
  }
  const client = new AppServerClient(transport);
  client.start();
  let stage: CodexReadinessFailureCode = 'ENDPOINT_UNREACHABLE';
  let failed = false;
  try {
    await withStartupTimeout((async () => {
      stage = 'ENDPOINT_UNREACHABLE';
      await client.request('initialize', {
        clientInfo: { name: 'afk-readiness', title: 'AFK Readiness', version: '0.1.0' },
      });
      await client.notify('initialized');
      stage = 'PROVIDER_INVALID';
      const started = await client.request<{ thread: { id: string } }>('thread/start', {
        cwd: process.cwd(),
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ...(runtime.provider !== 'auto' ? { modelProvider: runtime.provider } : {}),
      });
      stage = 'AUTH_INVALID';
      await client.request('turn/start', {
        threadId: started.thread.id,
        input: [{
          type: 'text',
          text: 'Reply with READY. Do not call tools or modify files.',
          text_elements: [],
        }],
      });
      for await (const notification of client.notifications()) {
        if (notification.method === 'error') {
          if (record(notification.params).willRetry === true) continue;
          throw new Error('Codex app-server readiness turn failed');
        }
        if (notification.method !== 'turn/completed') continue;
        const params = record(notification.params);
        const turn = record(params.turn);
        if (turn.status !== 'completed') throw new Error('Codex app-server readiness turn failed');
        return;
      }
      throw new Error('Codex app-server closed before readiness completed');
    })(), runtime.startupTimeoutMs);
  } catch (error) {
    failed = true;
    if ((runtime.endpoint ?? 'stdio://') === 'stdio://' && isErrno(error, 'ENOENT')) {
      throw readinessError('CLI_NOT_FOUND');
    }
    throw readinessError(readinessErrorCode(error) ?? stage);
  } finally {
    try {
      await client.close();
    } catch {
      if (!failed) throw readinessError('ENDPOINT_UNREACHABLE');
    }
  }
}

async function withStartupTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(readinessError('ENDPOINT_UNREACHABLE')), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

type CodexReadinessFailureCode = Exclude<CodexReadiness, { ready: true }>['code'];

function readinessError(code: CodexReadinessFailureCode): Error & { code: CodexReadinessFailureCode } {
  return Object.assign(new Error('Codex readiness failed'), { code });
}

function readinessErrorCode(error: unknown): CodexReadinessFailureCode | undefined {
  if (!(error instanceof Error) || !('code' in error)) return undefined;
  const code = (error as Error & { code?: unknown }).code;
  return code === 'CLI_NOT_FOUND' || code === 'AUTH_INVALID'
    || code === 'PROVIDER_INVALID' || code === 'ENDPOINT_UNREACHABLE'
    ? code
    : undefined;
}

function runCodexDoctor(
  executable: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, {
      encoding: 'utf8',
      timeout: options.timeoutMs,
      env: {
        ...process.env,
        ...(process.env.TERM === 'dumb' || !process.env.TERM ? { TERM: 'xterm-256color' } : {}),
      },
    }, (error, stdout, stderr) => {
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
    const checks = isRecord(parsed.checks) ? parsed.checks : undefined;
    if (checks) {
      const auth = check(checks, 'auth.credentials');
      const config = check(checks, 'config.load');
      const installation = check(checks, 'installation');
      const reachability = check(checks, 'network.provider_reachability');
      const relevantFailure = [auth, config, installation, reachability]
        .find(candidate => candidate?.status === 'fail');
      return {
        ready: relevantFailure === undefined,
        auth: normalizeAuth(auth?.details?.['stored auth mode']),
        provider: stringValue(config?.details?.['model provider']),
        code: relevantFailure === auth ? 'AUTH_INVALID' : relevantFailure ? 'PROVIDER_INVALID' : undefined,
      };
    }
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

function codexConfigOverrideArgs(runtime: CodexRuntimeSelection): string[] {
  return [
    ...(runtime.provider !== 'auto'
      ? ['--config', `model_provider=${JSON.stringify(runtime.provider)}`]
      : []),
  ];
}

function hasCompletedTurn(stdout: string): boolean {
  return stdout.split('\n').some(line => {
    try {
      const event = JSON.parse(line) as unknown;
      return isRecord(event) && (
        event.type === 'turn.completed'
        || (event.type === 'result' && event.is_error !== true)
      );
    } catch {
      return false;
    }
  });
}

function check(
  checks: Record<string, unknown>,
  id: string,
): { status?: string; details?: Record<string, unknown> } | undefined {
  const value = checks[id];
  if (!isRecord(value)) return undefined;
  return {
    status: stringValue(value.status),
    details: isRecord(value.details) ? value.details : undefined,
  };
}

function readinessFailure(code: string | undefined, runtime: CodexRuntimeSelection): CodexReadiness {
  if (code === 'ENDPOINT_UNREACHABLE') {
    return { ready: false, code: 'ENDPOINT_UNREACHABLE', message: 'Codex app-server endpoint is not reachable' };
  }
  if (code === 'AUTH_INVALID') {
    return { ready: false, code: 'AUTH_INVALID', message: 'Codex authentication is not ready' };
  }
  if (code === 'PROVIDER_INVALID' || (code === undefined && runtime.auth === 'unknown' && runtime.provider !== 'auto')) {
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
