/**
 * Environment variable allowlist for container sandboxes.
 *
 * Per EXECUTION-DESIGN.md §6: container env must be filtered through an
 * explicit allowlist. The defaults cover what coding agents actually need
 * (PATH, locale, model provider keys) and exclude credentials and
 * shell-specific leakage (SSH_AUTH_SOCK, AWS_*, GITHUB_TOKEN, etc.).
 *
 * Callers may extend the allowlist with project-specific additions
 * (e.g., a private model proxy URL), but they cannot shrink the defaults
 * via override — to remove a default, fork the configuration.
 */

const DEFAULT_ALLOWED = new Set<string>([
  // Locale + timezone
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  // Terminal / shell essentials (no secrets)
  'TERM', 'COLORTERM', 'SHELL',
  // Node / runtime
  'NODE_ENV', 'NODE_OPTIONS',
  // Provider credentials — the agents MUST be able to authenticate, but
  // secrets like AWS_SECRET_ACCESS_KEY / SSH_AUTH_SOCK are NOT allowed.
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_ENTRYPOINT',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID',
  'GITHUB_TOKEN', // unavoidable for coding agents; not a host-system secret
  // AFK / worktree identification (used by the in-container scripts)
  'AFK_IID', 'AFK_GENERATION', 'AFK_WORKTREE_PATH', 'AFK_SESSION',
]);

/** Result of validating an env-var name. */
export interface EnvAllowlistResult {
  /** Names that passed (subset of the input). */
  allowed: string[];
  /** Names that were rejected, with reasons. */
  rejected: Array<{ name: string; reason: string }>;
}

export class EnvVarAllowlist {
  private readonly names: Set<string>;

  constructor(extra: string[] = []) {
    this.names = new Set(DEFAULT_ALLOWED);
    for (const n of extra) this.names.add(n);
  }

  /** True iff `name` is permitted. */
  allows(name: string): boolean {
    return this.names.has(name);
  }

  /**
   * Filter a record of env vars against the allowlist. Rejected names are
   * reported but never silently dropped — callers can log or surface them.
   */
  filter(env: Record<string, string>): { allowed: Record<string, string>; result: EnvAllowlistResult } {
    const allowed: Record<string, string> = {};
    const rejected: EnvAllowlistResult['rejected'] = [];
    for (const [name, value] of Object.entries(env)) {
      if (this.allows(name)) {
        allowed[name] = value;
      } else {
        rejected.push({ name, reason: 'not in allowlist' });
      }
    }
    return { allowed, result: { allowed: Object.keys(allowed), rejected } };
  }

  /** Snapshot of the active allowlist (for debugging / introspection). */
  list(): string[] {
    return [...this.names].sort();
  }
}