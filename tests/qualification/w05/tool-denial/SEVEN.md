# Scan manifest on 0.2.162

The retained `experience validate` receipt and a fresh packaged-runtime replay with the original active checker both return `blocked/insufficient_coverage`. The private ledger replay observes zero repository selections. The signed-off configuration binds only `control-permission` out of eight checks. The adapter returns `unsupported/control_experiment_unavailable` for that case. The product checks complete coverage before repository selection. Formal comparisons started **0/7**, or **0/8** including permission. See `formal.json`, `candidate.json` and `seven.json` in this directory.

## Seven paired observations

The replay checks the package archive, checker and both source digests. It reads the original blob from commit `8b000c66` and the proposed bytes from candidate `e1316adc…`, version 1. The installed runtime prepares six diagnostic configurations in memory. On macOS the replay starts the real Node binary inside Seatbelt with the prepared raw argument, substituting the private copy's path for `/workspace/script/scan-manifest.mjs`. All 12 entry-point processes exit zero with empty stdout and stderr. Both modules export `checkManifest` and neither dispatches argv. Delivery to a process therefore gives no business result. A separate observer calls the real export, returns the raw argument alongside the value or thrown error, and records both output streams. The six recovery calls also run in fresh processes. All 30 launches use the exact source bytes. The local observer, timers and configurations have diagnostic scope.

| Frozen check | Input used | Original → proposed, directly observed | Outstanding formal observation |
|---|---|---|---|
| behavior-1 | `9780306406157\n5901234123457` | Both check 2 lines and report `[]` | Entry point must emit the structured result |
| behavior-2 | `\n0012345678905\n０\n` | Both check 4 lines. Invalid lines `[]` → `[1,3,4]` | Same delivery gap |
| behavior-3 | `1234567890128\n1234567890129` | Both check 2 lines. Invalid lines `[]` → `[2]` | Same delivery gap |
| behavior-4 | JSON `null` | Both throw `TypeError` with `Cannot read properties of null (reading 'split')` | Frozen expectation is `error: input must be a string`. Entry-point exit is 0 and the export emits a different diagnostic through the observer |
| control-cancellation | behavior-1, local timer 500 ms | Entry points finish in 26 / 25 ms. Direct calls finish in 27 / 27 ms and both return `2,[]` | Neither timer sent a signal. Pre-start cancellation, termination during work and subsequent effects remain unobserved for this candidate |
| control-timeout | behavior-1, declared 5000 ms | Entry points finish in 27 / 27 ms. Direct calls finish in 27 / 29 ms and both return `2,[]` | Neither process reaches its deadline. No deadline termination or partial-effect observation |
| control-recovery | JSON `null`, then behavior-2 twice | Each version throws, then repeats its own four-line result byte-for-byte. Original misses all three invalid lines on both repeats | Installed preparation returns `recovery_contract_unavailable`. The checker has no bound helper or recovery case. Separate natural exits provide no interrupted operation, checkpoint history or recovery of partial state |

`\n` denotes a newline in the decoded business string. `seven.json` retains each raw JSON argument, prepared argv where available, process exit, signal and actual streams. The control input, the 500 ms cancellation timer and the recovery sequence were chosen for this diagnostic. Execution times are host measurements from the retained run and can vary. The timeout value comes from the frozen proposal.

## Permission requirement

The original plan at `d0190782`, lines 167 and 326 of `docs/superpowers/plans/2026-11-09-session-distillation.md`, requires permission denial and allows `none` for inapplicable **side effects**. It leaves the observation mechanism open. The later W02 card at `7dc7990d` requires the candidate's own operation, an exact target and a kernel refusal. The frozen candidate performs arithmetic on a supplied string and declares no permissions. It has no such operation to deny. This creates an applicability gap for pure computation while preserving the original mandatory denial check. The executed host grant-revocation test covers admission to validation. Formal qualification requires an independently accepted observation contract for this class plus a checker and execution authorization bound to all eight cases. The carrier, refusal and control gaps in the table remain independently actionable.

## Replay

From this checkout on Darwin arm64 with Node 24.18.0, keep the supplied synthetic proof directory and its path-bound source home available. The script creates and removes private process workspaces and a private ledger. The receipt survives in Git. Run the command below to a fresh output file.

```sh
LC_ALL=C node tests/qualification/w05/scan-seven.mjs /private/tmp/tool-proof-162.7s6QC7MK > /tmp/parcel-seven-replay.json
```

The regression run passed 180 tests across three files. The nine opt-in native Docker tests were skipped. This command reproduces the selection from `packages/runtime` after building `@afk/core` and `@afk/application`.

```sh
env -u AFK_TEST_FROZEN_DOCKER -u AFK_QUALIFY_NATIVE_SKILL -u AFK_TEST_PROPOSAL_EVIDENCE pnpm exec vitest run src/application/learning/proposal-{semantics,runtime,validation-runtime}.test.ts
```
