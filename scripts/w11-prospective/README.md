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

Fill in `node`, `cli` (installed `dist/index.js`), `agent`, `perSlotCents`, `totalCents` and the groups with available pairs. A `null` group registers six missing slots. The example shows the value of `groups.process`. Use the scenario's exact `PROMPTS` text, logical target, applicability and page paths from its actual releases for the other groups.

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

Choose commands that distinguish the edition's advice for both parameters. The final response cites the delivered origin, exact passage and one-based station steps. `observed` binds that claim to matching actions and reports their native tool IDs, even when the final task answer is wrong. With a registered rule and no matching citation the result is `unobserved`. An edition without a rule is `unregistered`. `none` is `inapplicable`. Use the AFK product receipt for product-level adoption.

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

The archived prospective queue froze a total of **0¢**, a per-seat ceiling of **75¢** and zero admitted edition pairs. At that ceiling a three-seat group requires **225¢** of authorized reservations. The process producer's archived audit records one distillation call allowed per UTC day, its reservation consumed on 2026-11-19, and a correction marked `budget_exhausted` with zero attempts. Its first eligible retry time was 2026-11-20 00:00 UTC. That timestamp describes the producer quota only. A formal run still requires independently validated committed editions, authorized source access and positive recall for each edition, plus explicit authorization for the model and the experiment spend. The synthetic checks used zero paid calls and occupied zero formal seats.
