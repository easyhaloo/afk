import { spawn } from 'child_process';
import { join } from 'path';

export interface ProjectResolver {
  resolve(projectName: string): Promise<string>;
  clone(projectName: string): Promise<string>;
}

function sanitize(projectName: string): string {
  return projectName.replace(/[\\/]/g, '-').replace(/^\.+/, '');
}

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd: opts.cwd, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', data => { stdout += data.toString(); });
    proc.stderr?.on('data', data => { stderr += data.toString(); });
    proc.on('close', code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
    proc.on('error', reject);
  });
}

export class JumpProjectResolver implements ProjectResolver {
  async resolve(projectName: string): Promise<string> {
    const candidates = [projectName, projectName.split('/').pop()].filter((value): value is string => Boolean(value));
    for (const candidate of candidates) {
      try {
        const resolved = await run('zsh', ['-i', '-c', `j ${shellQuote(candidate)} && pwd`]);
        if (resolved) return resolved;
      } catch {
        // Try the next candidate.
      }
    }
    throw new Error(`ProjectResolver.resolve: no local path for "${projectName}" (tried ${candidates.join(', ')})`);
  }

  async clone(projectName: string): Promise<string> {
    const target = join(process.env.HOME ?? '/tmp', 'work', sanitize(projectName));
    await run('gh', ['repo', 'clone', projectName, target]);
    return join(target, projectName.split('/').pop()!);
  }
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
