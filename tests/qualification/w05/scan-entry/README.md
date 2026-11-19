# Scan manifest entry correction on 0.2.162

The installed `experience correct` command accepted the full source in `scan-manifest.mjs` for candidate `e1316adc…` version 1. The replay reads the correction back from its evidence pack and checks the text and target digest. An initial regex literal was altered by the evidence path redactor. The submitted source uses an ASCII digit range check and survives intake intact. The original installation has `dailyCalls` set to zero. Its targeted packaged worker recorded `budget_exhausted`, zero attempts and zero new candidates. `receipt.json` identifies the job, evidence pack, source and archive digests. The job and full checker configuration persist in the isolated profile supplied to the replay.

`checker-cases.json` adds four frozen behavior cases and two host control cases to a copy of the original checker. The package parses the configuration and prepares the six experiments. The original checker still returns `insufficient_coverage`. Installed `experience validate` rejects the expanded checker with `unauthorized` under the existing digest-bound grant. Formal execution started zero of eight cases. The baseline Git blob, historical candidate and original failure receipt are retained by identity in `../tool-denial/` and the synthetic proof.

In Seatbelt the actual revised Node entry point accepts one JSON-encoded string argument, calls `checkManifest`, and writes the result to stdout. The three normal results are `2,[]`, `4,[1,3,4]` and `2,[2]`. JSON `null` exits 1 with the exact frozen stderr `error: input must be a string` and empty stdout. The two historical editions exit zero with empty streams on all four. The replay also checks missing and extra arguments, malformed JSON, a non-string object, and use as an imported library.

The revised program exits in 31 ms with the diagnostic 500 ms cancellation timer and in 38 ms with its declared 5000 ms deadline. Both controls still require observed termination during work. Permission denial still lacks a protected operation and exact target. Recovery still lacks a bound recovery case, helper, interrupted partial state and checkpoint observations. The retained grant covers the original candidate and checker digests. A generated candidate and accepted checker require their own matching grant before formal execution.

## Replay

Run from the checkout on Darwin arm64 with Node 24.18.0. Supply a fresh profile path whose parent exists. The profile and queued request survive the command. The original synthetic evidence home and archive are required.

```sh
LC_ALL=C node tests/qualification/w05/scan-entry/replay.mjs /private/tmp/tool-proof-162.7s6QC7MK "$(mktemp -d)/profile" > /tmp/scan-entry-replay.json
```

The previous seven-case replay also completed after extracting the shared Seatbelt launcher. Runtime regression passed 224 tests with nine native Docker cases skipped. CLI candidate-correction regression passed 47 selected tests after building the workflow graph and runtime dependencies.
