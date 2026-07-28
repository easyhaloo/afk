# Hard Checks

Non-negotiable rules. Violating any of these is grounds for immediate
escalation to `mode::hitl` — not a warning, not a retry.

---

## Hard Rules

### HC-1: No secret in any commit

A secret (API key, token, password, private key, credentials in plain
text) that lands in any WIP commit is **unrecoverable**. Git history
retains it even after a subsequent "fix" commit.

**Rule:** Do not read files outside `.env.fork` for credentials.
Do not run commands that echo credentials into commit messages.
If a credential is accidentally committed, treat it as a security
incident — stop, escalate, do not continue the run.

#### Recovery Checklist (HITL)

**Detection:** Issue has `mode::hitl` label + comment mentioning "HC-1 violated"

**Steps:**

1. **Confirm the leak scope**
   ```bash
   cd .worktrees/issue-{iid}
   git log --all --oneline | head -20
   git log --all -p | grep -C3 -i "password\|secret\|token\|api.key\|private.key"
   ```

2. **If secret only in latest commit AND not yet pushed:**
   ```bash
   # Safest: reset commit and re-commit without secret
   git reset --soft HEAD~1
   # Remove secret from files (edit manually or use sed)
   # Example: sed -i '' 's/API_KEY=sk-.*$/API_KEY=***REMOVED***/' .env
   git add -A && git commit -m "fix: remove leaked credential"
   ```

3. **If already pushed, history rewrite required (DANGEROUS):**
   ```bash
   # Backup current state first
   git branch backup-issue-{iid}
   
   # Option A: Interactive rebase (if only a few commits)
   git rebase -i HEAD~5  # Adjust number
   # In editor: change 'pick' to 'edit' for commits with secrets
   # At each stop: edit files, git add, git rebase --continue
   
   # Option B: BFG Repo-Cleaner (for many commits)
   # Install: brew install bfg
   bfg --replace-text <(echo 'PASSWORD=secret123==>PASSWORD=***REMOVED***')
   git reflog expire --expire=now --all
   git gc --prune=now --aggressive
   
   # Force push (will rewrite remote history)
   git push --force-with-lease origin afk/issue-{iid}
   ```

4. **Rotate all exposed credentials (CRITICAL)**
   - API keys → revoke in provider console + regenerate
   - Database passwords → change via `ALTER USER` + update `.env.fork`
   - Private keys → regenerate keypair + update authorized_keys
   - Document in incident log: what was exposed, when, for how long

5. **Prevent future leaks**
   ```bash
   # Add to .gitignore
   echo ".env*" >> .gitignore
   echo "*.key" >> .gitignore
   echo "*.pem" >> .gitignore
   
   # Install pre-commit hook (recommended)
   # brew install gitleaks
   # gitleaks protect --staged
   ```

6. **Resume AFK**
   ```bash
   afk issue update-labels {id} --remove mode::hitl
   /afk-implement {iid}
   ```

**Prevention in next run:** Agent should only read `.env.fork` for credentials, never `.env` or hardcoded values.

### HC-2: Test before implementation (for feature tasks)

Every new feature behavior must have a failing test **before** any
implementation code for that behavior exists. A commit that contains
only implementation with no test code for the same behavior is
non-compliant on a feature task.

**Rule:** Red → Green → Refactor. Never skip Red.

#### Recovery Checklist (HITL)

**Detection:** Issue has `mode::hitl` label + comment mentioning "HC-2 violated"

**Steps:**

1. **Review commit history to find the violation**
   ```bash
   cd .worktrees/issue-{iid}
   git log --oneline --all
   git show <commit-sha> --stat
   ```

2. **Identify which feature code lacks a test**
   - Look for commits with only `src/` changes but no `test/` or `spec/` changes
   - Check if test was added in a later commit (if so, reorder)

3. **If test exists but was committed after implementation:**
   ```bash
   # Reorder commits to put test first
   git rebase -i HEAD~N  # N = number of commits to reorder
   # In editor: move test commit line above implementation commit line
   # Save and close
   ```

4. **If test is completely missing:**
   ```bash
   # Write the failing test first
   # Example: create test/feature.test.ts with test cases
   git add test/
   git commit -m "test: add failing tests for feature X #<iid>"
   
   # Verify test fails
   npm test  # or appropriate test command
   
   # Then re-commit implementation
   git add src/
   git commit -m "feat: implement feature X to pass tests #<iid>"
   ```

5. **Verify TDD cycle**
   ```bash
   # Checkout to just after test commit
   git checkout HEAD~1
   npm test  # Should see failures
   
   # Return to latest
   git checkout afk/issue-{iid}
   npm test  # Should pass
   ```

6. **Resume AFK**
   ```bash
   afk issue update-labels {id} --remove mode::hitl
   /afk-implement {iid}
   ```

**Prevention:** Agent should always write test first, run it (expecting failure), then implement.

### HC-3: Evidence must be observable output, not code

The `Progress:` checklist's evidence column must contain **observable
runtime output** — actual command output, API responses, test results,
log lines, or screen state. It must NOT contain a description of what
code was written.

**Compliant evidence examples:**
- `curl ... returned 200 + {"order_id": "ord-123"}`
- `pnpm test src/foo.test.ts → 3 passing`
- `POST /api/v1/orders → 201; GET /api/v1/orders/ord-123 → 404 (not created)`
- `interface SnapshotRepo { FindByBindingAndDocID(...) }` — only when the
  AC is "define interface X" (code itself is the artifact)

**Evidence that requires file upload:**
If the evidence is a screenshot, log excerpt, or binary artifact, the file
must be uploaded to the tracker to appear in the MR comment. To do this:
1. Write the file path(s) to `.afk/artifacts.txt` (one absolute path per line)
2. The wrapup script will upload them and embed URLs in the MR description
3. Reference the uploaded URL in your Progress evidence, e.g.
   `![screenshot](uploads/xxx.png)` or `log: uploads/test.log`

**Non-compliant evidence (code as artifact):**
- "implemented the handler"
- "added repository methods"
- "test passes" (without showing the actual test output)

**Rule:** If the only evidence of an AC being done is that code was
written, that AC is not done. Run the code and capture its output.

#### Recovery Checklist (HITL)

**Detection:** Issue has `mode::hitl` label + comment mentioning "HC-3 violated"

**Steps:**

1. **Review Progress checklist in latest commit**
   ```bash
   cd .worktrees/issue-{iid}
   git log -1 --pretty=format:"%B"
   ```

2. **Identify AC items with non-compliant evidence**
   - Look for evidence like "implemented X" or "added Y"
   - These should be replaced with actual command output

3. **Run the code and capture real evidence**
   ```bash
   # For API endpoint
   curl -v http://localhost:3000/api/endpoint 2>&1 | tee evidence.log
   
   # For test
   npm test 2>&1 | tee test-output.log
   
   # For CLI command
   ./bin/command --arg value 2>&1 | tee command-output.log
   ```

4. **Update Progress checklist with real evidence**
   ```bash
   # Amend the last commit with corrected evidence
   git commit --amend
   # In editor: replace "implemented X" with actual output
   # Example: curl returned 200 + {"id": 123, "status": "created"}
   ```

5. **If evidence requires screenshots/logs, upload them**
   ```bash
   # Add file paths to artifacts list
   echo "/absolute/path/to/screenshot.png" >> .afk/artifacts.txt
   echo "/absolute/path/to/test-output.log" >> .afk/artifacts.txt
   git add .afk/artifacts.txt
   git commit --amend --no-edit
   ```

6. **Resume AFK**
   ```bash
   afk issue update-labels {id} --remove mode::hitl
   /afk-implement {iid}
   ```

**Prevention:** Agent must always run the code and capture output, not just describe what was implemented.

### HC-4: AC completeness check before Step 8

Before opening the MR (Step 8), every AC line must be checked off in
the Progress checklist with real evidence. `/goal` announcing done is
not evidence.

**Rule:** If any AC line is unchecked or has no observable-output
evidence, do not proceed to Step 8. Add a WIP commit that marks the
missing lines and the `Next:` describes what is needed.

#### Recovery Checklist (HITL)

**Detection:** Issue has `mode::hitl` label + comment mentioning "HC-4 violated"

**Steps:**

1. **Review the Progress checklist**
   ```bash
   cd .worktrees/issue-{iid}
   git log -1 --pretty=format:"%B" | grep -A20 "Progress:"
   ```

2. **Identify unchecked or incomplete AC items**
   - [ ] items = not done yet
   - [x] items without evidence = marked done but no proof

3. **Complete the missing AC items**
   ```bash
   # For each unchecked AC:
   # 1. Implement the feature
   # 2. Run verification command
   # 3. Capture output as evidence
   
   # Example:
   curl -X POST http://localhost:3000/api/orders \
     -d '{"item":"widget","qty":5}' 2>&1 | tee ac-evidence-1.log
   ```

4. **Update Progress checklist**
   ```bash
   git commit --amend
   # In editor: mark [x] and add evidence for each completed AC
   # Progress:
   # - [x] POST /orders creates order -- curl returned 201 + {"id": 456}
   ```

5. **Verify ALL AC items are checked with evidence**
   ```bash
   git log -1 --pretty=format:"%B" | grep "Progress:" -A50 | grep "\[ \]"
   # Should return empty (no unchecked items)
   ```

6. **Resume AFK**
   ```bash
   afk issue update-labels {id} --remove mode::hitl
   /afk-implement {iid}
   ```

**Prevention:** Agent must verify ALL AC items are checked before proceeding to MR creation.

### HC-5: No destructive operations on shared infrastructure

`main-down`, `fork --destroy`, `docker compose down -v`, `git clean
-fdx` on the main repo — none of these are ever permitted in an AFK
run. Only operations scoped to the issue's worktree or its DB fork are
allowed.

**Rule:** Any destructive command must be confirmed to target only
`.worktrees/issue-<iid>` or the issue's named fork, not the shared
development environment.

#### Recovery Checklist (HITL)

**Detection:** Issue has `mode::hitl` label + comment mentioning "HC-5 violated"

**Steps:**

1. **Assess damage**
   ```bash
   # Check if shared DB was affected
   psql -d main_dev -c "SELECT count(*) FROM users;"
   
   # Check if main repo was cleaned
   git -C ~/project status
   ```

2. **Restore from backup if needed**
   ```bash
   # Restore DB from latest backup
   ./scripts/db-restore.sh main_dev
   
   # Restore Docker volumes
   docker volume ls | grep main
   ```

3. **Review what command was run**
   - Check tmux history or agent logs
   - Identify the destructive command

4. **Ensure worktree isolation going forward**
   ```bash
   # All commands should be scoped to worktree
   git -C .worktrees/issue-{iid} clean -fdx  # OK
   git clean -fdx  # NOT OK (operates on main repo)
   ```

5. **Resume AFK with caution**
   ```bash
   afk issue update-labels {id} --remove mode::hitl
   # Manual review: ensure agent understands worktree scope
   /afk-implement {iid}
   ```

**Prevention:** All destructive commands must include explicit path to `.worktrees/issue-<iid>`.

### HC-6: No force-push to the issue branch

Force-pushing the issue branch rewrites history and destroys the
checkpoint trail that `Next:` lines depend on.

**Rule:** `git push --force` on `afk/issue-<iid>` is prohibited.
Use regular push only.

#### Recovery Checklist (HITL)

**Detection:** Issue has `mode::hitl` label + comment mentioning "HC-6 violated"

**Steps:**

1. **Check if force-push already happened**
   ```bash
   # Check reflog on remote (if accessible)
   git ls-remote origin afk/issue-{iid}
   
   # Check local reflog
   cd .worktrees/issue-{iid}
   git reflog
   ```

2. **If force-push already executed, history is lost**
   - Cannot recover rewritten commits
   - Check if anyone else had checked out the branch (unlikely in AFK flow)

3. **If force-push was attempted but failed**
   ```bash
   # Verify current state
   git log --oneline origin/afk/issue-{iid}
   git log --oneline HEAD
   
   # Regular push should work
   git push origin afk/issue-{iid}
   ```

4. **If there are conflicts preventing regular push**
   ```bash
   # Fetch and rebase (safer than force-push)
   git fetch origin afk/issue-{iid}
   git rebase origin/afk/issue-{iid}
   git push origin afk/issue-{iid}
   ```

5. **Resume AFK**
   ```bash
   afk issue update-labels {id} --remove mode::hitl
   /afk-implement {iid}
   ```

**Prevention:** Agent must never use `git push --force` or `--force-with-lease` on issue branches.

### HC-7: Retry count is not in worktree git config

Storing retry count in the worktree's `.git/config` means it is lost
if the worktree is removed or recreated. The retry count must survive
worktree deletion.

**Rule:** Retry state is stored in the tracker issue label or comment,
not in any worktree-local file.

#### Recovery Checklist (HITL)

**Detection:** Issue has `mode::hitl` label + comment mentioning "HC-7 violated"

**Steps:**

1. **Check current retry count storage**
   ```bash
   # Check if stored in worktree config (WRONG)
   cd .worktrees/issue-{iid}
   git config --local afk.retry-count
   
   # Check if stored in tracker labels (CORRECT)
   afk issue get {id} --json | jq -r '.labels[] | select(test("^retry-count::"))'
   ```

2. **Migrate retry count to tracker label**
   ```bash
   # Read from worktree config
   local_count=$(git config --local afk.retry-count)
   
   # Write to tracker label
   afk issue update-labels {id} --add "retry-count::${local_count}"
   
   # Remove from worktree config
   git config --local --unset afk.retry-count
   ```

3. **Verify persistence**
   ```bash
   # Remove worktree
   cd ~/project
   git worktree remove .worktrees/issue-{iid}
   
   # Recreate worktree
   git worktree add .worktrees/issue-{iid} afk/issue-{iid}
   
   # Retry count should still be in the tracker
   afk issue get {id} --json | jq -r '.labels[] | select(test("^retry-count::"))'
   ```

4. **Resume AFK**
   ```bash
   afk issue update-labels {id} --remove mode::hitl
   /afk-implement {iid}
   ```

**Prevention:** All retry state management must use the tracker API (labels or comments), never worktree-local storage.

---

## Escalation Protocol

When a hard check is violated:

1. Do not continue the run.
2. Post a tracker comment describing which HC was violated.
3. Relabel the issue `mode::hitl`.
4. Detach from tmux and stop the session.

The human owns the recovery decision.
