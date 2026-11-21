# W11 前瞻三臂对照 / Prospective three-arm protocol

同一包裹分别给三个独立会话空上下文、旧版正文和新版正文。环境题检查 staging 日志的原始 JSON；修复题检查实测纸距和同一面单连续两次的偏移；流程题检查先核对袋号再签收的状态转换。两个参数分别是 `W11-101`、`W11-202`。第一轮按 `none, old, new` 执行，第二轮反序。每一轮都有独立的三臂比较。

### Prepare the releases

Use an installed AFK CLI with `context.knowledge gather`, its compatible Node runtime, Python 3.9+ on Unix and the Claude Code CLI supporting the flags in `arguments()`. Use absolute executable paths. Place the spec and synthetic producer homes in a private directory outside any project. Configure the model endpoint and its credentials through the environment only for authorized formal runs. Freeze and replay require no model call.

For each edition retain the actual product `publication.json` (inner record), `grant.json`, `validation.json` and `independent-check.json` in an evidence directory. The synthetic profile supplies `.afk/plugins.yml`, the installed checker if applicable, and the checkpointed `.afk/learning` directory with the ledger and recovery plans. Keep the producer's live grant, checker authority, evidence and vault available at their authorized locations. Use only dedicated synthetic profiles and approved synthetic page content.

Each pair must have distinct committed publication keys, QA executions, candidate/version identities and page bytes for the registered logical target. The new plan must identify the old page bytes as its predecessor. For releases to separate edition pages, the observed correction event cited by independent QA may instead include `W11 supersedes <old-publication-key>`. Record that reference when producing the actual correction. Keep both editions independently readable by the product. If its event cursor binds transcript access to the original HOME, produce each edition under its own dedicated child directory of the spec directory and set `sourceHome` to `true`. During gather AFK can open that synthetic profile normally. The collector checks its frozen ledger, config and installed checker. A copied profile that returns an empty selection fails admission.

### Freeze and collect

```sh
python3 scripts/w11-prospective/protocol.py template > "$study/spec.json"
```

Fill in `node`, `cli` (installed `dist/index.js`), `agent`, `perSlotCents`, `totalCents` and the groups with available pairs. A `null` group registers six missing slots. The example shows the value of `groups.process`. Use the scenario's exact `PROMPTS` text, logical target, applicability and page paths from its actual releases for the other groups. For `environment`, publish authorized fact snapshots that match the query's environment and version.

```json
{
  "targetRef": "wiki:return-handoff",
  "query": {
    "scope": "github:w11/parcel",
    "prompt": "按 staging 的非自提退件流程办理指定包裹的交接，给出签收记录。",
    "limit": 5,
    "applicability": {"environment": "staging", "version": "2.0"},
    "target": {"project": "github:w11/parcel", "productVersions": {"parcel": "2.0"}, "conditions": {"pickup": false}}
  },
  "old": {"evidence": "/study/first/receipts", "profile": "/study/first", "page": "First.md", "sourceHome": true},
  "new": {"evidence": "/study/second/receipts", "profile": "/study/second", "page": "Second.md", "sourceHome": true}
}
```

```sh
runner=scripts/w11-prospective/protocol.py
python3 "$runner" freeze "$study/spec.json" "$study/queue" > "$study/freeze.sha256"
python3 "$runner" check-live "$study/queue"
python3 "$runner" run "$study/queue" process 1 225
python3 "$study/queue/frozen/protocol.py" replay "$study/queue" > "$study/report.json"
```

`freeze` requires a new output directory. It binds the runner, station, schedule, tool identities, per-edition ledger and QA material and the three preflight selections. Save the printed SHA-256 separately for comparison with `lock.json`. Each formal seat gathers again. AFK must return exactly the registered origin and bytes, or an empty array for `none`. The collector delivers the gathered text in the system prompt. Each seat gets a new benchmark work item, run ID, workspace and native session. These local identities allow correlation. Product adoption requires its own AFK receipt.

The last `run` argument authorizes a maximum number of cents for that invocation. Each seat reserves its full allowance before launch and has one attempt. The default is 75¢ per seat, $2.25 per triad, $13.50 for 18. Lower `totalCents` at freeze time to limit total reservations. A shared file lock covers reservations and execution. Claude receives `--max-budget-usd`; its reported costs are estimates. An interrupted attempt, unknown spend or exceeded native cap stops further launches. Producer and independent QA costs belong to their own receipts.

### V2 observation fields

Generate a V2 spec from `template` and reuse the existing release-pair inputs. Replay a V1 queue with its own frozen runner. V2 hashes the installed AFK tree containing `dist/`, `node_modules/`, `release.json` and `package.json`, including internal link targets. `check-live` verifies the archive, then tests the currently configured installations, authority and recall per arm with zero model calls. After moving only the queue, historical replay is portable. Live recall still uses the original authorized paths. Explicit revocation, missing grant, missing source HOME, changed package and empty selection each have separate reports when observable. A provider that only returns an unexpected empty array gets a selection failure with the cause undetermined.

Freeze and replay look up each product evidence pack by its SQLite snapshot key. They recompute the pack digest and every entry digest and check source completeness, provenance and locators. A cross-page predecessor counts only when independent QA cites the observed audit entry by ID, digest and locator.

The `none` gather first requires the old edition's unique positive result on the same query and provider registration. Its separate empty HOME gets the same plugin configuration and an integrity-checked empty copy of the product ledger schema. Replay verifies the recorded positive and empty selections. `prelaunch-blocked` records a gather failure before reservation. A reserved seat with incomplete evidence remains `interrupted`. Both launch and replay use the terminal native result's exact decimal USD value to check the frozen cent limit. Invalid, unknown and over-cap spend excludes the triad from comparisons and blocks further reservations.

Each station operation must match a serial native Bash call and result in the same session by ID, command, payload and error flag. `trace` reports this check. `checker.passed` requires the exact staging or signature record, or both final consecutive print records in order. `delivery` describes the supplied prompt. To measure `adoption`, preregister a verbatim passage and its distinguishing ordered actions in the edition's spec before freeze, for example on the edition containing the quoted passage:

```json
{"adoption":{"quote":"先核对袋号，再登记签收","commands":[["核对袋号","{parcel}"],["登记签收","{parcel}"]]}}
```

Choose commands that distinguish the edition's advice for both parameters. `{parcel}` resolves to the assigned parcel. Repair rules can also use `{pitch}` for the parcel's measured media pitch. The process station records a successful `核对清单` before `核对袋号` as a recurrence of the redundant step. Both routes can reach `已签收`. The final response cites the delivered origin, exact passage and one-based station steps. `observed` binds that claim to matching actions and reports their native tool IDs, even when the final task answer is wrong. With a registered rule and no matching citation the result is `unobserved`. An edition without a rule is `unregistered`. `none` is `inapplicable`. Use the AFK product receipt for product-level adoption.

Every cited step must succeed in both the native tool result and the replayed station journal. A later successful retry supports adoption only if the claim cites that retry. Spend attribution also requires one native session across the stream. A foreign assistant message makes the cost `unknown` even if the terminal result reports a price within the cap. The current reservation remains charged against the seat budget and further launches stop.

### Independent replay

Archive `frozen/`, `lock.json`, `preflight-*` and `attempts/` privately. Pin the archive digest outside the queue when handing it off. Replay checks file hashes, reconstructs argv from the frozen prompt and recalled body, compares native model and controls, checks session uniqueness, replays station transitions, and scores the native final answer. It reads local files without starting AFK or Claude. `rows` includes failed, interrupted, pending and missing-publication seats. `comparisons` gives treatment minus baseline for success, recurrence, command count, time, tokens and estimated USD. Missing measurements stay null. Two repeats describe only these tasks.

```sh
python3 -B -m unittest discover -s scripts/w11-prospective -p 'test_*.py' -v
```

Regression subprocesses generate fixture provider and agent records in temporary directories. Live results require product receipts and independent native model sessions. The historical fixed queue retains its own plan and observations.

The offline tests use `fixtures/product-audit-pack.json`, produced by AFK's `JsonlEventStore.append` and `buildEvidencePack` from one synthetic audit event and checked with `validateEvidencePack`. The tests derive linked editions for temporary publication keys and invoke the archived runner from a different working directory after relocation.

### Integration replay on `fbf0969a`

`blackbox.py` reuses the synthetic publication and provider fixtures for input setup. Its own agent executes the station, emits the native-format events and supplies the citations. The driver invokes the scorer exclusively through `freeze`, `run` and `replay` subprocesses in disposable homes. It compares the archived runner's output byte for byte after removing the original synthetic installations and publication homes.

```sh
python3 -B scripts/w11-prospective/blackbox.py
reference_dir=$(mktemp -d)
git archive 3c338502 scripts/w11-prospective | tar -x -C "$reference_dir"
python3 -B scripts/w11-prospective/blackbox.py --runner "$reference_dir/scripts/w11-prospective/protocol.py" --expect 3c338502
```

| Synthetic observation | `3c338502` | Candidate on `fbf0969a` |
|---|---|---|
| Unrelated editions, then a predecessor inserted into the SQLite body with its digests retained | Initially refused, altered edition admitted | Both refused |
| Foreign assistant text before a result reporting $0.01 | Within cap, 3 reservations totaling 225¢ | Unknown, 1 reservation of 75¢, later launches blocked |
| Exact task result, citation to failed signature followed by successful retry | Failed and successful calls both count | Failed call unobserved, cited successful retry observed |

### Formal experiment status

The original process pair passed live recall on November 20 and its archived report still replays byte for byte. Its live profiles were absent at the November 21 recheck. See the [original process admission record](receipts/2026-11-20-process-admission.md).

On November 21, 2026, installed AFK `0.2.188` qualified a replacement synthetic process pair through validation, publication preparation, and publication. The new publication supersedes the old one. Two retained freezes bind the same committed old and new editions for environment, repair, and process.

| Freeze | SHA-256 of `lock.json` | Provenance |
| --- | --- | --- |
| Three-group admission | `1cc75010470331fad01d322fa8eba39bef42f778a54cdd0ca2764f30d929bc92` | Frozen from `combined-spec.json`. The admission `qualification.json` records this digest, and the workspace-reuse evidence bundle contains a copy of this queue. |
| Three-group adoption | `9ba49f8c6a6be51828069a860faa01673e48a5cdd981169cdaf43bb5fda04230` | Frozen from `adoption-spec.XXXXXXXX.json`. The frozen runner and station match commit `1fd5d68440797a3394001eb64631c82ca2020bf9` byte for byte. |

The adoption freeze adds a quotation and action sequence for each of the six editions. Only `config.json`, `protocol.py`, and `station.py` differ between the two locked manifests. Offline station replay exercised all six rules for both parcels and distinguished the old three-step process from the new two-step route. The retained live recheck passed all nine recall checks, with 0 results for `none` and 1 each for `old` and `new` in every group. Admission and recheck made zero model calls.

The independent November 22, 2026 (Asia/Shanghai) `check-live` receipt for the frozen adoption runner records archive and tool verification, healthy recall for all nine group × arm lookups, and zero model calls. Receipt SHA-256 is `b7b60913a093d783fc2fdcf2513ba3f1be8f866253164b4026022cfb15fb0d11`.

On November 22, 2026, the supplemental `process-06` run used the installed AFK `0.2.190` macOS arm64 release and the archived deterministic harness patch `reused-workspace-test.patch` (SHA-256 `487d7291f141144a24ad0b8afa89e2620bcaa0292b0ef8eb2619e107461c7c50`). The product CLI validated and published a separate synthetic process edition. Managed execution checked recall before starting each adapter. The offline Claude Code and OpenCode adapters started in two distinct work items in the same workspace and each received the same publication and candidate version. After product reconciliation withdrew the edition, a third work item reused the workspace. Startup removed the stale context before the Claude Code adapter ran, and the adapter observed no context or station commands. The harness made zero model calls. The private evidence bundle retains `consumer-receipt.json` under SHA-256 `9835c67802d0c3596a9ce02a55d674ccdef04c8a80ec3bf7c61ff0af9f531f22`.

Both prospective freezes replay with **18 pending seats**, zero completed comparisons, and **0¢ reserved**. The frozen cap is **0¢** and no positive formal budget is recorded. Formal measurement requires a fresh freeze with an authorized cap and a matching `run` allowance. At **75¢** per seat, a three-arm sample requires **225¢** in reservations and all 18 seats require **1,350¢**. The supplemental offline run contributes zero formal seats.
