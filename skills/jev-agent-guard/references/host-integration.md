# Jev Agent Guard host integration

The rule set is host-neutral and lives in `rules/semantic.json`.

Each host adapter must only:

1. Parse its native event.
2. Produce compact normalized runtime state.
3. Select an event kind: `before-action`, `after-action`, `context-review`, or `stop`.
4. Call `semantic-engine.mjs` or import `evaluateSemantic`.
5. Map the returned decision into the host's native response.

Adapters must not contain semantic policy rules or duplicate Jev questions.

## Normalized state example

```json
{
  "event_kind": "before-action",
  "goal": "Fix the login timeout",
  "requirements": ["preserve generated files", "run focused validation"],
  "action": {
    "kind": "execute",
    "tool": "shell",
    "command": "npm test -- session",
    "path": null
  },
  "trajectory": {
    "same_failure_count": 2,
    "same_command_count": 3,
    "recent_progress": false
  },
  "context": {
    "usage_ratio": 0.72,
    "candidate": null
  },
  "validation": {
    "required": true,
    "last_passed": false
  }
}
```

## Host mapping

The adapters should map semantic results as follows:

- `allow` / `keep` → continue
- `warn` → continue with a short advisory message
- `confirm` → host approval flow
- `deny` / `block` → block the action
- `redirect` → stop the current path and inject the returned next action
- `compact` → request or provide compacted context
- `finish` → allow stop only when local validation checks also pass

Host-specific protocol details belong in the adapter, never in the semantic rule file.
