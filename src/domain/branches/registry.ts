/**
 * BranchStrategyRegistry — maps BranchStrategyKind -> BranchStrategy.
 *
 * The runner picks a strategy from a BranchStrategyConfig via `forConfig()`.
 * Tests can register fake strategies for the duration of a test (call
 * `_resetBranchStrategyRegistry()` to restore).
 */

import type { BranchStrategy, BranchStrategyKind, BranchStrategyConfig } from './types';
import { IssueBranchStrategy } from './issue';
import { NamedBranchStrategy } from './named';
import { MergeToHeadBranchStrategy } from './merge-to-head';
import { ExistingBranchStrategy } from './existing';

const registry = new Map<BranchStrategyKind, BranchStrategy>();

/** Built-in strategies — registered once per process. */
function builtinStrategies(): BranchStrategy[] {
  return [
    new IssueBranchStrategy(),
    new NamedBranchStrategy(),
    new MergeToHeadBranchStrategy(),
    new ExistingBranchStrategy(),
  ];
}

/** Eagerly register builtins on first import. Subsequent registerBranchStrategy
 *  calls may overwrite individual kinds. */
function ensureBuiltins(): void {
  if (registry.size === 0) {
    for (const s of builtinStrategies()) registry.set(s.kind, s);
  }
}

/** Register a strategy. Overwrites existing registration for the same kind. */
export function registerBranchStrategy(strategy: BranchStrategy): void {
  registry.set(strategy.kind, strategy);
}

/** Look up a strategy by kind. Returns undefined when not registered. */
export function getBranchStrategy(kind: BranchStrategyKind): BranchStrategy | undefined {
  ensureBuiltins();
  return registry.get(kind);
}

/** Same as getBranchStrategy but throws if missing. */
export function requireBranchStrategy(kind: BranchStrategyKind): BranchStrategy {
  const s = getBranchStrategy(kind);
  if (!s) throw new Error(`branch strategy not registered: ${kind}`);
  return s;
}

/** Pick the strategy for the given config (uses config.type). */
export function strategyForConfig(config: BranchStrategyConfig): BranchStrategy {
  return requireBranchStrategy(config.type);
}

/** List registered kinds. */
export function listBranchStrategies(): BranchStrategyKind[] {
  ensureBuiltins();
  return [...registry.keys()];
}

/** Reset the registry — used by tests to isolate state. Re-registers builtins
 *  immediately so the next call to a registry helper sees the defaults. */
export function _resetBranchStrategyRegistry(): void {
  registry.clear();
  for (const s of builtinStrategies()) registry.set(s.kind, s);
}

export * from './types';
export { IssueBranchStrategy } from './issue';
export { NamedBranchStrategy } from './named';
export { MergeToHeadBranchStrategy } from './merge-to-head';
export { ExistingBranchStrategy } from './existing';