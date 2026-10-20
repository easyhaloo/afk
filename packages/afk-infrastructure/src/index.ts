/**
 * `@afk/infrastructure` — the concrete implementations behind the
 * `@afk/application` ports: provider SDK clients, the tracker provider
 * factory, git and branch adapters, change-request adapters and the
 * filesystem-backed claim lock.
 *
 * The package may use Node builtins and provider SDKs; what it may not do is
 * depend on anything outside `@afk/core` and `@afk/application`. The
 * architecture guard enforces both halves of that rule.
 */
export * from './backlog/implementations.js';
export * from './branches/index.js';
export * from './git/index.js';
export * from './io/index.js';
export * from './observability/index.js';
export * from './provider/index.js';
export * from './schemas.js';
export * from './shared/gitlab-project.js';
export * from './shared/shell.js';
export * from './tracker/index.js';
