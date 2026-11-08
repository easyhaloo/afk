/**
 * Concrete Security/Policy capability providers.
 *
 * Each provider implements a real evaluation over caller-supplied material and
 * fails closed: a secret hit denies, an unsupported or unparseable license
 * expression denies, and a compliance action that no rule allows is denied by
 * default. None of them scan, hash, or reach for the filesystem in their
 * constructor — all work happens inside `evaluate`.
 *
 * The secret scanner never returns matched text. Findings carry only the file
 * and the kind of secret, so a deny decision cannot leak the value it found.
 */

import { constants, promises as nodeFs } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  PolicyCheckCapability,
  PolicyCheckInput,
  PolicyCheckProvider,
  PolicyDecision,
  ProviderOperationOptions,
} from '../../plugin-sdk/capabilities.js';
import { checkAbort } from './dependencies.js';

/** Minimal filesystem surface the secret scanner needs. */
export interface PolicyFileSystem {
  readFile(path: string): Promise<Uint8Array>;
  lstat(path: string): Promise<PolicyFileStat>;
  readdir(path: string): Promise<readonly string[]>;
  realpath(path: string): Promise<string>;
  open(path: string, flags: number): Promise<PolicyFileHandle>;
}

export interface PolicyFileHandle {
  stat(): Promise<PolicyFileStat>;
  read(buffer: Uint8Array, offset: number, length: number, position: null): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface PolicyFileStat {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
  readonly size: number;
  readonly dev: number;
  readonly ino: number;
}

/** The real filesystem, adapted to {@link PolicyFileSystem}. */
export const nodePolicyFileSystem: PolicyFileSystem = {
  readFile: path => nodeFs.readFile(path),
  lstat: path => nodeFs.lstat(path),
  readdir: async path => nodeFs.readdir(path),
  realpath: path => nodeFs.realpath(path),
  open: (path, flags) => nodeFs.open(path, flags),
};

/** Resolve `relative` inside `root`, throwing if it would escape. */
function resolveWithinRoot(root: string, relative: string): string {
  const normalizedRoot = resolve(root);
  const target = resolve(normalizedRoot, relative);
  if (target !== normalizedRoot && !target.startsWith(normalizedRoot + sep)) {
    throw new Error(`path escapes the scan root: ${JSON.stringify(relative)}`);
  }
  return target;
}

// --- Secret scanning ---

/** A finding names the file and the kind of secret — never the secret itself. */
export interface SecretFinding {
  readonly file: string;
  readonly kind: SecretKind;
}

export type SecretKind = 'private-key' | 'github-token' | 'aws-access-key' | 'credential-assignment';

interface SecretPattern {
  readonly kind: SecretKind;
  readonly pattern: RegExp;
}

/**
 * Detection patterns. Each is anchored to a token shape (not a generic high
 * entropy match) so ordinary text and hex commit hashes do not trip it.
 */
const SECRET_PATTERNS: readonly SecretPattern[] = [
  { kind: 'private-key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { kind: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { kind: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    kind: 'credential-assignment',
    pattern: /\b(?:api[_-]?key|api[_-]?secret|secret|token|password|passwd|access[_-]?key)\b\s*[:=]\s*['"]?[^\s'"`]{6,}/i,
  },
];

export interface SecretScanPolicyOptions {
  /** Default root. evaluate uses context.worktreePath when supplied by the trusted application, never by agent output. */
  readonly root: string;
  /** Relative paths to scan. Defaults to a recursive walk of `root`. */
  readonly files?: readonly string[];
  /** Defaults to the real Node filesystem. */
  readonly fs?: PolicyFileSystem;
  /** Maximum bytes per file. Exceeding it denies an incomplete scan; omitted means no limit. */
  readonly maxFileBytes?: number;
}

/**
 * Denies when any scanned file contains a credential-shaped token.
 *
 * Supports static review before or after execution. The application authorizes
 * the root through context.worktreePath; paths below that root cannot traverse
 * outside it or follow symbolic links.
 */
export class SecretScanPolicyProvider implements PolicyCheckProvider {
  readonly id = 'secret-scan';
  readonly capabilities: Readonly<Record<PolicyCheckCapability, boolean>> = {
    'pre-execution': true,
    'post-execution': true,
    'static-review': true,
  };

  private readonly fs: PolicyFileSystem;

  constructor(private readonly options: SecretScanPolicyOptions) {
    this.fs = options.fs ?? nodePolicyFileSystem;
    if (options.maxFileBytes !== undefined && (!Number.isSafeInteger(options.maxFileBytes) || options.maxFileBytes < 0)) {
      throw new Error('maxFileBytes must be a non-negative safe integer');
    }
  }

  async evaluate(input: PolicyCheckInput, options?: ProviderOperationOptions): Promise<PolicyDecision> {
    checkAbort(options);
    const root = input.context?.worktreePath;
    let findings: readonly SecretFinding[];
    try {
      findings = await this.scanRoot(root === undefined ? this.options.root : root, options);
    } catch (error) {
      checkAbort(options);
      if (error instanceof SecretScanIncompleteError) {
        return { allowed: false, rule: 'secret-scan-incomplete', reason: error.message };
      }
      throw error;
    }
    if (findings.length === 0) return { allowed: true, rule: 'secret-scan' };
    const kinds = [...new Set(findings.map(finding => finding.kind))].sort();
    const files = [...new Set(findings.map(finding => finding.file))].sort();
    return {
      allowed: false,
      rule: 'secret-scan',
      // Only file paths and secret kinds are reported — never matched text.
      reason: `potential secret(s) detected in ${files.length} file(s): ${kinds.join(', ')}`,
    };
  }

  /** Scan and return findings (file + kind only). Never includes secret text. */
  async scan(options?: ProviderOperationOptions): Promise<readonly SecretFinding[]> {
    return this.scanRoot(this.options.root, options);
  }

  private async scanRoot(candidate: unknown, options?: ProviderOperationOptions): Promise<readonly SecretFinding[]> {
    checkAbort(options);
    if (typeof candidate !== 'string' || !candidate.trim() || candidate.includes('\0') || !isAbsolute(candidate)) {
      throw new Error('scan root / worktreePath must be a non-empty absolute directory path');
    }
    const requested = resolve(candidate);
    const original = await this.fs.lstat(requested);
    if (original.isSymbolicLink()) throw new Error('refusing to scan symbolic link as scan root');
    if (!original.isDirectory()) throw new Error('scan root must be a directory');
    const root = { path: await this.fs.realpath(requested), stat: original };
    await this.checkedPath(root, '');
    const relativeFiles = this.options.files ? [...this.options.files].sort() : await this.walk(root, '', options);
    const findings: SecretFinding[] = [];
    for (const file of relativeFiles) {
      checkAbort(options);
      const bytes = await this.readBounded(root, file, options);
      const text = Buffer.from(bytes).toString('utf8');
      for (const { kind, pattern } of SECRET_PATTERNS) {
        if (pattern.test(text)) findings.push({ file, kind });
      }
    }
    checkAbort(options);
    await this.checkedPath(root, '');
    return findings;
  }

  /** Recursively list files under `root` as root-relative paths, refusing any symlink. */
  private async walk(root: ScanRoot, prefix: string, options?: ProviderOperationOptions): Promise<readonly string[]> {
    checkAbort(options);
    const directory = await this.checkedPath(root, prefix);
    if (!directory.stat.isDirectory()) throw new Error('scan directory changed during traversal');
    const entries = await this.fs.readdir(directory.target);
    const files: string[] = [];
    for (const entry of entries) {
      checkAbort(options);
      if (!entry || entry === '.' || entry === '..' || entry.includes('/') || entry.includes('\\')) throw new Error('invalid scan directory entry');
      const file = prefix ? join(prefix, entry) : entry;
      const { stat } = await this.checkedPath(root, file);
      if (stat.isDirectory()) files.push(...(await this.walk(root, file, options)));
      else if (stat.isFile()) files.push(file);
      else throw new SecretScanIncompleteError('secret scan encountered a non-regular file');
    }
    return files.sort();
  }

  private async checkedPath(root: ScanRoot, file: string): Promise<{ target: string; stat: PolicyFileStat }> {
    if (typeof file !== 'string' || file.includes('\0') || isAbsolute(file)) throw new Error('scan file must be a relative path');
    const target = resolveWithinRoot(root.path, file);
    let stat = await this.fs.lstat(root.path);
    if (stat.isSymbolicLink() || stat.dev !== root.stat.dev || stat.ino !== root.stat.ino) throw new Error('scan root changed during evaluation');
    let current = root.path;
    for (const segment of relative(root.path, target).split(sep).filter(Boolean)) {
      current = join(current, segment);
      stat = await this.fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('refusing to scan symbolic link');
    }
    resolveWithinRoot(root.path, await this.fs.realpath(target));
    return { target, stat };
  }

  private async readBounded(root: ScanRoot, file: string, options?: ProviderOperationOptions): Promise<Uint8Array> {
    const before = await this.checkedPath(root, file);
    if (!before.stat.isFile()) throw new SecretScanIncompleteError('selected scan path is not a regular file');
    const limit = this.options.maxFileBytes ?? Infinity;
    if (before.stat.size > limit) throw new SecretScanIncompleteError('secret scan exceeded maxFileBytes; review is incomplete');
    checkAbort(options);
    const handle = await this.fs.open(before.target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      const current = await this.checkedPath(root, file);
      if (!opened.isFile() || opened.dev !== before.stat.dev || opened.ino !== before.stat.ino
        || opened.dev !== current.stat.dev || opened.ino !== current.stat.ino) throw new Error('scan file changed during open');
      if (opened.size > limit) throw new SecretScanIncompleteError('secret scan exceeded maxFileBytes; review is incomplete');
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        checkAbort(options);
        const buffer = Buffer.alloc(Math.min(64 * 1024, limit - total + 1));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        checkAbort(options);
        total += bytesRead;
        if (total > limit) throw new SecretScanIncompleteError('secret scan exceeded maxFileBytes; review is incomplete');
        if (!bytesRead) break;
        chunks.push(buffer.subarray(0, bytesRead));
      }
      const finished = await handle.stat();
      const final = await this.checkedPath(root, file);
      if (finished.size !== total || opened.size !== total || final.stat.dev !== opened.dev || final.stat.ino !== opened.ino) {
        throw new SecretScanIncompleteError('scan file changed during reading; review is incomplete');
      }
      return Buffer.concat(chunks);
    } finally {
      await handle.close();
    }
  }
}

interface ScanRoot {
  readonly path: string;
  readonly stat: PolicyFileStat;
}

class SecretScanIncompleteError extends Error {}

// --- License allowlist ---

type LicenseNode =
  | { readonly kind: 'id'; readonly value: string }
  | { readonly kind: 'or'; readonly left: LicenseNode; readonly right: LicenseNode }
  | { readonly kind: 'and'; readonly left: LicenseNode; readonly right: LicenseNode };

function tokenizeLicense(expression: string): readonly string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < expression.length) {
    const character = expression[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '(' || character === ')') {
      tokens.push(character);
      index += 1;
      continue;
    }
    if (/[A-Za-z0-9._+-]/.test(character)) {
      let end = index;
      while (end < expression.length && /[A-Za-z0-9._+-]/.test(expression[end])) end += 1;
      tokens.push(expression.slice(index, end));
      index = end;
      continue;
    }
    throw new Error(`unsupported license token near "${expression.slice(index, index + 8)}"`);
  }
  return tokens;
}

/** Parse a SPDX-style OR/AND expression. Throws on anything it cannot parse. */
function parseLicenseExpression(expression: string): LicenseNode {
  const tokens = tokenizeLicense(expression);
  let position = 0;
  const peek = (): string | undefined => tokens[position];

  const parseAtom = (): LicenseNode => {
    const token = peek();
    if (token === undefined) throw new Error('unexpected end of license expression');
    if (token === '(') {
      position += 1;
      const node = parseOr();
      if (peek() !== ')') throw new Error('unbalanced parenthesis in license expression');
      position += 1;
      return node;
    }
    if (token === ')') throw new Error('unexpected ")" in license expression');
    const upper = token.toUpperCase();
    if (upper === 'AND' || upper === 'OR') throw new Error(`unexpected operator "${token}"`);
    position += 1;
    return { kind: 'id', value: token };
  };

  const parseAnd = (): LicenseNode => {
    let left = parseAtom();
    while (peek() !== undefined && peek()!.toUpperCase() === 'AND') {
      position += 1;
      left = { kind: 'and', left, right: parseAtom() };
    }
    return left;
  };

  const parseOr = (): LicenseNode => {
    let left = parseAnd();
    while (peek() !== undefined && peek()!.toUpperCase() === 'OR') {
      position += 1;
      left = { kind: 'or', left, right: parseAnd() };
    }
    return left;
  };

  const node = parseOr();
  if (position !== tokens.length) throw new Error('unexpected trailing tokens in license expression');
  return node;
}

function evaluateLicense(node: LicenseNode, allowlist: ReadonlySet<string>): boolean {
  if (node.kind === 'id') return allowlist.has(node.value.trim().toLowerCase());
  if (node.kind === 'or') return evaluateLicense(node.left, allowlist) || evaluateLicense(node.right, allowlist);
  return evaluateLicense(node.left, allowlist) && evaluateLicense(node.right, allowlist);
}

export interface LicensePolicyOptions {
  /** Allowed SPDX identifiers (compared case-insensitively). */
  readonly allowlist: readonly string[];
  /** Licenses from the package manifest(s) to evaluate when context omits one. */
  readonly licenses?: readonly string[];
}

/**
 * Evaluates package-manifest licenses against an allowlist.
 *
 * Compound expressions are honoured: `A OR B` is allowed when either side is
 * allowed, `A AND B` only when both are. Anything the parser cannot understand
 * (an unknown operator, an exception clause, malformed input) fails closed and
 * denies rather than being waved through.
 */
export class LicensePolicyProvider implements PolicyCheckProvider {
  readonly id = 'license-policy';
  readonly capabilities: Readonly<Record<PolicyCheckCapability, boolean>> = {
    'pre-execution': true,
    'post-execution': false,
    'static-review': true,
  };

  private readonly allowlist: ReadonlySet<string>;

  constructor(private readonly options: LicensePolicyOptions) {
    this.allowlist = new Set(options.allowlist.map(entry => entry.trim().toLowerCase()));
  }

  async evaluate(input: PolicyCheckInput, options?: ProviderOperationOptions): Promise<PolicyDecision> {
    checkAbort(options);
    const expressions = this.resolveExpressions(input);
    if (expressions.length === 0) {
      return { allowed: false, rule: 'license-allowlist', reason: 'no package license supplied' };
    }
    for (const expression of expressions) {
      let permitted: boolean;
      try {
        permitted = evaluateLicense(parseLicenseExpression(expression), this.allowlist);
      } catch (error) {
        return {
          allowed: false,
          rule: 'license-allowlist',
          reason: `unsupported license expression: ${(error as Error).message}`,
        };
      }
      if (!permitted) {
        return { allowed: false, rule: 'license-allowlist', reason: `license is not allowlisted: ${expression}` };
      }
    }
    return { allowed: true, rule: 'license-allowlist' };
  }

  private resolveExpressions(input: PolicyCheckInput): readonly string[] {
    const fromContext = input.context?.['license'];
    if (typeof fromContext === 'string' && fromContext.trim().length > 0) return [fromContext];
    return this.options.licenses ?? [];
  }
}

// --- Compliance rules (deny precedence, default deny) ---

export type PolicyContext = Readonly<Record<string, string | number | boolean>>;

export interface ComplianceRule {
  readonly id: string;
  readonly effect: 'allow' | 'deny';
  /** Actions this rule applies to. `*` matches any. Omit to match all actions. */
  readonly actions?: readonly string[];
  /** Extra predicate over the decision context. */
  readonly when?: (context: PolicyContext) => boolean;
  readonly reason?: string;
}

export interface CompliancePolicyOptions {
  readonly rules: readonly ComplianceRule[];
  /** Effect when no rule matches. Defaults to `deny` (fail closed). */
  readonly defaultEffect?: 'allow' | 'deny';
}

/**
 * Evaluates configured compliance rules over the action and context.
 *
 * A matching deny always wins over any allow, and when nothing matches the
 * default effect applies (deny unless explicitly configured otherwise), so an
 * unclassified action is never silently permitted.
 */
export class CompliancePolicyProvider implements PolicyCheckProvider {
  readonly id = 'compliance-policy';
  readonly capabilities: Readonly<Record<PolicyCheckCapability, boolean>> = {
    'pre-execution': true,
    'post-execution': true,
    'static-review': true,
  };

  private readonly rules: readonly ComplianceRule[];
  private readonly defaultEffect: 'allow' | 'deny';

  constructor(options: CompliancePolicyOptions) {
    this.rules = options.rules;
    this.defaultEffect = options.defaultEffect ?? 'deny';
  }

  async evaluate(input: PolicyCheckInput, options?: ProviderOperationOptions): Promise<PolicyDecision> {
    checkAbort(options);
    const context: PolicyContext = input.context ?? {};
    const matched = this.rules.filter(rule => this.matches(rule, input.action, context));
    const denied = matched.find(rule => rule.effect === 'deny');
    if (denied) {
      return { allowed: false, rule: denied.id, reason: denied.reason ?? 'denied by compliance rule' };
    }
    const allowed = matched.find(rule => rule.effect === 'allow');
    if (allowed) return { allowed: true, rule: allowed.id, reason: allowed.reason };
    if (this.defaultEffect === 'allow') return { allowed: true, rule: 'default' };
    return { allowed: false, rule: 'default-deny', reason: 'no compliance rule allowed this action' };
  }

  private matches(rule: ComplianceRule, action: string, context: PolicyContext): boolean {
    if (rule.actions && rule.actions.length > 0) {
      const actionMatches = rule.actions.some(candidate => candidate === '*' || candidate === action);
      if (!actionMatches) return false;
    }
    if (rule.when && !rule.when(context)) return false;
    return true;
  }
}
