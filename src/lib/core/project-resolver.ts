/**
 * ProjectResolver — maps a project name (e.g. `easyhaloo/faker_agent`) to a
 * local working directory. Used by the ProjectResolverModule to chdir to the
 * target repo before a worktree is created.
 *
 * Two strategies:
 *   - resolve(): look up an existing local clone via the `j` (autojump) tool.
 *     This is the common path; user's previous `cd` history is the index.
 *   - clone(): fallback when resolve fails. Spawns `gh repo clone` into
 *     ~/work/<sanitized-name>. The sanitization prevents path traversal if
 *     the caller passes an unexpected name.
 *
 * Why not just `gh repo view --json`? That returns metadata, not a path. We
 * need a working tree, so we either have one locally or we clone one.
 */
import { spawn } from 'child_process';
import { join } from 'path';

export interface ProjectResolver {
  /** Resolve a project name to a local path. Throws if not found locally. */
  resolve(projectName: string): Promise<string>;
  /** Clone the project locally as a fallback. Returns the new path. */
  clone(projectName: string): Promise<string>;
}

/** Strip anything dangerous from a project name when used as a directory. */
function sanitize(projectName: string): string {
  return projectName.replace(/[\\/]/g, '-').replace(/^\.+/, '');
}

/** Run a command and capture stdout. Rejects on non-zero exit. */
function run(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd: opts.cwd, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
    proc.on('error', reject);
  });
}

/**
 * Default ProjectResolver.
 *
 * resolve() uses `j` (autojump) — the user's per-machine directory index
 * learned from their `cd` history. autojump is defined in the user's
 * ~/.zshrc, so we spawn an interactive zsh (-i) to source it.
 *
 * autojump typically registers both short names (`faker_agent`) and full
 * names (`easyhaloo/faker_agent`) depending on which the user cd'd into,
 * so we try both forms.
 */
export class JumpProjectResolver implements ProjectResolver {
  async resolve(projectName: string): Promise<string> {
    // Try full name first, then the trailing segment. Dedupe: a name with no
    // `/` would otherwise spawn `zsh` twice with identical args.
    const candidates = [...new Set(
      [projectName, projectName.split('/').pop()].filter((v): v is string => !!v),
    )];
    for (const candidate of candidates) {
      try {
        // `j <name>` jumps (and prints the resolved dir); `&& pwd` captures it.
        // Spawning an interactive zsh so the user's ~/.zshrc (which defines j)
        // is sourced. Bare `zsh` would not source rc files.
        const path = await run('zsh', ['-i', '-c', `j ${shellQuote(candidate)} && pwd`]);
        if (path) return path;
      } catch {
        // try next candidate
      }
    }
    throw new Error(`ProjectResolver.resolve: no local path for "${projectName}" (tried ${candidates.join(', ')})`);
  }

  async clone(projectName: string): Promise<string> {
    const target = join(process.env.HOME ?? '/tmp', 'work', sanitize(projectName));
    // `gh repo clone <repo> <dir>` clones INTO <dir> when <dir> doesn't
    // already exist — git semantics. <dir> is our sanitized target.
    await run('gh', ['repo', 'clone', projectName, target]);
    return target;
  }
}

/** Minimal shell quoting for a single argv slot. */
function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}