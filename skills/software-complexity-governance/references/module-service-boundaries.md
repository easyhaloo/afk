# Module and Service Boundary Complexity

Organization complexity at **code module / service** boundaries: how capabilities
are split, how they depend, and how changes propagate. Distinct from method-level
cyclomatic complexity.

## Units

| Level | Unit | Boundary signal |
|-------|------|-----------------|
| In-process module | package / top-level dir / library | allowed import direction, public API |
| Deployable service | microservice / worker / BFF | network calls, independent deploy, data ownership |
| Context | bounded context | ubiquitous language, write ownership |

## Structural metrics

| Metric | Meaning | High means |
|--------|---------|------------|
| Fan-out | external modules/services depended on | hard to test and replace |
| Fan-in | dependents on this unit | hub; change risk |
| CBO / package coupling | distinct external types referenced | leaky boundary |
| Cycles | cycles in module or service graph | cannot release or test in isolation |
| Propagation cost | share of transitive dependency cells | one change shakes many |
| Decoupling level | independently evolvable subgraph share | low = tangled mesh |
| Cross-boundary call density | calls across packages/services per size | chatty architecture |

## Data ownership

| Healthy | Unhealthy |
|---------|-----------|
| Single writer per table/collection; others via API or read model | multiple services write same store |
| Explicit ownership | shared DB joins across services as default |
| Versioned events/contracts | ad-hoc private topics without owner |

Shared multi-writer data is organization failure even if packages look split.

## Change behavior (preferred evidence)

| Metric | Signal |
|--------|--------|
| Cross-module PR ratio | PRs touching ≥2 top-level modules or services |
| Mean modules per change | rising trend = rotting boundaries |
| Co-change pairs | designed apart but always change together = false boundary |
| Release coupling | set of services that must ship together |

## Lightweight scorecard (per module/service)

Rate 1–5:

- **Boundary clarity** — open imports vs API-only + enforced direction
- **Change isolation** — most work stays in one owner vs routine multi-service edits
- **Data ownership** — single writer vs shared write

Prioritize low scores for merge, split, or contract narrowing—not only local CC reduction.

## Detection workflow

1. List top-level modules or deployable services.
2. Build dependency graph; mark cycles and high fan-in/out hubs.
3. Overlay recent history (e.g. 90 days): cross-boundary change share, co-change pairs.
4. Hotspot rank: high fan-in × high churn × many features sharing the unit.
5. Classify each hotspot: multiple capabilities crammed in one unit, or one capability shattered across many.

## Simplify and prune

Order of attack:

1. **Merge false boundaries** — strong co-change, same domain, always co-released.
2. **Split true mixtures** — one service/module owns unrelated capabilities (include data).
3. **Narrow contracts** — stable API/events only; no reading others' tables or internals.
4. **Then** local code refactors inside a correct boundary.

| Problem | Action |
|---------|--------|
| Two units always co-change and co-deploy | Merge deployable or module boundary |
| One unit hosts unrelated capabilities | Vertical slice by capability + data ownership |
| Kitchen-sink `common` / `utils` | Freeze; new logic returns to owners; shared holds stable kernel only |
| Dependency cycles | Invert dependency or extract contract package; ban cycles |
| Cross-service direct DB writes | Restore single writer; API or read replica for others |
| Long sync call chains | Shorten hops, orchestrate, async events, or merge related steps |
| BFF full of business rules | Push rules to owning services; BFF aggregates and auth only |

## Gates against regression

- Automated package rules (e.g. domain must not depend on adapters).
- PR note when crossing N top-level modules/services.
- New service checklist: own data, own release, explicit sync/async contracts.
- Shared libraries default-deny; exception needs owner and stability statement.

## Pairing with method-level metrics

| Observation | Prefer |
|-------------|--------|
| High CC inside one clear service | Local extract/split types |
| Low CC but high cross-service PR share | Re-draw boundaries |
| Hub with extreme fan-in | Split read models, anti-corruption, or capability slices |
| Every feature edits "common" | Common absorbed business → prune and push down |
