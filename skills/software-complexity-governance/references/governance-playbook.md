# Governance Playbook

Use gates as calibrated controls, not universal verdicts. Establish a baseline first and evaluate new or changed code against repository history, domain criticality, and change behavior.

## Baseline

Record, where available:

- complexity distributions and top offenders
- changed-code debt or threshold breaches
- dependency cycles and boundary crossings
- change frequency, churn, and modules touched per change
- duplication hotspots

## Gates

### Method / class

Use cyclomatic, cognitive complexity, size, parameters, nesting, and coupling as signals. Starting ranges such as cyclomatic ≤10–15, cognitive ≤15, NLOC ≤40–50, and nesting ≤3–4 may be useful defaults, but calibrate them to the repository and language.

### File / module

Track distributions and outliers rather than relying only on averages. Watch oversized files, dependency hubs, cycles, unstable ownership, and repeated cross-boundary changes.

### Project / service

Prefer Clean-as-You-Code for changed code. Track trends in hotspots, debt, dependency cycles, cross-module change, and shared-data ownership. Require explicit review for new multi-writer shared data or new broad shared abstractions.

## Hotspot prioritization

Prioritize findings where complexity combines with frequent change, broad change spread, dependency impact, or business/operational criticality. A single high metric in stable code is not sufficient justification for refactoring.

## Refactoring order

1. Fix false or unstable boundaries and ownership.
2. Consolidate confirmed semantic duplication at the correct ownership layer.
3. Simplify local code structure after the larger cause is addressed.

## Delivery controls

- CI: prefer regression checks on changed code; fail only on justified repository gates.
- PR: require evidence for significant complexity growth or boundary expansion.
- Backlog: prioritize by impact × change frequency × spread × risk.
- Exceptions: document why a gate is unsuitable and define a review or expiry condition.

## Verification

Every accepted governance action should define how improvement will be measured. Re-run the relevant analyzer, dependency analysis, or change metric after the change and compare with the baseline.

## Caveats

Exclude or loosen gates for generated, vendored, third-party, and fixture code unless explicitly requested. Never fabricate unavailable metrics or treat a threshold as a substitute for engineering judgment.