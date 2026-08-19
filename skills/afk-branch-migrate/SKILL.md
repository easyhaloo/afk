---
name: afk-branch-migrate
disable-model-invocation: true
description: Safely migrate selected code changes between divergent branches by analyzing intent, dependencies, compatibility, risks, and verification requirements before applying changes.
---

# Branch Migration

> **Migration:** Understand the intended change first, compare it with the target branch, identify the smallest set of changes and dependencies required, assess compatibility and conflict risks, and present a safe migration plan before modifying the target branch. After confirmation, apply the migration, verify the result, and preserve a practical rollback path.

## Analyze

Inspect the source commit or change range and the target branch before making changes. Determine what the change is intended to accomplish, which changes are essential, which are incidental, and which dependencies must move with it. Compare the relevant implementation, APIs, configuration, tests, and surrounding code on the target branch.

Assess risks based on actual divergence rather than file count. Consider semantic conflicts, changed interfaces, missing dependencies, renamed or removed code, incompatible configuration, and behavior differences. Distinguish changes that can be safely applied from those requiring manual resolution.

## Plan

Produce a concise migration plan describing:

- intended change and required scope
- changes and dependencies to migrate
- conflicts or compatibility risks
- files or behavior that should remain untouched
- verification required after migration
- rollback approach

Treat the **change** as the migration unit, not individual files. Do not migrate incidental changes unless they are required for correctness.

**Do not modify the target branch until the user confirms the plan.**

## Apply

After confirmation, use the safest Git operation that preserves the intended change and minimizes unrelated modifications. Resolve high-risk or semantic conflicts deliberately; never silently discard target-branch behavior.

Create a recoverable checkpoint before applying changes. Do not use destructive operations such as `git reset --hard`, force-push, or branch deletion.

## Verify

Verify the migrated behavior using the smallest sufficient validation set based on the affected code. Inspect the final diff, compile or build when applicable, and run relevant tests or checks. Do not declare migration complete until the result is verified or the remaining verification gap is explicitly reported.

Report the migration result as **successful, partial, or failed**, including unresolved conflicts, verification results, and the available rollback path when relevant.

> **Principles:** Understand before applying. Migrate intent, not files. Minimize unrelated changes. Never silently overwrite target behavior. Verify before declaring success.
