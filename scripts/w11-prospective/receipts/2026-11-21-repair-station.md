# W11 prospective repair fixture, November 21, 2026 (Shanghai)

The repair fixture uses the synthetic `W11-101` and `W11-202` command sequences from the archived AFK 0.2.135 comparison. Both archive replayers exited 0 under Node 24.18.0. In each archived repeat both arms passed their original checker. The `none` arm took 11 station commands with recurrence and the `new` arm took 5 without recurrence. The archived time savings were 41,889 ms and 30,006 ms respectively. Both plans have `old: null` and bind `new` to `de416aa6-5e06-4d87-8894-cf33eabf8556` with verification digest `bb80de76fb159b572c09613b314b074352963d2e60d40f5b2ea7b6a1b88a9bb7`.

The fixture runs the same command sequences against the prospective station at `22a169f144585a0feb74d9a2e1f94f58ea06d7ed`. All four command arrays matched the archived journals. Both archived sequences end with a single successful print and fail the prospective checker. Two synthetic controls append a second print. A third follows the same margin detour without correcting the pitch. All ten checks passed under Python 3.13.7. The measured pitch and initial driver settings were 104/100 mm for `W11-101` and 84/80 mm for `W11-202`.

| Fixture, each parcel | Print offsets in mm | Task passed | Recurrence | Commands |
| --- | --- | --- | --- | ---: |
| Archived `none` | 4, 4, 4, −8, 0 | No | Yes | 11 |
| Archived `new` | 0 | No | No | 5 |
| Detour, calibrate, and confirm | 4, 4, 4, −8, 0, 0 | Yes | Yes | 12 |
| Calibrate directly and confirm | 0, 0 | Yes | No | 6 |
| Layout-only control | 4, 4, 4, 8 | No | Yes | 7 |

The prospective protocol regression passed 18/18 tests. This repair run made zero model calls and reserved 0¢. Six repair seats remain awaiting two independently validated, committed `wiki:label-offset` editions with a verified predecessor link and exact live recall under the frozen repair query. The fixture records station behavior for both task parameters. Formal `old` and `new` assignments require the product publication and checker receipts.

## Reproduce

Run the fixture and regression from the checkout root.

```sh
python3 -B scripts/w11-prospective/fixtures/repair-station.py
python3 -B -m unittest discover -s scripts/w11-prospective -p 'test_*.py' -q
```

The fixture's ten JSONL records have SHA-256 `46ffae3877f63ed2b5fd580fc4d43c61c91caeb44f96b8a49b2e688ba9e03697`.

The historical archives reside under the source checkout's `.codex/validation/request-lifecycle-20261118/fact-01-worker/`. Check these SHA-256 digests and extract each archive to its own fresh directory. Run the corresponding command from that extraction root.

```text
3360148e18fd51b50b8de416084011a637d2cb431bbfa48ab8ec97f57c64350a  benefit-repair-135/repair-repeat1.tar.gz
25a9be2f598214cbf6775554c4f00a480c80d54605e013f077d21f09cb3d8cca  benefit-repair-repeat2-135/repair-repeat2.tar.gz
```

```sh
node tests/fixtures/w11/benefit-repair/replay.mjs evidence-w11-benefit-repair
node tests/fixtures/w11/benefit-repair/repeat2-replay.mjs evidence-w11-benefit-repair/repeat2
```
