# Frozen reconcile-bags validation

**Status.** The retired offline protocol recorded a formal result of 0/3.
It required Linux arm64, 120 seconds, 256 MiB, one CPU, no network and no swap.
The Agent comparison described below is pending.

The historical image owned the observer and the business fixture. The protocol checker verifies the exact native command arguments and expanded skill body on the first Messages request. Each completed backend Read must match the CLI event and the numbered bytes returned on the next request. The final backend text must match both the CLI assistant event and its successful result. The host checks the stdout digest, inventory paths and digests, and independent business assertions. A completed malformed answer is a measured business failure. A missing or inconsistent observation blocks validation.

The normal case requires one document read and `{ "missing": ["H-502"], "extra": ["H-863"] }`. The refusal and missing-page cases require zero reads and their respective business responses. For a revision, all proposed cases must pass and at least one matched original skill behavior case must fail with a complete observation. A tie leaves the candidate at its prior version.

Run the standalone protocol tests with `node --test tests/qualification/w05/reconcile-bags/checker.test.mjs`.

## Agent comparison

Use the [Agent learning workflow](../../../../docs/architecture/plugins.md#agent-learning-workflow)
to prepare a revision. Replay the original and revised skill in fresh sessions
on the same existing Agent route and tool policy. The route may use its
configured HTTPS inference. Before replay, pin both skill digests, the three
unchanged inputs, the handoff fixture, and the Agent version and configuration.
Expose only the approved fixture through the file tool. Keep the expected answers
and verdicts outside the Agent input.

An independent checker must bind each native trace to the actual skill load,
input, tool attempts and results, and final response. The original and revised
arms each need three complete observations. The revision must pass the three
business cases above, with `refuse-before-read` on refusal and
`request-missing-page` on missing-page recovery. At least one complete original
observation must fail. Record missing observations as blocked and record the
Agent result separately from the frozen offline result. The standalone tests
above exercise the historical observer protocol.

## Historical receipts

On 2026-11-20 the macOS arm64 archive built from `f52bedb6` (CLI 0.2.165, SHA-256 `b3cd4e77cd7b25b1ab0365ecbf1af971d11546d16a3a374c8a83d7eab3315f71`) passed the 23 installed command entry checks. A second isolated installation verified the checksum and resolved the selected executable to the same version in `release.json`. Two earlier packaging attempts timed out in `tar`. The successful timed run listed entries in under a second and extracted the archive in approximately nine seconds. The checker protocol suite passed 20/20.

The [recorded run](receipt.json) used a locally packaged 0.2.162 candidate based on `7012631d`. The frozen launcher exited 78. Replaying the installed checker with the same image, original skill and first frozen input encountered `ENOENT` resolving `/opt/afk/model/messages`. All three behavioral outcomes remain open. The CLI returned `verification_failed` and kept the candidate at v1. A separately revoked grant returned `unauthorized`. The historical receipt is bound to its original proposal and frozen case bytes.

On 2026-11-21 an offline smoke test passed three fresh runs of native Claude Code 2.1.319 through a loopback Messages endpoint backed by llama.cpp `b12590` and SmolLM2-135M-Instruct `Q4_K_M`. Linux arm64 ran with one CPU, no network and a 256 MiB memory limit without swap. Claude's terminal result matched the generated text. The container reached the memory limit in all three runs. The offline smoke test covered one text turn per run. Formal skill behavior coverage remains 0/3. See the [smoke receipt](offline-smoke.receipt.json).

The same day, both retained producer histories matched byte for byte for the proposal, candidate ledger, original and revised skill, and source audit. Installed CLI 0.2.183 read a private copy of the ledger as the same v1 `candidate` and returned the retained proposal unchanged. The installed runtime rebuilt the evidence pack from the original audit and matched both the ledger and the frozen receipt. On macOS the scratch profile needed a canonical path because the ledger rejects symbolic link directories.

A synthetic two-turn probe passed three inputs in the same CPU, memory, swap and network limits. Claude executed native `Read`. The observer verified the second Messages request carried the matching tool-use ID and numbered file bytes, and verified the final result. All three checker exits were 0 and no OOM events occurred. The probe receipt SHA-256 is `ff5dcdd7bf41d4b1f5193e6ab11d53d33e3a5a6f127179b6b45d1e2c2029a46f`. Formal skill coverage remained 0/3.

The formal replay on the same date used CLI `0.2.183` built from `25c39da0`, a fresh bound grant and the offline Claude Code `2.1.319` image. The installed CLI exited 1 with `blocked / assertion_failed`. The revoked-grant control exited 1 with `blocked / unauthorized`. Both retained the same v1 candidate. See the [formal receipt](formal-183.receipt.json).

An independent diagnostic replay obtained complete observations for all six original and revised runs. All six checker invocations exited 2. The revision made zero reads in all three cases, including the normal case that required a read, and returned malformed answers in all three. The original read once in the refusal case. The diagnostic receipt SHA-256 is `992db6668b8d72f6f5d556a2490a67b8e0209eb67c5f9aea1a6c30805de99120`. All six diagnostic containers and their temporary input images were removed. Formal coverage remains **0/3**.

A subsequent diagnostic changed only the offline bridge's ChatML framing. The installed frozen executor and semantic observer replayed all three proposed skill cases against the same commit, case digests and proposal bytes. The normal case performed the required read and resumed with the matching tool-use ID and fixture bytes. The refusal and recovery cases each read once against their frozen expectations. All three outputs failed business validation and all checker exits were 2. Each run removed its container and scratch image. The [diagnostic receipt](chatml-diagnostic.receipt.json) preserves the image, bridge, policy and output digests. Its SHA-256 is `c409b8a45568c2c9b6cc02f0910b4ee133778f18698087bb159921e970192552`. The formal result stays at **0/3**, with candidate v1 retained.

Installed CLI `0.2.187` replayed both retained SmolLM2 images with fresh private grants on 2026-11-21. The original bridge finished all six observations with checker exit 2 and returned `assertion_failed`. The ChatML bridge returned `verification_failed` after four checker exits of 2 and a launcher exit of 78 on the original recovery case. The revoked grant returned `unauthorized` before execution. The candidate remained at v1 and the formal gate remains **0/3**. Both images use the same model weights. The [formal replay receipt](formal-187.receipt.json) records both image IDs, grant binding digests and raw receipt hashes.
