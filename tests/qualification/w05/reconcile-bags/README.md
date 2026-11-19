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
