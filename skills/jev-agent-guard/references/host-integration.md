# Host integration

Run the one-step installer from the repository root:

```bash
export TYPESAFE_API_KEY="your-key"
node skills/jev-agent-guard/scripts/install.mjs
```

Preview without changing files:

```bash
node skills/jev-agent-guard/scripts/install.mjs --dry-run
```

Install one host only:

```bash
node skills/jev-agent-guard/scripts/install.mjs --host=claude-code
node skills/jev-agent-guard/scripts/install.mjs --host=codex
node skills/jev-agent-guard/scripts/install.mjs --host=opencode
```

The installer installs `@typesafe-ai/sdk` in the Skill directory and injects
only its own entries. It preserves existing host configuration and is
idempotent.

## Runtime bridge

All adapters accept normalized-or-native JSON on stdin and return the same
JSON decision contract. They do not contain policy rules; they only normalize
input, select the semantic rule for the event, and map the result for the host.

Event mapping:

- `before-action` → `action-risk`
- `after-action` → `trajectory-state`
- `context-review` → `context-retention`
- `stop` → `skill-compliance`

Decision mapping:

- `allow` / `keep` / `finish` → exit 0
- `warn` → continue with advisory output
- `confirm` / `deny` / `redirect` / `drop` → exit 2
- Jev unavailable during a pre-action or stop check → fail closed to `confirm`

Claude Code receives PreToolUse, PostToolUse, and Stop entries. Codex receives
an adapter manifest at `.codex/jev-agent-guard.json`; connect its commands to
the hook or wrapper API provided by the installed Codex version. OpenCode
receives a plugin entry and exports `createJevAgentGuardPlugin()` for plugin
loaders that support factory exports.

Host protocols vary by version. The adapter boundary is stable, but the final
native response mapping must be verified against the host version in use.
