# Terminal Coding Agent Comparison: Claude Code / Codex CLI / opencode

> Snapshot: **2026-10-20**
> Tool versions: `codex-cli 0.163.0` · `Claude Code 2.1.300` · `opencode 1.18.31`
> Method: targeted probing of native local binaries + local session-log aggregation + external controlled experiments
> Scope: the causal chain here is deliberately **tool-layer (harness)** evidence. Model capability is background only.

---

## 0. Summary

Five findings, each backed by evidence reproducible on this machine:

1. **"Claude Code is faster" is not one phenomenon** but a sum of three independent variables: single-turn physical speed, convergence (attempts per error), and the default breadth of verification. The third is the most overlooked and often accounts for most of the gap.

2. **The tool layer has exactly one dominant axis: how many round trips a task needs, and how much deterministic leverage the harness gives the model per round trip.** Claude Code routes 21.0% of calls to dedicated structured tools (Read / Edit / Write). Codex routes 100% through shell — even reading a file means hand-assembling `sed`.

3. **Codex needs substantially more round trips per task**: median 13.1 vs 5.0, mean 24.8 vs 6.8, p90 36.0 vs 14.0.

4. **Codex's "multiple reviews" are real and quantifiable**: verify-to-edit ratio 1.9:1 (Claude Code 0.9:1), plus 943 `write_stdin` calls of which 924 are **empty-input polls** of a live process — pure waiting, each one a full model round trip.

5. **Codex resists drift on long tasks, and the mechanism is directly measurable**: only **0.9%** of Codex's context is re-fed model self-narration, versus **15.1%** for Claude Code. Claude Code's thinking blocks carry Anthropic API signatures and are **forcefully re-sent every turn**; Codex's `raw_content` is always `[]`, and full reasoning lives only in the event log. **Re-fed narration is the carrier of drift.**

---

## 1. Evidence and method

### 1.1 Local tool-surface probing

Targeted string probing of the three native binaries (rather than a full `strings` dump):

| harness | binary size | probe |
|---|---|---|
| Claude Code | 250 MB | `bytes.find` on `claude.exe` |
| Codex | 250 MB | `bytes.find` on `codex` |
| opencode | 144 MB | `bytes.find` on `opencode.exe` |

> **Methodological limit**: a string in a binary proves the identifier exists, not on its own that it is exposed to the model as a tool. The three sets are internally coherent and include explicit `*Tool` suffixes (`GlobTool`, `SlashCommandTool` / `AgentTool`, `ApplyPatchTool`, `ShellTool`), so the conclusions are trustworthy — but this remains **indirect evidence**, not official API documentation.

### 1.2 Local session-log aggregation

| harness | source | sample |
|---|---|---|
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | 97 sessions / 276 tasks / 6833 calls |
| Claude Code | `~/.claude/projects/*/*.jsonl` (excluding `subagents/`) | 157 sessions / 2085 user inputs / 14082 calls |

Only **counts, tool names, command head verbs, content-block types and byte volumes** are aggregated. No conversation text is read or retained.

### 1.3 External controlled experiments

| source | sample | purpose |
|---|---|---|
| [Builder.io](https://www.builder.io/blog/opencode-vs-claude-code) | same model (Sonnet 4.5), fresh Docker, 4 tasks | isolates the harness |
| [Respan](https://www.respan.ai/blog/tracing-claude-code-and-codex-traced) | 30 tasks × 3 runs, full OTel traces | planning / tool / recovery behaviour |
| [SyFI TraceLab](https://tracelab.cs.washington.edu/exp/llm_generation/context_decode_speed_scatter) | 665,453 real agent steps | physical throughput and TTFT |
| [AgentsRoom](https://agentsroom.dev/blog/measure-claude-code-tokens-per-second/) | 20,408 turns / 12M output tokens | per-turn speed decomposition |

---

## 2. Three working modes (behaviour layer)

### 2.1 Claude Code — front-loaded planning

On multi-file tasks it spends 2,000–4,000 tokens planning before the first file read. The trade is explicit:

- Median time to first edit is **12 seconds slower** than Codex
- Median revisions to the same file are **40% lower**
- Reads 8.2 files before the first write on average (14 on refactors), plus 3–5 structural greps
- Resolves an error in **1.3 attempts** on average (Codex: 1.8)

The author's summary is exact: **"It thinks more, backtracks less."**

### 2.2 Codex CLI — reactive iteration

Read → change → read → change. Each individual attempt is faster, but fixes tend to address symptoms, and fix chains compound. It uses fewer input tokens (12,100 vs 18,400) and more output tokens (5,800 vs 4,200) — ~20% fewer total tokens, yet a **faster median wall clock: 41s vs 48s**.

**Claude Code's advantage is not the average; it is the tail:**

| metric | Claude Code | Codex |
|---|---|---|
| median wall clock | 48s | **41s** |
| **p90 wall clock** | **78s** | 94s |
| completion within 3 min | 83% | 79% |
| ├ multi-file | **87%** | 74% |
| └ single-file | 90% | **91%** |

### 2.3 opencode — verification-first

Native Build / Plan mode separation (Tab), plus Debug / Review / Docs. Connects real language servers (gopls / typescript-language-server / pyright / rust-analyzer) and feeds back real diagnostics after every edit. MCP tools are assigned per agent via glob patterns.

**The cost is a fixed tax on every run.** Builder.io ran identical tasks with the same Claude Sonnet 4.5, fresh Docker, no prior configuration:

| task | opencode | Claude Code | winner |
|---|---|---|---|
| bug fix (planted type error) | 41s | 40s | tie |
| refactor (extract shared helper) | **40s** | 2m10s | opencode |
| cross-file rename | 3m13s | 3m06s | near tie |
| test writing | 9m11s (94 tests) | **3m12s** (73 tests) | Claude Code |
| **total** | 16m20s | 9m09s | Claude Code |

**The entire "much faster" gap sits in the test-writing row.** Opening up those nine minutes:

> opencode ran `pnpm install` to ensure dependencies were fresh, then executed the *entire* test suite to guarantee no regressions. It wrote 94 test cases and confirmed they played nice with the existing 200+ tests.
> Claude Code optimized for velocity. It wrote 73 tests, verified that *those* tests passed, and called it a day without running the full suite.

So most of the stopwatch gap is quality assurance opencode performed on your behalf. **That gap belongs on opencode's ledger, not in an "inefficiency" column.**

### 2.4 The physical layer: what decode speed really is

From TraceLab's 665,453 steps:

- Claude's binned median normalized decode speed holds near **54–58 tok/s**, sagging to ~48 tok/s only at ~740k input tokens
- Codex slopes more steeply: ~40–41 tok/s at 12k–23k input, dropping to **~28 tok/s** near 185k; decomposed, pure decode falls 74→55 tok/s while residual TTFT rises 1.5s→2.8s

AgentsRoom's 20,408 turns explain why tok/s ≠ completion speed:

- Every turn pays a fixed pre-first-token cost: ~1s on Opus 5/5.5, ~0.5s on Sonnet 5
- Hence an **80-token reply measures only 40 tok/s while a 3,000-token reply exceeds 80 tok/s** — streaming speed is constant; short answers are just amortized over a fixed overhead
- **Prompt caching does not speed output**: 60.6 vs 58.0 tok/s cache-hit vs miss, 3.4s vs 3.7s per turn. Caching changes what context costs, not how fast it arrives
- Thinking tokens count as output: 30% of Opus 5 output, 18% of Opus 5.5, **54% of Sonnet 5** — "a turn that thinks for a long time is not slow; it is generating tokens you cannot see"

> **Caveat**: all model names and speeds above belong to the **model layer**. They are background here and are not used to explain harness differences.

---

## 3. The tool layer: harness structure

### 3.1 Tool surfaces

| harness | confirmed tool surface |
|---|---|
| **Claude Code** | `Read` `Write` `Edit` `MultiEdit` `NotebookEdit` `NotebookRead` `Glob` `GlobTool` `Grep` `WebFetch` `WebSearch` `TodoWrite` `Task` `Agent` `Skill` `SlashCommand` `SlashCommandTool` `AskUserQuestion` `ExitPlanMode` `Bash` `BashOutput` `KillShell` `TeamCreate` `SendMessage` `ScheduleWakeup` `Workflow` `TextEditor` `ListMcpResources` `ReadMcpResource` `View` |
| **Codex** | `ShellTool` `ApplyPatchTool` `PatchTool` `AgentTool` `unified_exec` `apply_patch` `view_image` `web_search` `update_plan` `write_stdin` `read_file` `move_file` `spawn_agent` `send_input` |
| **opencode** | `read` `write` `edit` `patch` `bash` `glob` `grep` `list` `webfetch` `websearch` `todowrite` `task` `skill` `lsp` `diagnostics` |

**Codex does not contain `ReadFileTool`, `GrepTool`, `GlobTool`, `ListDirTool`, `WriteFileTool`, `EditTool` or `TodoWrite`.**

That is: Codex has **no dedicated read, search, list, edit or todo tool**. Repository exploration must go through the shell.

### 3.2 Consequence: round trips

| | sessions | user tasks | tool calls | median/task | mean | p90 | max |
|---|---|---|---|---|---|---|---|
| **Codex** | 97 | 276 | 6833 | **13.1** | **24.8** | **36.0** | 69.8 |
| **Claude Code** | 157 | 2085 | 14082 | **5.0** | **6.8** | **14.0** | 47.2 |

### 3.3 The real source of the gap: composition, not count

**Codex tool mix (6833 calls)**

```
exec_command    5252   76.9%
write_stdin      943   13.8%   ← 90.7% total in shell
js               205    3.0%
view_image       117    1.7%
wait_agent        92    1.3%
send_input        63    0.9%
spawn_agent       42    0.6%
close_agent       38    0.6%
update_plan       31    0.5%
```

**Claude Code tool mix (14082 calls)**

```
Bash            9885   70.2%
Read            1426   10.1%   ┐
Edit            1246    8.8%   ├ dedicated read/write tools: 21.0%
Write            285    2.0%   ┘
Agent            257    1.8%
MCP family        652    4.6%
```

**What Codex actually executed (head verb of 5252 `exec_command` calls):**

```
 837  15.9%  sed        ┐
 678  12.9%  rg         │
 536  10.2%  cat        ├ read/browse 47.8%
 218   4.2%  nl         │
 112   2.1%  find       │
 128   2.4%  tail       ┘
 564  10.7%  apply_patch   ← edits, and via shell, not a dedicated tool
 438   8.3%  git        ┐
 106   2.0%  gh         ┘ version control 10.3%
 270   5.1%  pnpm        ┐
 250   4.8%  node        ├ build/test 9.9%
```

**Read-to-write ratio is about 4.5:1.**

> **Worth noting**: `apply_patch` exists in Codex, yet across 276 tasks it was **never invoked as a tool call** — all 564 appearances are shell commands inside `exec_command`. Even the edit path costs Codex one extra shell layer.

**Claude Code Bash head verbs (9874 calls)**: `cd` 24.1% / `grep` 13.3% / `git` 8.3% / `python3` 5.3% / `ls` 4.6% / `echo` 3.3% / `cat` 2.9% / `sed` 2.3% / `pnpm` 2.2% / `curl` 2.1%

### 3.4 "Multiple reviews" — quantified

| | verification-class calls | edit-class calls | ratio |
|---|---|---|---|
| **Codex** | `node`+`pnpm` 520, `git`+`gh` 544 = **1064** | `apply_patch` **564** | **1.9 : 1** |
| **Claude Code** | `git`+`gh`+`pnpm`+`curl` 1440 | `Edit`+`Write` **1531** | **0.9 : 1** |

Add Codex's unique **943 `write_stdin` calls, 924 of which are empty input (98%)** — that is not "writing to a process", it is **repeatedly empty-polling a still-running process**. Each empty poll is a full model round trip (upload request → model generation → tool return). **That is 13.8% of all Codex calls, and 100% of it is pure waiting.**

> Claude Code has no equivalent mechanism — its `Bash` is blocking, and returns when the command finishes.

### 3.5 The permission model is a multiplier on every human round trip

Codex's binary contains **per-tool-type** approval channels, readable directly:

```
command execution approval is not supported in exec mode for thread ...
apply_patch approval is not supported in exec mode for thread ...
request_user_input is not supported in exec mode for thread ...
permissions approval is not supported in exec mode for thread ...
```

Combined with a default sandbox and **network off**, the consequence is that every `npm install`, `git fetch` or `curl` is a separate escalation.

By contrast:
- **Claude Code** — permission modes first (ask once per tool, then remember) + `--allowedTools` + `--dangerously-skip-permissions`
- **opencode** — ordered rulesets, last matching rule wins, **defaults to `ask`**, with `--auto` to allow everything at once

**Without a switch that fully disables human confirmation, there is no "fast" — only "waiting for a human."**

### 3.6 Startup fixed cost

Claude Code's `--bare` flag exposes what a normal startup actually does — it skips precisely:

> hooks (those defined in settings and by installed plugins), **LSP**, plugin sync, attribution, auto-memory, **background prefetches**, keychain reads, and CLAUDE.md auto-discovery

So a normal startup runs LSP + plugin sync + background prefetch + keychain reads + multiple memory layers. opencode starts an LSP client per session. Codex's 250 MB binary statically includes `rg` (4 MB) and `codex-voice-host` (10 MB, with gstreamer) — startup-time dynamic-linking cost regardless of use.

### 3.7 Fan-out: the gap is now essentially closed

| capability | Claude Code | Codex | opencode |
|---|---|---|---|
| subagents | `Task` / `Agent` (own context window) | `AgentTool` / `spawn_agent` / `send_input` | `task` |
| cross-agent messaging | `TeamCreate` + `SendMessage` | daemon-level `agents` subcommand | — |
| background sessions | `--background` + `claude agents` | `fork` / `queue` | `serve` / `attach` / `web` |
| remote driving | `--cloud` | `remote-control` | mDNS service discovery |
| structured orchestration | `Workflow` / `ScheduleWakeup` | — | — |

opencode pioneered server-side sessions; the three are now roughly at parity. **Claude Code's remaining real increment is `Workflow` / `ScheduleWakeup` / `TeamCreate` — not "can it parallelize" but "can it orchestrate parallelism."**

---

## 4. Why Codex resists drift on long tasks

> **Framing caveat**: drift itself cannot be measured directly from logs (it requires semantic labelling). This section measures the **structure that predicts drift**. The observation that "Codex does not drift, Claude Code does" is field experience; what follows is a concrete mechanism compatible with it, plus falsifiable predictions.

### 4.1 Mechanism: re-fed self-narration

Drift means the context diverges from the task goal. Context is made of two kinds of material:

- **Facts** — what the repository currently looks like. Immutable.
- **Narration** — the model's own prior reasoning and prose. Mutable, and **self-reinforcing**.

Re-feeding narration causes drift in three compounding ways:

1. **Residual hypotheses** — a hypothesis written into the context ("the bug is in the config loader") is re-weighted on every subsequent turn. The model does not "know" it was disproved; it only sees the sentence sitting there amid newer content.
2. **Narrative momentum** — extended thinking is written in a first-person, forward-moving register ("I need to…, so let me…"). Re-reading it makes continuing that narrative feel natural, while returning to the original task feels like a detour.
3. **Monotone accumulation** — each turn adds narration to a context already rich in narration. The ratio of "what the agent thinks it is doing" to "what is actually true" rises monotonically until a tool result resets the facts — **but it cannot reset the story.**

### 4.2 Measured: context composition of the two harnesses

| source | Codex (180.4 MB) | Claude Code (82.7 MB) |
|---|---|---|
| tool output (facts) | `function_call_output` 38.8% + `CommandExecution` 35.4% | `tool_result` **71.5%** |
| tool call arguments | `function_call` 3.5% | `tool_use` **11.0%** |
| injected instructions (system / AGENTS.md) | `message` 6.0% (role=developer/user) | `user_text` 2.4% |
| **re-fed model narration** | `item:Reasoning` 0.6% + `item:AgentMessage` 0.3% | `thinking` **12.9%** + `text` **2.2%** |
| **total narration share** | **0.9%** | **15.1%** |
| full reasoning in event log (never re-fed) | `reasoning` 12.5% (mean 3839 chars) | — |

**A ~17× difference.**

### 4.3 Why Claude Code necessarily re-feeds

Claude Code's thinking blocks carry a **64-hex `signature`**:

```json
{ "type": "thinking", "thinking": "Let me understand the task:...", "signature": "399b1ba2217854bff..." }
```

The Anthropic API requires prior turns' thinking blocks to be **re-sent verbatim** (the signature must remain valid). Therefore:

- thinking block length: median 618 / mean 1297 / p90 2986 chars
- re-fed narration per turn: median 338 / mean **938** / p90 **2233** bytes

Codex's corresponding structure:

```json
{ "type": "Reasoning", "id": "rs_01c8e9...",
  "summary_text": ["**Clarifying task requirements**\n\nI need to focus on..."],
  "raw_content": [] }
```

- `raw_content` is **always `[]`** — full reasoning never enters the context
- `summary_text` median length is **2 characters** (mostly empty), mean 70
- The full reasoning (mean 3839 chars) exists only in `event_msg.reasoning` — the **event log**, for display and telemetry

**Codex cleanly separates "thinking" from "leaving a trace": think, discard, keep only actions and facts. Claude Code keeps the thinking too.**

### 4.4 Second mechanism: a harness-injected narration channel

Claude Code also has a class of injected content Codex lacks — **written by the model or a hook, but treated as authoritative context**:

| injection type | count | volume |
|---|---|---|
| `isMeta` injected messages | 340 | 1864 KB (of which 145 text blocks = 1502 KB) |
| `stop_hook_summary` | 583 | 549 KB |
| `away_summary` | 251 | 158 KB |
| `compact_boundary` | 27 | 31 KB |
| **total (deduplicated)** | 1201 | **2602 KB (~2.54 MB)** |

`away_summary` is the sharpest case: **when you return after being away, the harness hands the agent its own summary of the gap.** If that summary is off, the agent continues from a wrong state — and never notices, because **that summary is the context**.

### 4.5 Third mechanism: different source material for compaction

| | Claude Code | Codex |
|---|---|---|
| sessions with compaction | 27/150 (18%) | 16/97 (16.5%) |
| trigger | `auto`, observed preTokens 166,979 / 187,178 / 238,751 / 270,375 / 316,463 / 368,389 | `compacted` event carrying `replacement_history` / `message` / `window_number` |

**Compaction frequency is similar; the source material is not.** Claude Code summarizes "15% narration + 71.5% facts"; Codex summarizes almost pure fact. The former's summary is a **story**; the latter's is a **state manifest**. Stories get rewritten, softened, and can drop the original task in the summary; state manifests do not.

### 4.6 Ruling out a competing hypothesis

A natural alternative is "Claude Code thinks more, so it drifts more." The data points the other way:

- **Run length** — Codex performs a median of **13.1** tool calls per task; Claude Code a median of **5.0** per input. **Codex's autonomous stretches are longer, yet it drifts less.** If drift were driven by "too many consecutive actions", the prediction would reverse.
- **Todo-list rewriting** — a common hypothesis is that the model rewrites the todo list to match its current behaviour, hiding the drift. **Not supported**: across 150 sessions `TodoWrite` was called exactly **once**. This mechanism does not exist in this workflow.

### 4.7 Falsifiable predictions

If the mechanism holds, we should observe:

1. **Lowering Claude Code's auto-compact window should measurably reduce drift** — earlier compaction means the summary is drawn from less accumulated narration. `--autocompact` accepts `auto` or a `100k–1M` token value, so the knob already exists.
2. **Restating the goal by hand during a long task should outperform a harness-generated summary** — the former is a fact, the latter is a story.
3. **Codex's drift rate should be insensitive to reasoning length** — because reasoning is not in the context at all.

Prediction 1 is the easiest to test and should be done first.

### 4.8 Mitigations (Claude Code side only)

| mitigation | basis |
|---|---|
| `--autocompact 100k` (below default `auto`) | summary drawn from less accumulated narration |
| manual `/compact` at task boundaries | same, but under your control |
| restate the goal by hand between long autonomous stretches | a fact instead of a harness-written story |
| push exploratory work into subagents | main context stays facts-only (Claude Code's Agent tool has an isolated context) |
| `--bare` for short tasks | skips hooks (fewer `stop_hook_summary` injections), LSP, plugin sync, background prefetch, keychain |

---

## 5. Selection guidance

| scenario | pick | why |
|---|---|---|
| multi-file changes | Claude Code | front-loaded planning + first-try rate (multi-file 87% vs 74%) |
| read-heavy exploration | Claude Code | 21.0% of calls routed to dedicated read/write tools; about half the round trips |
| single-file, well-scoped bug | Codex | short preamble, faster median wall clock (41s vs 48s) |
| iteration with a clear reproduction | Codex | cheap reactive loop |
| refactoring a high-coverage module | opencode | LSP diagnostics + full verification; the extra time goes almost entirely to verification (test writing 9m11s vs 3m12s) |
| need to switch provider / local models | opencode | 75+ providers; neither Claude Code nor Codex supports this |
| data residency / private endpoints | opencode | direct Bedrock / Azure / Ollama |
| unattended pipelines | disable human confirmation in all three | `--dangerously-skip-permissions` / `--auto` / Codex approval allowlist |
| long autonomous runs, drift-sensitive | Codex | only 0.9% narration re-fed |

---

## 6. Limitations and unverified items

1. **Drift was not measured directly.** This report measures the structure that predicts it; the drift rate itself would need manual annotation or LLM-as-judge.
2. **Task units are not strictly comparable.** Codex's `task_started` (2.8 per session) and Claude Code's user inputs (13.3 per session) differ in granularity; the latter mixes in many short follow-ups that depress the median. Treat "13.1 vs 5.0" at a 30% discount. **The tool-composition difference is unaffected** — it is a ratio within each harness.
3. **Binary string probing is indirect evidence.** See §1.1.
4. **Timeliness of the external experiments:**
   - Builder.io used Sonnet 4.5, one repo, a single run per task, n=4, no repetition
   - Respan traces were collected in April 2026 on that era's default models
   - opencode version snapshot 1.18.31; release cadence is fast
5. **The 5.94 GiB single-file SQLite** (`opencode.db`) and 7.8 GB total for `~/.local/share/opencode` plausibly relate to opencode's startup latency and memory use, but **startup time was not measured — treat as unverified**. Comparators: `~/.claude` 1.6 GB, `~/.codex` 4.5 GB.
6. **Sample skew.** The local data comes from an afk-loop orchestrated workflow; task shapes differ from everyday development.

---

## Appendix A: reproduction

### A.1 Tool-surface probe

```bash
python3 - <<'PY'
import os
targets={
 "CLAUDE CODE":("~/.nvm/versions/node/v24.18.0/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
   ["Read","Write","Edit","MultiEdit","Glob","Grep","TodoWrite","Task","Agent","Skill"]),
 "CODEX":("~/.nvm/versions/node/v24.18.0/lib/node_modules/@openai/codex/node_modules/"
          "@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex",
   ["ShellTool","ApplyPatchTool","AgentTool","read_file","apply_patch",
    "ReadFileTool","GrepTool","GlobTool","EditTool","TodoWrite"]),
}
for name,(p,cands) in targets.items():
    data=open(os.path.expanduser(p),'rb').read()
    print(name, "FOUND :", [c for c in cands if data.find(c.encode())>=0])
    print(name, "ABSENT:", [c for c in cands if data.find(c.encode())<0])
PY
```

### A.2 Codex round trips and tool mix

```bash
python3 - <<'PY'
import json,glob,collections,statistics as st
files=sorted(glob.glob("~/.codex/sessions/2026/*/*/*.jsonl"))
per=[]; names=collections.Counter()
for f in files:
    tasks=calls=0
    for line in open(f,errors="ignore"):
        try: o=json.loads(line)
        except: continue
        p=o.get("payload") or {}; t=p.get("type")
        if t=="task_started": tasks+=1
        elif t=="function_call": calls+=1; names[p.get("name")]+=1
    if tasks>0: per.append((tasks,calls))
r=sorted(c/t for t,c in per)
print(f"codex sessions={len(per)} calls={sum(c for _,c in per)} "
      f"median={st.median(r):.1f} mean={sum(c for _,c in per)/sum(t for t,_ in per):.1f}")
print(names.most_common(12))
PY
```

### A.3 Context composition comparison

Claude Code: `~/.claude/projects/*/*.jsonl` (excluding `subagents/`), aggregating JSON-serialized bytes over `type=assistant` content blocks (`thinking`/`text`/`tool_use`) and `type=user` `tool_result`.

Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, aggregating by `event_msg` payload type and `response_item` `item.type`.

Key verification points: whether Claude Code's thinking blocks carry `signature` (which forces re-sending), and whether Codex's `item:Reasoning.raw_content` is empty (which keeps reasoning out of the context).

---

## References

- [Builder.io — OpenCode vs Claude Code](https://www.builder.io/blog/opencode-vs-claude-code)
- [Respan — Tracing Claude Code and Codex](https://www.respan.ai/blog/tracing-claude-code-and-codex-traced)
- [SyFI TraceLab — Context vs decode speed](https://tracelab.cs.washington.edu/exp/llm_generation/context_decode_speed_scatter)
- [AgentsRoom — How fast is Claude Code really?](https://agentsroom.dev/blog/measure-claude-code-tokens-per-second/)
- [AICoderScope — OpenCode review 2026](https://aicoderscope.com/blog/opencode-review-2026)
- [Tygart Media — Claude Code vs Codex CLI](https://tygartmedia.com/category/claude-code-insider/claude-code-vs-alternatives)
- [OpenCode docs — Agents](https://opencode.ai/docs/agents/) · [LSP](https://opencode.ai/docs/lsp/)
