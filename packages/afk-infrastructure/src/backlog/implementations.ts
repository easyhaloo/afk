/**
 * The backlog Port implementations.
 *
 * The backlog *model* — `BacklogItem`, its states and execution modes — lives
 * in `@afk/application` as `backlog/model.ts`. This directory holds the
 * implementations behind that Port: the platform providers, the tracker
 * adapter, the claim strategy and the filesystem-backed claim lock.
 */
export * from './claim-strategy.js';
export * from './filesystem-claim-lock.js';
export * from './github-provider.js';
export * from './gitlab-provider.js';
export * from './in-memory-provider.js';
export * from './management-provider.js';
export * from './tracker-adapter.js';
