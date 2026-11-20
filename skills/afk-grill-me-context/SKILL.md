---
name: afk-grill-me-context
disable-model-invocation: true
description: >-
  Clarify ambiguous requirements through structured human-AI dialogue.
  Converts vague, ambiguous, or incomplete context into concrete, executable
  understanding by identifying gaps and resolving them via targeted questions.
  Output: verified CONTEXT.md in /tmp/.
disallowed-tools: >-
  Edit(*) Agent(*) Task*(*)
  Bash(git push -f) Bash(git merge*) Bash(git reset --hard*)
  Bash(git branch -D*) Bash(docker*) Bash(rm -rf*) Bash(chmod*)
  Bash(chown*) Bash(mkdir*)
---

# Grill-me with Context

## Core Goal

**Problem:** User provides context that is vague, ambiguous, incomplete, or contains terms/assumptions the LLM cannot safely interpret.

**Solution:** Structured human-AI dialogue that:
1. Identifies what's unclear, ambiguous, or missing
2. Asks targeted questions with concrete options
3. Converts fuzzy information → verified, executable understanding

**Output:** Confirmed CONTEXT.md written to `/tmp/` — no repo pollution.

## When to use

Use when the user's input contains:
- Ambiguous terms that could mean multiple things
- Missing critical details needed for implementation
- Assumptions that need verification
- Incomplete specifications
- Technical decisions not yet made
- Domain concepts the LLM shouldn't guess about
- **Contradictions between user's description and existing docs/code**
- **References to "existing context" without specifying where it is**

Do NOT use for:
- Crystal-clear requirements (just implement)
- Simple yes/no clarifications (ask directly)
- Context that already exists in code/docs and is unambiguous (read it)

## How it works

### Step 1: Analyze ambiguity

**Gather context from all available sources:**
- User's verbal description (the prompt/args)
- **Any referenced documents** — if user mentions files, specs, tickets, or "the docs", read them
- **Related code** — when user references components, features, or behavior, read the implementation
- **Project context files** — check for relevant documentation in the repo (root docs, inline docs, config files)
- **Prior context** — if user points to existing context documents, read them

**Discovery strategy:**
- If user says "according to [file]" or "see [path]" → read it
- If user mentions a component/feature name → search and read relevant code
- If topic relates to architecture/design → look for ADRs, design docs, diagrams
- If requirements are vague → check for product docs, tickets, or planning materials
- When in doubt about what exists → use search/grep to find relevant content

**Read to:**
- Verify user's statements against written sources
- Find existing definitions that clarify ambiguous terms
- Identify contradictions between what user said and what sources say
- Surface gaps where sources are silent but user expects you to know

**Identify what's:**
- **Ambiguous** — could mean A or B or C (user or sources use vague terms)
- **Missing** — needed for implementation but not in any source
- **Assumed** — user/sources assume you know, but you shouldn't guess
- **Conflicting** — user says X, docs say Y, code does Z

If nothing is unclear → STOP (no need for this skill).

### Step 2: Ask structured questions

For each ambiguity/gap, use `AskUserQuestion` with concrete options:
- Options must be **specific and comparable** — not "improve UX" vs "keep it simple"
- Use `multiSelect: true` when choices can coexist, `false` when mutually-exclusive
- Add `preview` when comparing code/config/diagrams/timing clarifies the choice
- Frame questions around **decisions to make**, not facts to confirm

**When using documents as evidence:**
- Quote relevant excerpts in `description` or `preview` to show the conflict/gap
- Construct options that resolve the conflict: "User is right, doc outdated" vs "Doc is right, user misremembered" vs "Both valid for different contexts"
- Use preview to show: user's statement | doc's statement | code's behavior

Example question patterns:
- **Ambiguity:** "Which approach?" — show implementation options
- **Missing:** "What's the scope?" — show boundary options  
- **Conflict:** "Doc says X, you said Y — which is current?" — show resolution options
- **Assumption:** "What does [term] mean here?" — show interpretation options with doc references

### Step 3: Draft verified context

Show the clarified context document with:
- **Pre-existing** — what the user originally provided
- **Clarified** — what was resolved through questions
- **Open questions** — what remains unresolved (if any)

Mark sections clearly so the user sees what changed.

### Step 4: Confirm before writing

Use `AskUserQuestion` with 4 options:
1. **Approve** → write to `/tmp/grill-me-context-<timestamp>.md`, end
2. **Revise** → you spotted an error, return to Step 3
3. **Drill deeper** → still has gaps, return to Step 2
4. **Add open question** → document something unresolved, then write

Use `preview` to show what happens next for each choice.

### Step 5: Write to /tmp/

After approval, write using Bash: `cat > /tmp/grill-me-context-<YYYYMMDD-HHMMSS>.md << 'EOF'`

Never use Write tool (requires prior Read). Never write to repo.

## Constraints

**HITL enforcement:**
- Every decision point MUST use `AskUserQuestion` — never plain-text lists
- Questions must have 2-4 concrete, comparable options
- No writing without Step 4 approval

**Ambiguity resolution:**
- Don't guess what the user means — ask
- Don't assume domain knowledge — verify
- Don't infer unstated requirements — surface them
- When docs exist but are ambiguous, ask which interpretation is correct
- When user and docs conflict, present both and ask which is current

**Document usage priorities:**
- **Code is ground truth** — when code contradicts docs/user, surface the conflict
- **Written specs > verbal description** — but always verify if specs seem outdated
- **Recent docs > old docs** — check file timestamps when multiple sources conflict
- **User clarification > stale docs** — after confirmation, note doc needs update

**Output discipline:**
- Write only to `/tmp/grill-me-context-<timestamp>.md`
- Use Bash for writing (not Write tool)
- Never skip the confirmation gate
