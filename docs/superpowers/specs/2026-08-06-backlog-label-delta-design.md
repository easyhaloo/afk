# Backlog Label Delta Updates

## Goal

Persist backlog workflow metadata as the smallest possible label delta. A
workflow transition must add only newly required labels and remove only labels
that no longer apply. Business and relationship labels remain untouched.

## Provider Contract

`TrackerProvider` gains `updateLabels(id, delta)`, where `delta` contains
deduplicated `add` and `remove` label lists. Labels present in both lists are
eliminated before the provider is called. An empty delta performs no remote
operation.

GitHub and GitLab providers implement the contract with their native label
mutation endpoints. The in-memory provider applies the same delta for tests.

## Backlog Mapping

`TrackerBacklogProvider` derives the desired workflow metadata for every
transition:

- exactly one `stage::*` label for the target canonical state;
- exactly one `mode::*` label, preserving the current mode for normal
  transitions, defaulting to `mode::afk` when absent, and forcing
  `mode::hitl` for `blocked`;
- all non-workflow labels retained unchanged.

It compares desired metadata with the current metadata and delegates only the
resulting additions and removals to `updateLabels`.

`setExecutionMode` follows the same rule for mode labels and leaves the state
label untouched.

## Failure And Consistency

The adapter computes deltas from a fresh issue read. Providers must apply
removals before additions when their platform lacks a single atomic mutation,
so the resulting issue never has two workflow labels in the same category.
Provider errors propagate to the caller; no compensating full-label overwrite
is attempted.

## Tests

Tests cover state changes, mode changes, blocked routing, business-label
preservation, empty deltas, and the concrete GitHub/GitLab native requests.
