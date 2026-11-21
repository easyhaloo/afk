# Scan manifest entry correction on 0.2.162

The installed `experience correct` command accepted the full source in `scan-manifest.mjs` for candidate `e1316adc…` version 1. The replay reads the correction back from its evidence pack and checks the text and target digest. An initial regex literal was altered by the evidence path redactor. The submitted source uses an ASCII digit range check and survives intake intact. The original installation has `dailyCalls` set to zero. Its targeted packaged worker recorded `budget_exhausted`, zero attempts and zero new candidates. `receipt.json` identifies the job, evidence pack, source and archive digests. The job and full checker configuration persist in the isolated profile supplied to the replay.

`checker-cases.json` adds four frozen behavior cases and two host control cases to a copy of the original checker. The package parses the configuration and prepares the six experiments. The original checker still returns `insufficient_coverage`. Installed `experience validate` rejects the expanded checker with `unauthorized` under the existing digest-bound grant. Formal execution started zero of eight cases. The baseline Git blob, historical candidate and original failure receipt are retained by identity in `../tool-denial/` and the synthetic proof.

In Seatbelt the actual revised Node entry point accepts one JSON-encoded string argument, calls `checkManifest`, and writes the result to stdout. The three normal results are `2,[]`, `4,[1,3,4]` and `2,[2]`. JSON `null` exits 1 with the exact frozen stderr `error: input must be a string` and empty stdout. The two historical editions exit zero with empty streams on all four. The replay also checks missing and extra arguments, malformed JSON, a non-string object, and use as an imported library.

The revised program exits in 31 ms with the diagnostic 500 ms cancellation timer and in 38 ms with its declared 5000 ms deadline. Both controls still require observed termination during work. Permission denial still lacks a protected operation and exact target. Recovery still lacks a bound recovery case, helper, interrupted partial state and checkpoint observations. The retained grant covers the original candidate and checker digests. A generated candidate and accepted checker require their own matching grant before formal execution.

The 0.2.183 runtime accepts a control timer equal to the 5000 ms execution limit. Two opt-in native Docker checks passed from source using a local Node 22 base image. The direct control triggered 5021 ms after observing the container running. The paired proposal control recorded a baseline early exit with code 0 and triggered on the proposed process after 5027 ms. Both triggered runs confirmed SIGKILL and exit 137. Ownership checks found no remaining containers or images from the three operations. These checks use a synthetic long-running proposal. Formal `scan-entry` coverage remains 0/8, and grants for earlier host revisions must be reissued for `proposal-validation-runtime-v5`.

A native Docker diagnostic compared a program that received `EROFS` while writing `/workspace/asset.js` with one that printed the same error without attempting the write. Both exited 23 with the same scratch digest and `historyCoverage: "not-observed"`. The formal denial case needs an independent witness of the operation, target and refusal. The recovery case needs an observed partial effect and a checkpoint read after interruption. This diagnostic does not change the frozen candidate or its 0/8 result.

## Synthetic W06 controls

Run `pnpm exec vitest run tests/qualification/w05/scan-entry/control-fixtures.test.ts` from a built workspace. On a POSIX filesystem, the non-root permission test issues the same write to a writable control and to a `0444` synthetic asset. The host confirms `EACCES` for the exact protected path and reads back the original bytes. The tool checker still needs a binding for this witness.

The recovery fixture scans two lines. A controlled exit after the first line leaves a partial checkpoint. Recovery and replay return the same result and preserve the final checkpoint bytes. The host test prepares the case with the product schema. The native Docker test checks the same frozen returns and checkpoint bytes under one owned operation. Docker 28.3.2 on Linux arm64 observed exits `23`, `0`, and `0`, with quiescence confirmed at each checkpoint. The run left zero operation containers, images, or compiler containers.

With the suite's pinned image already present, replay the Docker case with:

```sh
AFK_FROZEN_SCRATCH_DOCKER=1 AFK_FROZEN_SCRATCH_EVIDENCE=/absolute/path/to/receipt.json \
  pnpm --filter @afk/runtime exec vitest run src/infrastructure/sandbox/container/frozen-scratch-helper.test.ts \
  -t 'reads the interrupted manifest scan checkpoint'
```

Formal coverage remains 0/8. The historical candidate accepts a string. Formal recovery requires a candidate that supports the checkpoint protocol, a checker bound to its checks, a native scratch helper and a matching digest-bound grant.

The paired proposal runtime replay used a real temporary Git worktree and offline Docker. It observed an early baseline exit of `0` against the expected fault exit `23`. The checkpoint proposal returned `23`, `0`, `0`, and its receipt bound the phase observations to the proposal artifact, unchanged inputs and container. The three owned operations left no containers, images or Git worktrees. The replay exercised only the synthetic recovery check.

## Replay

Run from the checkout on Darwin arm64 with Node 24.18.0. Supply a fresh profile path whose parent exists. The profile and queued request survive the command. The original synthetic evidence home and archive are required.

```sh
LC_ALL=C node tests/qualification/w05/scan-entry/replay.mjs /private/tmp/tool-proof-162.7s6QC7MK "$(mktemp -d)/profile" > /tmp/scan-entry-replay.json
```

The previous seven-case replay also completed after extracting the shared Seatbelt launcher. Runtime regression passed 224 tests with nine native Docker cases skipped. CLI candidate-correction regression passed 47 selected tests after building the workflow graph and runtime dependencies.
