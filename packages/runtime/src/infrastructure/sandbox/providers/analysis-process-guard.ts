import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';

const analysisGuardSource = String.raw`
  const { spawn, execFileSync } = require('node:child_process');
  if (!process.connected) process.exit(1);
  const [limited, ...command] = process.argv.slice(1);
  let stopping = false;
  const child = spawn('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)(deny process-fork)',
    '/bin/sh', '-c', 'IFS= read -r permit <&3 && [ "$permit" = start ] && { [ "$1" = 0 ] || ulimit -f 128; } && shift && exec "$@"',
    'analysis', limited, ...command],
    { stdio: ['inherit', 'inherit', 'inherit', 'pipe'] });
  const identity = () => {
    const output = execFileSync('ps', ['-o', 'pid=,ppid=,lstart=', '-p', String(child.pid)], { encoding: 'utf8', timeout: 750 });
    const match = output.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return match && Number(match[1]) === child.pid && Number(match[2]) === process.pid ? match[3] : undefined;
  };
  let start;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    child.stdio[3].destroy();
    if (child.exitCode === null && child.signalCode === null) {
      try { if (start && identity() === start) child.kill('SIGKILL'); } catch {}
    }
    setTimeout(() => process.exit(1), 1000).unref();
  };
  child.stdio[3].on('error', stop);
  process.on('disconnect', stop);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('error', () => { stop(); process.exit(1); });
  child.on('exit', code => process.exit(stopping && code === 0 ? 1 : code ?? 1));
  try { start = identity(); } catch {}
  if (!start) stop();
  if (!process.connected) stop();
  if (!stopping) child.stdio[3].end('start\n');
`;

export function assertAnalysisGuardAvailable() {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) throw new Error('analysis_unsupported');
}

export function spawnGuardedAnalysis(argv: string[], options: SpawnOptions, helpOutput?: number) {
  assertAnalysisGuardAvailable();
  const env = { ...(options.env ?? process.env) };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  return spawn(process.execPath, ['--input-type=commonjs', '-e', analysisGuardSource, helpOutput === undefined ? '0' : '1', ...argv],
    { ...options, env, stdio: ['pipe', helpOutput ?? 'pipe', 'pipe', 'ipc'] });
}
