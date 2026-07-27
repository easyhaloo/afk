import { spawnSync } from 'child_process';
import { promises as fs, existsSync, accessSync, constants } from 'fs';
import { join } from 'path';
import { load } from 'js-yaml';
import { PORTS } from './constants';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ServiceDef {
  name: string;
  displayName: string;
  basePort: number;
  forkContainerPrefix: string;
  image: string;
  healthTimeoutSeconds: number;
  secretsRequired: string[];
  detectFiles: string[];
  detectPatterns: string[];
}

export interface ForkOptions {
  forkName: string;
  services?: string[];
}

// ─── Env helpers ─────────────────────────────────────────────────────────────

const DEFAULTS = {
  FORK_TTL_SECONDS: 28800,
  FORK_DEFAULT_PORT_BASE: 100,
  MINIO_BASE_PORT: PORTS.MINIO_BASE,
  MINIO_CONSOLE_PORT: PORTS.MINIO_CONSOLE,
};

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? parseInt(v, 10) || fallback : fallback;
}

const FORK_ROOT = (): string => {
  const r = process.env.AFK_FORK_STACK_DIR ?? '';
  if (!r) throw new Error('AFK_FORK_STACK_DIR is not set');
  return r;
};

// ─── Docker exec (shell: false for safety) ──────────────────────────────────

function dc(args: string[], cwd?: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('docker', args, {
    encoding: 'utf-8',
    shell: false,
    cwd,
  });
  return { status: r.status, stdout: r.stdout as string, stderr: r.stderr as string };
}

// ─── Port Registry — atomic write-rename (no TOCTOU race) ──────────────────

const REGISTRY = () => join(FORK_ROOT(), '.fork-port-registry');
const LOCK_DIR = () => join(FORK_ROOT(), '.fork-port-registry.lock');

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  // mkdir is atomic on POSIX; spin until we acquire
  while (true) {
    try {
      await fs.mkdir(LOCK_DIR(), { recursive: false });
      break;
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
      await new Promise(r => setTimeout(r, 200));
    }
  }
  try {
    return await fn();
  } finally {
    try { await fs.rmdir(LOCK_DIR()); } catch { /* */ }
  }
}

async function getOffset(forkName: string): Promise<number> {
  const file = REGISTRY();
  return withLock(async () => {
    let content = '';
    try { content = await fs.readFile(file, 'utf-8'); } catch { /* */ }
    const lines = content.split('\n').filter(Boolean);

    // Return cached offset if already assigned
    for (const line of lines) {
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      if (line.slice(0, eq) === forkName) return parseInt(line.slice(eq + 1), 10);
    }

    // Assign new offset: max_assigned + PORT_BASE
    let max = 0;
    for (const line of lines) {
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const v = parseInt(line.slice(eq + 1), 10);
      if (v > max) max = v;
    }
    const next = max + envInt('FORK_DEFAULT_PORT_BASE', DEFAULTS.FORK_DEFAULT_PORT_BASE);

    // Atomic write: temp file + rename
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, content + `${forkName}=${next}\n`, 'utf-8');
    await fs.rename(tmp, file);

    return next;
  });
}

// ─── Service Registry ─────────────────────────────────────────────────────────

let _cache: { mtime: number; reg: ServiceDef[] } | null = null;

export async function loadServiceRegistry(): Promise<ServiceDef[]> {
  const root = FORK_ROOT();
  const file = join(root, 'compose', 'services.yaml');
  const stat = await fs.stat(file);

  if (_cache && _cache.mtime === stat.mtimeMs) return _cache.reg;

  const raw = load(await fs.readFile(file, 'utf-8')) as any;
  const svcs = raw?.services ?? {};

  const reg: ServiceDef[] = Object.entries(svcs)
    .filter(([, d]: [string, any]) => d?.enabled !== false)
    .map(([name, d]: [string, any]) => ({
      name,
      displayName: d['display_name'] ?? name,
      basePort: parseInt(String(d['base_port'] ?? 0), 10),
      forkContainerPrefix: d['fork_container_prefix'] ?? name,
      image: d['image'] ?? '',
      healthTimeoutSeconds: parseInt(String(d['health_timeout_seconds'] ?? 90), 10),
      secretsRequired: d['secrets_required'] ?? [],
      detectFiles: d?.detect?.files ?? [],
      detectPatterns: d?.detect?.patterns ?? [],
    }));

  _cache = { mtime: stat.mtimeMs, reg };
  return reg;
}

export async function detectServices(repoPath: string): Promise<string[]> {
  const svcs = await loadServiceRegistry();
  const matched: string[] = [];

  for (const svc of svcs) {
    if (!svc.detectFiles.length || !svc.detectPatterns.length) continue;
    let hit = false;
    outer:
    for (const file of svc.detectFiles) {
      const fullPath = join(repoPath, file);
      if (!existsSync(fullPath)) continue;
      const content = (await fs.readFile(fullPath, 'utf-8').catch(() => '')).toLowerCase();
      for (const pat of svc.detectPatterns) {
        if (content.includes(pat.toLowerCase())) { hit = true; break outer; }
      }
    }
    if (hit) matched.push(svc.name);
  }
  return matched;
}

// ─── Docker helpers ─────────────────────────────────────────────────────────

async function waitHealthy(container: string, timeoutSec: number): Promise<boolean> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const { status, stdout } = dc(['inspect', '--format={{.State.Health.Status}}', container]);
    if (status === 0 && stdout.trim() === 'healthy') return true;
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

async function composeDown(projectName: string, envFile: string): Promise<void> {
  const root = FORK_ROOT();
  dc([
    'compose', '--project-name', projectName,
    '--env-file', envFile,
    '-f', join(root, 'compose', 'docker-compose.fork.yml'),
    'down', '-v', '--remove-orphans',
  ], root);
}

// ─── ForkManager ──────────────────────────────────────────────────────────────

export class ForkManager {
  available(): boolean {
    try {
      const root = FORK_ROOT();
      accessSync(join(root, 'compose', 'docker-compose.fork.yml'), constants.R_OK);
      return true;
    } catch { return false; }
  }

  async listContainers(role: 'fork' | 'main' = 'fork'): Promise<string[]> {
    const { status, stdout } = dc([
      'ps', '--format', '{{.Names}}',
      '--filter', `label=middleware-fork.role=${role}`,
    ]);
    if (status !== 0) throw new Error(stdout || 'docker ps failed');
    return stdout.trim().split('\n').filter(Boolean);
  }

  async up(options: ForkOptions): Promise<void> {
    const { forkName, services: requestedSvcs } = options;
    const root = FORK_ROOT();

    const svcs = requestedSvcs?.length
      ? (await loadServiceRegistry()).filter(s => requestedSvcs.includes(s.name))
      : await loadServiceRegistry();

    if (!svcs.length) throw new Error('No services specified and none found in registry');

    const offset = await getOffset(forkName);
    const envFile = await this.writeEnv(forkName, svcs, offset);
    const projectName = `fork-${forkName}`;

    try {
      // Launch containers
      const { status, stderr } = dc([
        'compose', '--project-name', projectName,
        '--env-file', envFile,
        '-f', join(root, 'compose', 'docker-compose.fork.yml'),
        'up', '-d',
        ...svcs.map(s => `${s.name}-fork`),
      ], root);

      if (status !== 0) throw new Error(`docker compose up failed: ${stderr}`);

      // Wait for each service to become healthy; rollback on failure
      for (const svc of svcs) {
        const container = `${svc.forkContainerPrefix}-${forkName}`;
        const ok = await waitHealthy(container, svc.healthTimeoutSeconds);
        if (!ok) {
          // Rollback: destroy containers launched in this run
          await composeDown(projectName, envFile);
          throw new Error(`${svc.name} health check timeout after ${svc.healthTimeoutSeconds}s — fork rolled back`);
        }
      }
    } catch (err) {
      // Clean up local env file on any failure
      try { await fs.rm(join(root, '.forks', forkName), { recursive: true }); } catch { /* */ }
      throw err;
    }
  }

  async discard(forkName: string): Promise<void> {
    const root = FORK_ROOT();
    const envFile = join(root, '.forks', forkName, '.env.local');
    await composeDown(`fork-${forkName}`, envFile);
    try { await fs.rm(join(root, '.forks', forkName), { recursive: true }); } catch { /* */ }
  }

  envFilePath(forkName: string): string {
    return join(FORK_ROOT(), '.forks', forkName, '.env.local');
  }

  private async writeEnv(forkName: string, svcs: ServiceDef[], offset: number): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const ttl = envInt('FORK_TTL_SECONDS', DEFAULTS.FORK_TTL_SECONDS);
    const expiresAt = new Date((now + ttl) * 1000).toISOString().replace('.000Z', 'Z');

    const lines = [
      `FORK_WORKTREE_NAME=${forkName}`,
      `FORK_EXPIRES_AT=${expiresAt}`,
      `FORK_TTL_SECONDS=${ttl}`,
      `FORK_VOLUME_PREFIX=fork_${forkName}`,
      `FORK_NETWORK_NAME=fork-net`,
      `MINIO_API_PORT=${DEFAULTS.MINIO_BASE_PORT + offset}`,
      `MINIO_CONSOLE_PORT=${DEFAULTS.MINIO_CONSOLE_PORT + offset}`,
    ];

    for (const svc of svcs) {
      lines.push(`${svc.name.toUpperCase()}_PORT=${svc.basePort + offset}`);
    }

    const dir = join(FORK_ROOT(), '.forks', forkName);
    await fs.mkdir(dir, { recursive: true });
    const file = join(dir, '.env.local');
    await fs.writeFile(file, lines.join('\n') + '\n', 'utf-8');
    return file;
  }
}
