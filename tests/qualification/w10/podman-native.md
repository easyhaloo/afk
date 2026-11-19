# W10 · sandbox.podman

This check activates the configured `sandbox.podman` plugin from the built workspace runtime. It looks up the `podman` sandbox provider, calls `create`, runs two shell commands through `startAgent` and `waitForResult`, and calls `close`. The test records the CLI version from the checkout and the exact source commit.

## Run on disposable Linux

Use an ordinary user on a dedicated Linux machine with native `/usr/bin/podman`, working rootless user namespaces and subordinate IDs, GNU tar, `ldd`, system `sh`, `sleep`, `id`, Node 22 and pnpm 10. From the checkout root run

```sh
pnpm install --frozen-lockfile
pnpm --filter @afk/runtime... build
AFK_TEST_NATIVE_PODMAN=1 pnpm exec vitest run tests/qualification/w10/podman-native.test.ts
```

The existing `CI Verification` workflow discovers the test in `Shared Packages And CLI` on its GitHub-hosted Linux runner. Elsewhere the test requires the explicit flag. A selected test fails on a missing prerequisite. A completed check prints one `AFK_PODMAN_RECEIPT` JSON record after cleanup.

## What the check measures

- `podman info` must report a local, rootless Linux engine, an OCI runtime and the two storage paths created for this run. The child process starts with an isolated home, container configuration and runtime directory. `keep-id` maps the invoking user to the product's `1000:1000` container identity.
- `podman import` creates an image in this run's private store from three local Linux executables and their shared libraries. The container has networking disabled. `podman container inspect` must show the imported image, a running container and precisely the four expected writable bind mounts with their actual host sources.
- The success command checks its effective UID and GID, reads a unique host input in the worktree and a matching prompt on stdin, writes the prompt back to the host and emits the input in a structured goal result. The host compares both outputs and observes exit 0. A second command emits a per-run stderr marker and exits 23. The host checks the exact `NON_ZERO_EXIT` error and its message.
- After product `close`, `podman container exists` must return 1 for the previously inspected full container ID and `podman info` must still reach the same store. The check verifies that the private store has no containers, removes its image and releases its rootless namespace.

Coverage is the configured workspace runtime's batch sandbox lifecycle. Installed CLI packaging, agent models, suspend/resume and the separate frozen tool verifier are outside this check.

## Recorded execution

[podman-native.receipt.json](podman-native.receipt.json) is the JSON emitted by the hosted `Test` step on 2026-11-19 at 19:05:14 UTC. On `linux/amd64`, rootless Podman 5.7.0 and `crun` passed the case in 6.976 seconds. The step completed successfully. The dedicated workflow was then cancelled during subsequent coverage collection.

The hosted run used public baseline `6e7e4765` (CLI 0.2.166) plus the two qualification scripts, commit `e5038e0cbf139a00a39f4f865af05de1f91164cc`. The integration patch is based on `eede753d` (CLI 0.2.168). Both commits have the same sandbox source subtree `40ec84f6a6134a3a6815f598a3125c20ebd60bdd`. On the latter baseline the runtime build, typecheck and 298 focused runtime tests passed locally. The macOS host lacked Podman. Explicit selection there failed the Linux prerequisite.

To compare the retained JSON against the original GitHub Actions job, run from the checkout root with Bash or Zsh.

```sh
set -o pipefail
gh run view 44592073226 -R easyhaloo/afk --job 135800539966 --log |
  sed -n 's/.*AFK_PODMAN_RECEIPT //p' | jq -s -e \
    --slurpfile saved tests/qualification/w10/podman-native.receipt.json '. == $saved'
```
