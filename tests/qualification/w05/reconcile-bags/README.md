# Frozen reconcile-bags validation

`validate.mjs` takes the retained producer history, a new output directory, an installed CLI release directory, and a Docker image ID. It copies the ledger into its own profile and recreates the committed synthetic repository. The operator running this recipe authorizes execution with a private grant bound to the candidate, evidence, checker, inventory, image and limits. The script invokes the installed `experience validate` command and propagates its exit status. The candidate ledger and before/after receipt stay under the output directory.

The image owns the observer and the business fixture. The checker verifies the exact native command arguments and expanded skill body on the first Messages request. Each completed backend Read must match the CLI event and the numbered bytes returned on the next request. The final backend text must match both the CLI assistant event and its successful result. The host checks the stdout digest, inventory paths and digests, and independent business assertions. A completed malformed answer is a measured business failure. A missing or inconsistent observation blocks validation.

The normal case requires one document read and `{ "missing": ["H-502"], "extra": ["H-863"] }`. The refusal and missing-page cases require zero reads and their respective business responses. For a revision, all proposed cases must pass and at least one matched original skill behavior case must fail with a complete observation. A tie leaves the candidate at its prior version.

From the repository root on macOS arm64, use an absolute `RUN` directory and set `HISTORY` to the retained `skill-followup` directory containing `producer-installed`. Set `BASE_IMAGE` to a reviewed local image with Node, the compatible Claude CLI, a real offline inference executable at `/opt/afk/model/messages`, and its model weights. Each invocation consumes one Claude Messages JSON request on stdin and emits a complete text or Read SSE turn on stdout, with at most one Read per turn. The executable must operate under the frozen 256 MiB, one-CPU and no-network policy without personal credentials. Bind a fresh grant to the rebuilt image and the new checker digest. The protocol tests can be run separately with `node --test tests/qualification/w05/reconcile-bags/checker.test.mjs`.

```sh
set -eu
mkdir -p "$RUN"
pnpm release:cli --output "$RUN/package"
archive="$RUN/package/afk-darwin-arm64.tar.gz"
version=$(node -p "require('./apps/cli/package.json').version")
AFK_HOME="$RUN/profile/.afk" sh "$RUN/package/install.sh" --skip-completion --version "$version" \
  --archive "$archive" --checksum "$archive.sha256" --prefix "$RUN/profile/bin"
entry=$(readlink "$RUN/profile/bin/afk")
release=${entry%/dist/index.js}
kit=tests/qualification/w05/reconcile-bags
docker build --network=none --pull=false --build-arg BASE_IMAGE="$BASE_IMAGE" \
  --iidfile "$RUN/image.id" "$kit"
node "$kit/validate.mjs" "$HISTORY" "$RUN/authorized" \
  "$release" "$(cat "$RUN/image.id")"
W11_REVOKED=1 node "$kit/validate.mjs" "$HISTORY" "$RUN/revoked" \
  "$release" "$(cat "$RUN/image.id")"
```

On 2026-11-20 the macOS arm64 archive built from `f52bedb6` (CLI 0.2.165, SHA-256 `b3cd4e77cd7b25b1ab0365ecbf1af971d11546d16a3a374c8a83d7eab3315f71`) passed the 23 installed command entry checks. A second isolated installation verified the checksum and resolved the selected executable to the same version in `release.json`. Two earlier packaging attempts timed out in `tar`. The successful timed run listed entries in under a second and extracted the archive in approximately nine seconds. The checker protocol suite passed 20/20.

The [recorded run](receipt.json) used a locally packaged 0.2.162 candidate based on `7012631d`. The frozen launcher exited 78. Replaying the installed checker with the same image, original skill and first frozen input encountered `ENOENT` resolving `/opt/afk/model/messages`. All three behavioral outcomes remain open. The CLI returned `verification_failed` and kept the candidate at v1. A separately revoked grant returned `unauthorized`. To resume, supply a reviewed image with the offline backend and issue a fresh grant through this recipe. The proposal and frozen cases stay pinned to their original bytes.

On 2026-11-21 an offline smoke test passed three fresh runs of native Claude Code 2.1.319 through a loopback Messages endpoint backed by llama.cpp `b12590` and SmolLM2-135M-Instruct `Q4_K_M`. Linux arm64 ran with one CPU, no network and a 256 MiB memory limit without swap. Claude's terminal result matched the generated text. The container reached the memory limit in all three runs. The offline smoke test covered one text turn per run. Formal skill behavior coverage remains 0/3. See the [smoke receipt](offline-smoke.receipt.json).

The same day, both retained producer histories matched byte for byte for the proposal, candidate ledger, original and revised skill, and source audit. Installed CLI 0.2.183 read a private copy of the ledger as the same v1 `candidate` and returned the retained proposal unchanged. The installed runtime rebuilt the evidence pack from the original audit and matched both the ledger and the frozen receipt. On macOS the scratch profile needed a canonical path because the ledger rejects symbolic link directories.

A synthetic two-turn probe passed three inputs in the same CPU, memory, swap and network limits. Claude executed native `Read`. The observer verified the second Messages request carried the matching tool-use ID and numbered file bytes, and verified the final result. All three checker exits were 0 and no OOM events occurred. The probe receipt SHA-256 is `ff5dcdd7bf41d4b1f5193e6ab11d53d33e3a5a6f127179b6b45d1e2c2029a46f`. Qualification of the frozen skill cases remains 0/3 pending a replay with the bound candidate, checker, image and fresh grant.

The formal replay on the same date used CLI `0.2.183` built from `25c39da0`, a fresh bound grant and the offline Claude Code `2.1.319` image. The installed CLI exited 1 with `blocked / assertion_failed`. The revoked-grant control exited 1 with `blocked / unauthorized`. Both retained the same v1 candidate. See the [formal receipt](formal-183.receipt.json).

An independent diagnostic replay obtained complete observations for all six original and revised runs. All six checker invocations exited 2. The revision made zero reads in all three cases, including the normal case that required a read, and returned malformed answers in all three. The original read once in the refusal case. The diagnostic receipt SHA-256 is `992db6668b8d72f6f5d556a2490a67b8e0209eb67c5f9aea1a6c30805de99120`. All six diagnostic containers and their temporary input images were removed. Formal coverage remains **0/3**. The offline backend needs to select the required read and produce valid answers on the frozen inputs within the bound policy.

A subsequent diagnostic changed only the offline bridge's ChatML framing. The installed frozen executor and semantic observer replayed all three proposed skill cases against the same commit, case digests and proposal bytes. The normal case performed the required read and resumed with the matching tool-use ID and fixture bytes. The refusal and recovery cases each read once against their frozen expectations. All three outputs failed business validation and all checker exits were 2. Each run removed its container and scratch image. The [diagnostic receipt](chatml-diagnostic.receipt.json) preserves the image, bridge, policy and output digests. Its SHA-256 is `c409b8a45568c2c9b6cc02f0910b4ee133778f18698087bb159921e970192552`. The formal result stays at **0/3**, with candidate v1 retained.
