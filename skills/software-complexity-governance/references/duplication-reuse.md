# Duplication vs Shared Capability (Anti-CP)

Similar capabilities must not be grown by copy-paste (CP). Confirm shared
semantics, then settle **one** implementation behind a clear contract. Blind
`common` dumps increase organization complexity.

## Rule

> Same business rule maintained once. Variation via strategy, config, or
> extension points—not another cloned path.

**Rule of Three:** one instance may stay local; on second or third confirmed
same meaning, extract. Do not invent frameworks on first sight.

## Why CP raises organization complexity

- Same rule in many places → Shotgun Surgery on change.
- Co-change surfaces multiply → cross-boundary PR rate rises.
- Parallel modules/services look independent but behave as clones.

After proper reuse: change surface shrinks; dependents rely on a stable contract;
graph moves from mesh-of-clones toward layered or hub reuse.

## Extract vs do not extract

**Extract when:**

- Same domain rule (pricing, authz checks, state-machine skeleton, idempotency, audit).
- Stable protocol (errors, pagination, outbound retry).
- Same algorithm/validation already appears in multiple places with same meaning.

**Do not extract yet when:**

- Speculative or single-context experiments.
- Only UI/copy similarity; domain meanings differ.
- Orchestration that is still discovering its shape.

## Where to settle reuse

| Layer | Mechanism | Constraint |
|-------|-----------|------------|
| Inside module | Extract method/class, template method, strategy | Variation as params/strategy objects |
| Multi-module in process | Shared library or thin shared-kernel | Stable cross-context concepts only |
| Multi-service | Platform or domain service (single writer) | Reuse via API/events; do not clone services |
| Configuration | Rule tables, policy config, flags | Difference as data, not forked code |

**Anti-pattern:** everything lands in `common` → all services depend on it →
every change forces fleet upgrades. Shared layers need **owner, version,
explicit public surface**; default reject new business specials into common.

## From CP to shared capability

1. Find clones: similar names, call chains, co-changed files, repeated validation/flows.
2. Align meaning: same business concept, not only similar code.
3. Split invariant vs variation; invariants go shared.
4. Choose layer (module → library → service) by deploy and data ownership needs.
5. Migrate callers; deprecate old paths; ban further CP of that rule.
6. Review gate: reject large near-duplicate hunks; shared-module PRs need compatibility check.

Related refactorings: Extract Method/Class, Form Template Method,
Replace Conditional with Polymorphism, Introduce Parameter Object, Pull Up.

## Hard team rules (recommended)

- No CP of a full path for a "similar" demand.
- Second occurrence of the same rule requires a short proposal: layer, owner, contract.
- `common` (or equivalent) PRs are stricter; no owner → no merge.

## Boundary interaction

| Situation | Action |
|-----------|--------|
| Feature logic duplicated | Extract shared capability |
| False module/service split (clones co-changing) | Merge boundary, then single implementation |
| Same capability must stay separately deployed | Shared library or platform service—not N copies |

Detection heuristic for reports: parallel modules, near-duplicate flows, or
co-changed clones → recommend extract with target layer; never recommend
another CP.
