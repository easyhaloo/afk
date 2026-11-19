# Parcel tool verification on 0.2.162

The darwin-arm64 package from `2aca5d6b29edbf05f377238bfe77e7d922bdd247` keeps candidate `e1316adc38460632b234887bb4e15cc0c5d770ff33c1b4ba47bdddfc5818a584` at version 1. Preparation produces eight checks. The saved checker `parcel-ean13` binds one of the eight. The formal run stops at the case-count check before selecting a repository. Zero original/proposed comparisons ran. Separately, preparing the one saved experiment returns `unsupported/control_experiment_unavailable`.

| Frozen check | Evidence and outstanding requirement |
|---|---|
| `behavior-1` | Two valid barcodes. Earlier direct harness observed `checked=2, invalidLines=[]`. Formal checker lacks this case. |
| `behavior-2` | Blank lines, leading zeros and a full-width character. Earlier harness observed `4, [1,3,4]`. Formal checker lacks this case. |
| `behavior-3` | Mixed checksums. Earlier harness observed `2, [2]`. Formal checker lacks this case. |
| `behavior-4` | Frozen `null` must yield `error: input must be a string`. Preparation checks schema invalidity. The checker lacks a refusal experiment and independently observed nonzero exit plus diagnostic. |
| `control-cancellation` | The host supports cancellation of a running operation with a schema-valid bound `callInput`. No case, triggered control, or termination receipt for these bytes. |
| `control-timeout` | The candidate declares 5000 ms. No saved case or observed host deadline and termination. An early natural exit fails the proposed control. |
| `control-permission` | Only saved experiment. Its exit and stderr assertions describe a self-report. The candidate declares zero permissions and performs no protected operation with an identifiable target. The adapter rejects the experiment before execution. |
| `control-recovery` | Generated despite the candidate declaring no recovery needed. The supported bounded return/state protocol requires distinct business inputs, helper-bound scratch resources and independent fault/recovery/replay observations. This grant has no helper and the checker has no recovery case. |

`validation.json` in the supplied proof directory records the three direct outputs, held-out `test-runner` output and a failing always-valid control for candidate `bdea8b32…`. The source SHA-256 matches the new candidate exactly. The candidate and evidence identities differ. Both the original asset at `8b000c66` and the proposed source export `checkManifest` as a library function. The saved `node-json-argv-v1` adapter runs the file as a Node entry point. Static inspection finds no argv dispatch or result emission in those two files. The formal gate stopped before either invocation. The earlier harness that calls the export therefore covers additional business behavior only.

## Host evidence

- `formal.json` is a byte copy of the supplied CLI receipt. `candidate.json` records its SHA-256, archive digest and the independent packaged-runtime replay with the original checker and private ledger copy. The runtime's `homeDir` is the retained synthetic evidence home so its absolute source bindings remain valid. Provider-selection callbacks count unexpected selection attempts and the count is zero.
- The revoked arm uses a private grant with `revoked: true` and the checker digest rebound solely for the private grant path. No live grant is written. The installed `experience validate` process exits 1 with `unauthorized`; `experience inspect` reads the same digest, state and version in the copy. This tests authorization to start proposal validation.
- `installed.jsonl` retains the host decision events from a targeted installed E2E run. Independent readers for `tool.scan-manifest@2.0.2` both reject invocation after `tool.source.read` is denied. The observer records the same source digest across allow, deny, restore and replay. A separate shared verification grant also rejects two retained readers after removal. These are installed plugin/package and workspace authorities. The frozen script has no such grant or source-read call.
- The product standard requires this preflight block (`docs/architecture/plugin-integration-standard.zh.md`, lines 496–499). The design requires the candidate's actual operation, exact target and kernel refusal (`docs/superpowers/plans/2026-11-09-session-distillation.md`, line 201). Neither observed gate supplies that event. Granting access to a new resource, manufacturing a probe or equating a blocked validation request with a passed behavior check would change the contract. The remaining decision is how the product should qualify a tool with no protected operation. The current contract gives this candidate no qualifying denial path.

## Reproduction

Run from this checkout on macOS with the retained synthetic evidence home and release directory present. The script reads the original catalog, grant and evidence and only writes to a disposable directory. It pins the archive before unpacking. The installed-boundary test builds the discovery package offline and provisions its own temporary profiles.

```sh
proof=/private/tmp/tool-proof-162.7s6QC7MK
node tests/qualification/w05/tool-denial.mjs "$proof" > /tmp/tool-denial-replay.json
diff tests/qualification/w05/tool-denial/candidate.json /tmp/tool-denial-replay.json
pnpm install --offline --frozen-lockfile
pnpm --filter @afk/core build && pnpm --filter @afk/application build
AFK_W11_CONSUMER_CLI_ENTRY="$proof/afk/dist/index.js" AFK_W11_CONSUMER_CLI_VERSION=0.2.162 \
  pnpm exec vitest run tests/e2e/w11/installed-tool.test.ts -t 'keeps the authorized verifier'
(cd packages/runtime && pnpm exec vitest run src/application/learning/proposal-{runtime,validation-runtime,semantics}.test.ts \
  -t 'before allocating a repository|ordinary output assertions|partial experiment coverage|unsupported mandatory coverage|revoked while durable|revoked\)')
```

Runtime regression suites selected nine passing tests (180 filtered). Installed E2E selected one passing test (six filtered). Initial runtime collection needed the workspace dependencies built; after those builds all selected tests passed. No model calls or Docker experiments were required. Receipts and the test recipe are portable; replaying the candidate from this particular ledger requires its retained path-bound synthetic evidence.
