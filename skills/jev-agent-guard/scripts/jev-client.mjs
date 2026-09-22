# Host integration

The shared guard is intentionally host-agnostic. Each adapter converts the host's
pre-tool event into the same compact decision contract:

- `decision`: `allow` | `confirm` | `deny` | `redirect`
- `action`: `continue` | `request_user_approval` | `block`
- `dimension`: `local-policy` | `credentials` | `safety` | `jev-review` | `jev-risk`
- `reason`: short human-readable explanation
- `host`: `claude-code` | `codex` | `opencode`
- `tool`: tool name or wrapper name
- `command`: raw command or relevant input payload

## Claude Code

The hook sits in `.claude/settings.json` under `hooks.PreToolUse` and calls:

```json
{
  "type": "command",
  "command": "node skills/jev-agent-guard/scripts/adapters/claude-code.mjs pre-tool"
}
```

## Codex

The hook sits in `.codex/config.toml` and runs before a tool call:

```toml
[hooks]
pre_tool = "node skills/jev-agent-guard/scripts/adapters/codex.mjs pre-tool"
```

## OpenCode

OpenCode can call the wrapper directly or with a plugin entry.

```json
{
  "plugins": [
    {
      "name": "jev-agent-guard",
      "command": "node skills/jev-agent-guard/scripts/adapters/opencode.mjs"
    }
  ]
}
```

The local guard always runs before any Jev call. Jev only decides when the
action is ambiguous, high-value, or otherwise outside the safe allowlist.
