import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

export type JmsExecResult = { ok: boolean; stdout: string; stderr: string; code?: number | null };

export type JumpserverAssetRow = {
  name: string;
  address: string;
  platform: string;
  rawType: string;
};

export type JumpserverServer = {
  alias: string;
  host: string;
  username: string;
  isDefault: boolean;
};

export type JumpserverCliOptions = {
  exec?: (command: string, args: string[], cwd?: string, input?: string, options?: { timeoutMs?: number; maxBuffer?: number; preserveOutput?: boolean }) => Promise<JmsExecResult>;
  resolveBinary?: () => Promise<string>;
};

export function execute(command: string, args: string[], cwd?: string, input?: string, options: { timeoutMs?: number; maxBuffer?: number; preserveOutput?: boolean } = {}): Promise<JmsExecResult> {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const maxBuffer = options.maxBuffer ?? 2_000_000;
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env: diagnosticEnvironment(cwd), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let exitCode: number | null = null;
    const finish = (ok: boolean, errorText?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout: options.preserveOutput ? stdout : stdout.trim(), stderr: options.preserveOutput ? (errorText ?? stderr) : (errorText ?? stderr).trim(), code: exitCode });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false, stderr || `${command} timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (stdout.length + stderr.length > maxBuffer) {
        child.kill('SIGKILL');
        finish(false, stderr || `${command} output exceeded ${maxBuffer} bytes`);
      }
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stdout.length + stderr.length > maxBuffer) {
        child.kill('SIGKILL');
        finish(false, stderr || `${command} output exceeded ${maxBuffer} bytes`);
      }
    });
    child.on('error', error => finish(false, error.message));
    child.on('close', (code, signal) => {
      exitCode = code;
      finish(code === 0, code === null && signal ? `${command} terminated by signal ${signal}` : undefined);
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

function diagnosticEnvironment(cwd?: string): NodeJS.ProcessEnv {
  const home = homedir();
  const additional = [
    path.join(home, 'Library', 'pnpm'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.cargo', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  const base = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return { ...process.env, PATH: [...new Set([...base, ...additional])].join(path.delimiter), ...(cwd ? { PWD: cwd } : {}) };
}

function parseServerLine(line: string): JumpserverServer | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const isDefault = trimmed.startsWith('*');
  const parts = (isDefault ? trimmed.slice(1).trim() : trimmed).split(/\s+/);
  if (parts.length < 3) return null;
  return { alias: parts[0], host: parts[1], username: parts[2], isDefault };
}

function parseAssetLine(line: string): JumpserverAssetRow | null {
  const trimmed = line.trim();
  if (!trimmed || /^-+$/.test(trimmed) || trimmed.startsWith('Name') || trimmed.startsWith('name') || trimmed.startsWith('[INFO]')) return null;
  const parts = trimmed.split(/\s+/);
  if (parts.length < 4) return null;
  return { name: parts[0], address: parts[1], platform: parts[2], rawType: parts[3] };
}

export function createJumpserverCli(options: JumpserverCliOptions = {}) {
  const execFn = options.exec ?? execute;
  const resolveBinaryFn = options.resolveBinary ?? (() => execFn('which', ['jms']).then(result => (result.ok ? result.stdout.trim() : '')));

  return {
    async listServers(): Promise<JumpserverServer[]> {
      const result = await execFn('jms', ['config', 'list']);
      return result.ok ? result.stdout.split(/\r?\n/).flatMap(line => {
        const server = parseServerLine(line);
        return server ? [server] : [];
      }) : [];
    },

    async addServer(input: { alias: string; host: string; port?: number; username: string; password: string }): Promise<{ ok: boolean; alias: string }> {
      const port = input.port ?? 2222;
      const stdin = [input.host, String(port), input.username, input.password, input.password].join('\n');
      const result = await execFn('jms', ['config', 'add', input.alias], undefined, stdin);
      return { ok: result.ok, alias: input.alias };
    },

    async removeServer(alias: string): Promise<boolean> {
      return (await execFn('jms', ['config', 'remove', alias])).ok;
    },

    async listAssets(serverAlias: string, opts?: { linuxOnly?: boolean }): Promise<JumpserverAssetRow[]> {
      const result = await execFn('jms', ['ls', serverAlias]);
      if (!result.ok) return [];
      return result.stdout.split(/\r?\n/).flatMap(line => {
        const row = parseAssetLine(line);
        return row && (opts?.linuxOnly === false || row.platform.startsWith('Linux')) ? [row] : [];
      });
    },

    async probeAssetReachability(input: { asset: string; serverAlias: string; command?: string }): Promise<boolean> {
      const result = await execFn('jms', ['exec', `${input.asset}@${input.serverAlias}`, input.command ?? 'true']);
      return result.ok && result.stdout === 'true';
    },

    /**
     * Run a command vector on a remote asset. The user `argv` is forwarded to
     * `jms exec` verbatim as structured arguments — never joined into a shell
     * string — so no quoting or interpolation can change its meaning.
     */
    async execAssetCommand(input: { target: string; argv: readonly string[]; timeoutMs?: number }): Promise<JmsExecResult> {
      if (input.argv.length === 0) {
        return { ok: false, stdout: '', stderr: 'asset exec requires at least one argument', code: null };
      }
      const args = ['exec', input.target, ...input.argv.map(argument => String(argument))];
      return execFn('jms', args, undefined, undefined, { preserveOutput: true, ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) });
    },

    /** Copy a local file to a remote asset via the jms file transfer command. */
    async uploadFile(input: { target: string; source: string; destination: string; timeoutMs?: number }): Promise<JmsExecResult> {
      const args = ['file', 'upload', input.target, input.source, input.destination];
      return execFn('jms', args, undefined, undefined, input.timeoutMs === undefined ? undefined : { timeoutMs: input.timeoutMs });
    },

    resolveBinaryPath: resolveBinaryFn,
  };
}

export const JUMPSERVER_BINARY_ERROR = '未检测到 jms CLI，请先运行 brew install jms 或访问 https://github.com/jumpserver/jms 获取安装步骤';
