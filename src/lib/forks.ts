import { spawnSync } from 'child_process';
import { promises as fs, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { load } from 'js-yaml';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ForkConnectionInfo {
  forkName: string;
  worktreeRoot: string;
  services: ForkServiceInfo[];
}

export interface ForkServiceInfo {
  name: string;
  host: string;
  port: number;
  containerPort: number;
  envVar: string;
}

interface ComposeService {
  ports?: (string | number)[];
  image?: string;
  healthcheck?: {
    test?: string[];
    interval?: string;
    timeout?: string;
    retries?: number;
    start_period?: string;
  };
}

// ─── Port registry (global, atomic) ─────────────────────────────────────────

const REGISTRY_DIR = () => join(homedir(), '.afk', 'port-registry');
const REGISTRY_FILE = () => join(REGISTRY_DIR(), 'registry');
const LOCK_DIR = () => join(REGISTRY_DIR(), 'lock');
const PORT_BASE = 100; // starting offset from original port

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(REGISTRY_DIR(), { recursive: true });
  while (true) {
    try {
      await fs.mkdir(LOCK_DIR());
      break;
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'EEXIST') throw err;
      await new Promise(r => setTimeout(r, 200));
    }
  }
  try {
    return await fn();
  } finally {
    try { await fs.rmdir(LOCK_DIR()); } catch { /* */ }
  }
}

async function assignPortOffset(projectHash: string): Promise<number> {
  return withLock(async () => {
    const file = REGISTRY_FILE();
    let content = '';
    try { content = await fs.readFile(file, 'utf-8'); } catch { /* */ }
    const lines = content.split('\n').filter(Boolean);

    // Return cached offset if already assigned
    for (const line of lines) {
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      if (line.slice(0, eq) === projectHash) return parseInt(line.slice(eq + 1), 10);
    }

    // Assign new offset: max_assigned + PORT_BASE
    let max = 0;
    for (const line of lines) {
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const v = parseInt(line.slice(eq + 1), 10);
      if (v > max) max = v;
    }
    const next = max + PORT_BASE;

    // Atomic write: temp file + rename
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, content + `${projectHash}=${next}\n`, 'utf-8');
    await fs.rename(tmp, file);

    return next;
  });
}

async function releasePortOffset(projectHash: string): Promise<void> {
  return withLock(async () => {
    const file = REGISTRY_FILE();
    let content = '';
    try { content = await fs.readFile(file, 'utf-8'); } catch { return; }
    const lines = content.split('\n').filter(Boolean);
    const filtered = lines.filter(l => !l.startsWith(projectHash + '='));
    if (filtered.length === lines.length) return; // nothing to remove
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, filtered.join('\n') + '\n', 'utf-8');
    await fs.rename(tmp, file);
  });
}

// ─── Docker helpers ──────────────────────────────────────────────────────────

function dc(args: string[], cwd?: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('docker', args, {
    encoding: 'utf-8',
    shell: false,
    cwd,
  });
  return { status: r.status, stdout: r.stdout as string, stderr: r.stderr as string };
}

async function waitHealthy(container: string, timeoutSec: number): Promise<boolean> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const { status, stdout } = dc(['inspect', '--format={{.State.Health.Status}}', container]);
    if (status === 0 && stdout.trim() === 'healthy') return true;
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

// ─── Compose parsing ─────────────────────────────────────────────────────────

interface ParsedService {
  name: string;
  hostPort: number;
  containerPort: number;
  healthTimeout: number;
}

function parseComposePorts(worktreeRoot: string): ParsedService[] {
  const composeFile = join(worktreeRoot, 'docker-compose.yml');
  if (!existsSync(composeFile)) return [];

  const raw = load(readFileSync(composeFile, 'utf-8')) as any;
  if (!raw?.services) return [];

  const services: ParsedService[] = [];

  for (const [name, svc] of Object.entries(raw.services) as [string, ComposeService][]) {
    if (!svc.ports || svc.ports.length === 0) continue;

    for (const portEntry of svc.ports) {
      const portStr = String(portEntry);
      let hostPort: number | null = null;
      let containerPort: number | null = null;

      if (portStr.includes(':')) {
        // "3306:3306" or "127.0.0.1:3306:3306"
        const parts = portStr.split(':');
        const last = parts[parts.length - 1];
        const secondLast = parts[parts.length - 2];
        hostPort = parseInt(secondLast, 10);
        containerPort = parseInt(last, 10);
      } else {
        // "3306" — container port only, random host port
        const parsed = parseInt(portStr, 10);
        if (!isNaN(parsed)) {
          containerPort = parsed;
          hostPort = parsed; // use original as base for offset
        }
      }

      if (hostPort !== null && !isNaN(hostPort) && containerPort !== null && !isNaN(containerPort)) {
        // Extract health timeout from docker-compose healthcheck config
        let healthTimeout = 60;
        if (svc.healthcheck?.start_period) {
          const parsed = parseDuration(svc.healthcheck.start_period);
          if (parsed > 0) healthTimeout = parsed + 15;
        }

        services.push({ name, hostPort, containerPort, healthTimeout });
        break; // Only the first mapped port per service (the primary one)
      }
    }
  }

  return services;
}

function parseDuration(s: string): number {
  // Convert "30s", "5m", "10s" etc to seconds
  const match = s.match(/^(\d+)([smhd])$/);
  if (!match) return 0;
  const val = parseInt(match[1], 10);
  switch (match[2]) {
    case 's': return val;
    case 'm': return val * 60;
    case 'h': return val * 3600;
    case 'd': return val * 86400;
    default: return 0;
  }
}

// ─── ForkManager ─────────────────────────────────────────────────────────────

export class ForkManager {
  private worktreeRoot: string;
  private projectHash: string;
  private offset: number | null = null;
  private services: ParsedService[] = [];

  constructor(worktreeRoot: string) {
    this.worktreeRoot = worktreeRoot;
    // Hash the absolute path to use as registry key
    this.projectHash = `p${hashString(worktreeRoot)}`;
  }

  /**
   * Check if the worktree has a docker-compose.yml — no other config needed.
   */
  available(): boolean {
    return existsSync(join(this.worktreeRoot, 'docker-compose.yml'));
  }

  /**
   * Start fork: parse compose → allocate ports → write .env → up → health check.
   * Returns connection info for the agent to use.
   */
  async up(): Promise<ForkConnectionInfo> {
    if (!this.available()) {
      throw new Error(`No docker-compose.yml found in ${this.worktreeRoot}`);
    }

    this.services = parseComposePorts(this.worktreeRoot);
    if (this.services.length === 0) {
      throw new Error('No services with port mappings found in docker-compose.yml');
    }

    // Assign port offset
    this.offset = await assignPortOffset(this.projectHash);

    // Write .env to worktree root
    await this.writeEnv();

    // docker compose up -d
    const { status, stderr } = dc(['compose', 'up', '-d'], this.worktreeRoot);
    if (status !== 0) {
      throw new Error(`docker compose up failed: ${stderr}`);
    }

    // Health check each service
    for (const svc of this.services) {
      const container = `${svc.name}-fork`;
      const ok = await waitHealthy(container, svc.healthTimeout);
      if (!ok) {
        await this.discard();
        throw new Error(`${svc.name} health check failed after ${svc.healthTimeout}s — fork rolled back`);
      }
    }

    return this.getConnectionInfo();
  }

  /**
   * Destroy fork: docker compose down + release port offset.
   */
  async discard(): Promise<void> {
    const { stderr } = dc(['compose', 'down', '-v', '--remove-orphans'], this.worktreeRoot);
    if (stderr) {
      // Non-fatal: log but don't throw
      console.error('docker compose down warning:', stderr);
    }

    // Remove .env if it was created by us (has FORK_ prefix marker)
    const envFile = join(this.worktreeRoot, '.env');
    if (existsSync(envFile)) {
      try {
        const content = await fs.readFile(envFile, 'utf-8');
        if (content.includes('# AFK fork — do not edit')) {
          await fs.rm(envFile);
        }
      } catch { /* */ }
    }

    await releasePortOffset(this.projectHash);
    this.offset = null;
  }

  /**
   * Return connection info without starting anything.
   */
  getConnectionInfo(): ForkConnectionInfo {
    const services: ForkServiceInfo[] = this.services.map(svc => ({
      name: svc.name,
      host: '127.0.0.1',
      port: svc.hostPort + (this.offset ?? 0),
      containerPort: svc.containerPort,
      envVar: `${svc.name.toUpperCase()}_FORK_PORT=${svc.hostPort + (this.offset ?? 0)}`,
    }));

    return {
      forkName: this.projectHash,
      worktreeRoot: this.worktreeRoot,
      services,
    };
  }

  /**
   * Write .env to worktree root so docker-compose picks it up automatically.
   * The .env contains port overrides that docker-compose substitutes into
   * its port mappings. Format:
   *
   *   # AFK fork — do not edit
   *   MYSQL_PORT=3406
   *   REDIS_PORT=6380
   *
   * docker-compose.yml should reference these via ${MYSQL_PORT:-3306}.
   * If the compose file doesn't use env vars, the original port is used.
   * This is a best-effort: the port offset is still applied via the FORK_*
   * env vars that docker-compose picks up.
   */
  private async writeEnv(): Promise<void> {
    if (this.offset === null) {
      throw new Error('Cannot write env before assigning offset');
    }

    // Build env vars: for each service, write the offset port
    // docker-compose automatically reads .env from the project directory
    const lines: string[] = [
      '# AFK fork — do not edit',
      `# Generated by afk fork (offset: ${this.offset})`,
      '',
    ];

    for (const svc of this.services) {
      const offsetPort = svc.hostPort + this.offset;
      // Write both lowercased (common convention) and UPPERCASED variants
      const name = svc.name.toUpperCase();
      lines.push(`${name}_PORT=${offsetPort}`);
      lines.push(`${name}_FORK_PORT=${offsetPort}`);
      lines.push(`FORK_${name}_PORT=${offsetPort}`);
    }

    // Also write raw docker-compose port overrides
    // docker-compose can use ${VAR} syntax in port mappings
    for (const svc of this.services) {
      const offsetPort = svc.hostPort + this.offset;
      // Map "3306" → "3406" style overrides
      const key = `FORK_PORT_${svc.hostPort}`;
      lines.push(`${key}=${offsetPort}`);
    }

    lines.push('');

    const envFile = join(this.worktreeRoot, '.env');
    // Write atomically: temp file + rename
    const tmp = envFile + '.tmp';
    await fs.writeFile(tmp, lines.join('\n'), 'utf-8');
    try {
      await fs.rename(tmp, envFile);
    } catch {
      // If .env already exists, merge with it
      const existing = await fs.readFile(envFile, 'utf-8');
      const merged = existing.endsWith('\n') ? existing + lines.join('\n') : existing + '\n' + lines.join('\n');
      await fs.writeFile(envFile, merged, 'utf-8');
      try { await fs.rm(tmp); } catch { /* */ }
    }
  }
}

// ─── GC: clean up stale port assignments ─────────────────────────────────────

/**
 * Remove port registry entries for worktrees that no longer exist.
 * Designed to be called periodically (e.g., afk loop poll cycle).
 */
export async function gc(): Promise<number> {
  const dir = REGISTRY_DIR();
  const file = REGISTRY_FILE();
  let content = '';
  try { content = await fs.readFile(file, 'utf-8'); } catch { return 0; }

  const lines = content.split('\n').filter(Boolean);
  let removed = 0;

  const remaining = lines.filter(line => {
    const eq = line.indexOf('=');
    if (eq < 0) return true;
    const hash = line.slice(0, eq);
    // The hash is "p" + hash of the absolute path — we can't reverse it,
    // but we can check if any docker-compose project is still running
    // with this hash in its name
    const { status } = dc(['compose', 'ps', '-q', '--filter', `label=com.docker.compose.project=fork-${hash}`]);
    if (status !== 0) {
      removed++;
      return false;
    }
    return true;
  });

  const tmp = file + '.tmp';
  await fs.writeFile(tmp, remaining.join('\n') + '\n', 'utf-8');
  await fs.rename(tmp, file);

  return removed;
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function hashString(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const char = s.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}